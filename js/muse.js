// muse.js
// Web Bluetooth layer for Muse 2 / Muse S. The BLE protocol & decoders follow
// the well-documented muse-js (urish/muse-js) and web-muse (itayinbarr/web-muse)
// implementations; the injectMarker / event-stream pattern is modelled on
// muse-js. Re-implemented here as a dependency-free ES module so it can be
// vendored into a no-build PWA.
//
// Muse sends each EEG channel and each PPG channel on its OWN GATT
// characteristic, each packet carrying a 16-bit sequence index plus N samples.
// We align packets across characteristics by sequence index to build the
// multi-channel rows that XDF needs, and we track per-characteristic sequence
// gaps to count dropped/missing samples.

import { CHAR, MUSE_SERVICE, STREAM } from './streams.js';
import { now, packetTimestamps } from './clock.js';

const EEG_SCALE = 0.48828125;       // (raw-2048) -> microvolts
const EEG_ZERO = 0x800;             // 2048
const ACC_SCALE = 0.0000610352;     // raw -> g
const GYRO_SCALE = 0.0074768;       // raw -> deg/s
const SEQ_MOD = 0x10000;

// ---- low-level bit decoders (from muse-js) ------------------------------
function decode12bit(dv, byteStart, count) {
  // count 12-bit unsigned samples packed big-endian, starting at byteStart.
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const bitOffset = i * 12;
    const byteOffset = byteStart + (bitOffset >> 3);
    if (i % 2 === 0) {
      out[i] = (dv.getUint8(byteOffset) << 4) | (dv.getUint8(byteOffset + 1) >> 4);
    } else {
      out[i] = ((dv.getUint8(byteOffset) & 0x0f) << 8) | dv.getUint8(byteOffset + 1);
    }
  }
  return out;
}

function decode24bit(dv, byteStart, count) {
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    const o = byteStart + i * 3;
    out[i] = (dv.getUint8(o) << 16) | (dv.getUint8(o + 1) << 8) | dv.getUint8(o + 2);
  }
  return out;
}

function encodeCommand(cmd) {
  // Muse command framing: [len][chars...]['\n'] where len = chars + newline.
  const body = `${cmd}\n`;
  const enc = new TextEncoder().encode(body);
  const out = new Uint8Array(enc.length + 1);
  out[0] = enc.length;
  out.set(enc, 1);
  return out;
}

// Aligns per-channel packets (same sequence index across characteristics) into
// multi-channel sample rows.
class ChannelAligner {
  constructor(nChannels, samplesPerPacket, srate, onRows, onDropped) {
    this.nch = nChannels;
    this.spp = samplesPerPacket;
    this.srate = srate;
    this.onRows = onRows;       // (rows:[{t,values}]) => void
    this.onDropped = onDropped; // (missingSamples:number) => void
    this.pending = new Map();   // index -> { ch:Array(nch) of Array(spp), arrival, filled }
    this.lastSeq = new Array(nChannels).fill(null);
  }

  add(chIdx, seq, samples, arrival) {
    // sequence-gap accounting per characteristic
    const prev = this.lastSeq[chIdx];
    if (prev !== null) {
      const gap = (seq - prev + SEQ_MOD) % SEQ_MOD;
      if (gap > 1) this.onDropped((gap - 1) * this.spp);
    }
    this.lastSeq[chIdx] = seq;

    let row = this.pending.get(seq);
    if (!row) {
      row = { ch: new Array(this.nch).fill(null), arrival, filled: 0 };
      this.pending.set(seq, row);
    }
    if (row.ch[chIdx] === null) row.filled++;
    row.ch[chIdx] = samples;
    row.arrival = arrival; // latest arrival for this index

    if (row.filled === this.nch) {
      this._flush(seq, row);
      this.pending.delete(seq);
    }
    // Flush stale rows (older indices that never completed) to bound memory and
    // count their missing channels.
    if (this.pending.size > 8) this._flushStale(seq);
  }

  _flushStale(currentSeq) {
    for (const [seq, row] of this.pending) {
      const age = (currentSeq - seq + SEQ_MOD) % SEQ_MOD;
      if (age > 4) {
        this._flush(seq, row, true);
        this.pending.delete(seq);
      }
    }
  }

  _flush(seq, row, partial = false) {
    const ts = packetTimestamps(row.arrival, this.spp, this.srate);
    const rows = [];
    for (let s = 0; s < this.spp; s++) {
      const values = new Array(this.nch);
      for (let c = 0; c < this.nch; c++) {
        values[c] = row.ch[c] ? row.ch[c][s] : NaN;
      }
      rows.push({ t: ts[s], values });
    }
    if (partial) {
      // count NaN-filled channels as missing samples
      const missingCh = row.ch.filter((x) => x === null).length;
      if (missingCh) this.onDropped(missingCh * this.spp);
    }
    this.onRows(rows);
  }
}

export class MuseClient extends EventTarget {
  constructor() {
    super();
    this.device = null;
    this.gatt = null;
    this.service = null;
    this.controlChar = null;
    this.chars = {};
    this.connected = false;
    this.includeAux = false;
    this.deviceInfo = { serial: 'unknown', firmware: 'unknown', deviceType: 'Muse' };
    this._controlBuffer = '';
    this.dropped = { EEG: 0, PPG: 0, ACC: 0, GYRO: 0, TELEMETRY: 0 };
    this._fitWindows = {}; // electrode -> recent abs values for quality heuristic
    this._aligners = {};
    this._boundDisconnect = () => this._onDisconnect();
  }

  static isSupported() {
    return typeof navigator !== 'undefined' && !!navigator.bluetooth;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  // preset '50' = EEG + IMU + PPG (Muse 2 / Muse S). '21' = EEG + IMU only (no
  // PPG). Default to '50' so PPG streams; pass preset:'21' to disable PPG.
  async connect({ includeAux = false, preset = '50' } = {}) {
    this.includeAux = includeAux;
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [MUSE_SERVICE] }],
      optionalServices: [MUSE_SERVICE],
    });
    this.device.addEventListener('gattserverdisconnected', this._boundDisconnect);
    this.gatt = await this.device.gatt.connect();
    this.service = await this.gatt.getPrimaryService(MUSE_SERVICE);

    this.controlChar = await this.service.getCharacteristic(CHAR.CONTROL);
    await this.controlChar.startNotifications();
    this.controlChar.addEventListener('characteristicvaluechanged', (e) =>
      this._onControl(e.target.value)
    );

    this._setupAligners();
    await this._subscribeData();

    // pause, set preset, query info, then resume streaming
    await this._write('h');
    await this._write(`p${preset}`);
    await this._write('s');
    await this._write('v1');
    await new Promise((r) => setTimeout(r, 250));
    await this._write('d');

    this.connected = true;
    this.emit('connected', { device: this.device.name || 'Muse' });
    this.emit('info', this.deviceInfo);
    return this.deviceInfo;
  }

  async disconnect() {
    try {
      await this._write('h');
    } catch (_) {}
    if (this.gatt && this.gatt.connected) this.gatt.disconnect();
  }

  _onDisconnect() {
    this.connected = false;
    this.emit('disconnected', {});
  }

  async _write(cmd) {
    if (!this.controlChar) return;
    await this.controlChar.writeValue(encodeCommand(cmd));
  }

  // injectMarker pattern (from muse-js): lets the app push an event into the
  // same time base. The recorder timestamps with the shared clock, so we simply
  // surface a marker event carrying the monotonic time.
  injectMarker(value, t = now()) {
    this.emit('marker', { t, value });
  }

  _setupAligners() {
    const eegCh = this.includeAux ? 5 : 4;
    this._aligners.EEG = new ChannelAligner(
      eegCh,
      12,
      256,
      (rows) => this.emit('samples', { stream: STREAM.EEG, samples: rows, dropped: this.dropped.EEG }),
      (n) => (this.dropped.EEG += n)
    );
    this._aligners.PPG = new ChannelAligner(
      3,
      6,
      64,
      (rows) => this.emit('samples', { stream: STREAM.PPG, samples: rows, dropped: this.dropped.PPG }),
      (n) => (this.dropped.PPG += n)
    );
  }

  async _subscribeData() {
    const eegMap = [
      [CHAR.EEG_TP9, 0, 'TP9'],
      [CHAR.EEG_AF7, 1, 'AF7'],
      [CHAR.EEG_AF8, 2, 'AF8'],
      [CHAR.EEG_TP10, 3, 'TP10'],
    ];
    if (this.includeAux) eegMap.push([CHAR.EEG_AUX, 4, 'AUX']);
    for (const [uuid, idx, label] of eegMap) {
      await this._subscribe(uuid, (dv, arrival) => this._onEeg(dv, idx, label, arrival));
    }

    const ppgMap = [
      [CHAR.PPG1, 0],
      [CHAR.PPG2, 1],
      [CHAR.PPG3, 2],
    ];
    for (const [uuid, idx] of ppgMap) {
      await this._subscribe(uuid, (dv, arrival) => this._onPpg(dv, idx, arrival));
    }

    await this._subscribe(CHAR.ACCEL, (dv, arrival) => this._onImu(dv, STREAM.ACC, ACC_SCALE, 'ACC', arrival));
    await this._subscribe(CHAR.GYRO, (dv, arrival) => this._onImu(dv, STREAM.GYRO, GYRO_SCALE, 'GYRO', arrival));
    await this._subscribe(CHAR.TELEMETRY, (dv, arrival) => this._onTelemetry(dv, arrival));
  }

  async _subscribe(uuid, handler) {
    try {
      const ch = await this.service.getCharacteristic(uuid);
      await ch.startNotifications();
      ch.addEventListener('characteristicvaluechanged', (e) => handler(e.target.value, now()));
      this.chars[uuid] = ch;
    } catch (err) {
      // Some characteristics are absent depending on model/preset; ignore.
      console.warn('subscribe failed for', uuid, err.message);
    }
  }

  _onEeg(dv, chIdx, label, arrival) {
    const seq = dv.getUint16(0);
    const raw = decode12bit(dv, 2, 12);
    const samples = raw.map((r) => (r - EEG_ZERO) * EEG_SCALE);
    this._aligners.EEG.add(chIdx, seq, samples, arrival);
    this._updateFit(label, samples);
  }

  _onPpg(dv, chIdx, arrival) {
    const seq = dv.getUint16(0);
    const samples = decode24bit(dv, 2, 6);
    this._aligners.PPG.add(chIdx, seq, samples, arrival);
  }

  _onImu(dv, stream, scale, key, arrival) {
    const seq = dv.getUint16(0);
    // 3 samples x 3 axes, int16 big-endian
    const rows = [];
    const ts = packetTimestamps(arrival, 3, 52);
    for (let s = 0; s < 3; s++) {
      const base = 2 + s * 6;
      const values = [
        dv.getInt16(base) * scale,
        dv.getInt16(base + 2) * scale,
        dv.getInt16(base + 4) * scale,
      ];
      rows.push({ t: ts[s], values });
    }
    // sequence-gap accounting
    const last = this[`_lastSeq_${key}`];
    if (last != null) {
      const gap = (seq - last + SEQ_MOD) % SEQ_MOD;
      if (gap > 1) this.dropped[stream] += (gap - 1) * 3;
    }
    this[`_lastSeq_${key}`] = seq;
    this.emit('samples', { stream, samples: rows, dropped: this.dropped[stream] });
  }

  _onTelemetry(dv, arrival) {
    const battery = dv.getUint16(2) / 512;
    const fuelmV = dv.getUint16(4) * 2.2;
    const adc = dv.getUint16(6);
    const temperature = dv.getUint16(8);
    const sample = { t: arrival, values: [battery, fuelmV, adc, temperature] };
    this.emit('samples', { stream: STREAM.TELEMETRY, samples: [sample], dropped: 0 });
    this.emit('telemetry', { battery, fuelmV, adc, temperature });
  }

  // Control responses to 's' (status) and 'v1' (version) arrive as ASCII JSON
  // split across many 20-byte notifications (first byte = payload length). We
  // accumulate, then extract every complete brace-balanced {...} object and merge
  // the fields we care about. Status gives sn/hn/bp; version gives fw/hw/bl.
  _onControl(dv) {
    let str = '';
    const len = Math.min(dv.getUint8(0) + 1, dv.byteLength);
    for (let i = 1; i < len; i++) str += String.fromCharCode(dv.getUint8(i));
    this._controlBuffer += str;

    let depth = 0;
    let start = -1;
    let consumedTo = 0;
    for (let i = 0; i < this._controlBuffer.length; i++) {
      const ch = this._controlBuffer[i];
      if (ch === '{') {
        if (depth === 0) start = i;
        depth++;
      } else if (ch === '}') {
        depth--;
        if (depth === 0 && start >= 0) {
          const json = this._controlBuffer.slice(start, i + 1);
          consumedTo = i + 1;
          try {
            const obj = JSON.parse(json);
            if (obj.fw) this.deviceInfo.firmware = String(obj.fw);
            if (obj.bl) this.deviceInfo.bootloader = String(obj.bl);
            if (obj.hw) this.deviceInfo.hardware = String(obj.hw);
            if (obj.sn) this.deviceInfo.serial = String(obj.sn);
            if (obj.hn) this.deviceInfo.deviceType = String(obj.hn);
            if (obj.bp != null) this.emit('telemetry', { battery: Number(obj.bp) });
            this.emit('info', this.deviceInfo);
          } catch (_) {
            /* malformed object, skip */
          }
        }
      }
    }
    // drop everything we've parsed; keep any trailing partial object
    if (consumedTo > 0) this._controlBuffer = this._controlBuffer.slice(consumedTo);
    // guard against unbounded growth from non-JSON chatter
    if (this._controlBuffer.length > 4096) this._controlBuffer = this._controlBuffer.slice(-1024);
  }

  // --- fit / signal-quality heuristic --------------------------------------
  // NOTE: this is a local heuristic, not Muse's proprietary horseshoe (HSI).
  // We flag a channel "good" when its recent signal is neither flat/railing nor
  // wildly out of EEG range. Reported per channel as 'good' | 'ok' | 'bad'.
  _updateFit(label, samples) {
    let buf = this._fitWindows[label];
    if (!buf) buf = this._fitWindows[label] = [];
    for (const v of samples) buf.push(v);
    while (buf.length > 256) buf.shift();
    if (buf.length < 64) return;
    const mean = buf.reduce((a, b) => a + b, 0) / buf.length;
    let varr = 0;
    for (const v of buf) varr += (v - mean) ** 2;
    const std = Math.sqrt(varr / buf.length);
    const railing = buf.some((v) => Math.abs(v) > 1500); // saturated
    let q = 'good';
    if (railing || std > 600) q = 'bad';
    else if (std < 1 || std > 200) q = 'ok';
    this.emit('fit', { label, std: Math.round(std), quality: q });
  }
}
// end of muse.js
