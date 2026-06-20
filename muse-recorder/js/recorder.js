// recorder.js
// Orchestrates a recording: wires the Muse client to crash-safe storage, manages
// the marker stream (labels / assessments / baseline / events), holds a screen
// wake lock, handles BLE disconnect (auto-stop + flag + one reconnect attempt),
// and exports a finished session to a valid .xdf blob.

import { XdfWriter } from './xdf-writer.js';
import { SessionStore, StreamCheckpointer } from './storage.js';
import { buildStreamDefs, STREAM } from './streams.js';
import { now } from './clock.js';

function pad(n) { return String(n).padStart(2, '0'); }

function timestampName(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function makeFilename(subjectId, sessionType, d = new Date()) {
  const sid = (subjectId || 'subject').replace(/[^A-Za-z0-9_-]/g, '');
  return `${sid}_${sessionType}_${timestampName(d)}.xdf`;
}

export class Recorder extends EventTarget {
  constructor(client, store) {
    super();
    this.client = client;
    this.store = store;
    this.session = null;
    this.defs = null;
    this.checkpointer = null;
    this.recording = false;
    this.paused = false;
    this.wakeLock = null;
    this._reconnectTried = false;
    this._onSamples = (e) => this._handleSamples(e.detail);
    this._onMarker = (e) => this.addMarker(e.detail.value, e.detail.t);
    this._onDisconnect = () => this._handleDisconnect();
  }

  static async create(client) {
    const store = await SessionStore.open();
    return new Recorder(client, store);
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  // ---- lifecycle ----------------------------------------------------------
  async start(meta, { includeAux = false } = {}) {
    const id = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const created = new Date();
    this.defs = buildStreamDefs({
      includeAux,
      deviceType: meta.deviceType || this.client.deviceInfo.deviceType,
      serial: meta.serial || this.client.deviceInfo.serial,
      firmware: meta.firmware || this.client.deviceInfo.firmware,
    });
    const filename = makeFilename(meta.subjectId, meta.sessionType || 'record', created);
    this.session = {
      id,
      createdAt: created.getTime(),
      datetime: created.toISOString(),
      filename,
      status: 'recording',
      flagged: false,
      meta,
      includeAux,
      streamDefKeys: Object.keys(this.defs),
      counts: {},
      dropped: {},
      chunkCounts: {},
      markerCount: 0,
    };
    await this.store.createSession(this.session);

    this.checkpointer = new StreamCheckpointer(this.store, id, { checkpointMs: 2000, maxBuffer: 1024 });
    this.checkpointer.start();

    this.client.addEventListener('samples', this._onSamples);
    this.client.addEventListener('marker', this._onMarker);
    this.client.addEventListener('disconnected', this._onDisconnect);

    this._reconnectTried = false;
    this.recording = true;
    this.paused = false;
    await this._acquireWakeLock();

    // record session start as a marker
    this.addMarker('session/start');
    this.emit('started', { session: this.session });
    return this.session;
  }

  _handleSamples({ stream, samples }) {
    if (!this.recording || this.paused) return;
    this.checkpointer.add(stream, samples);
  }

  // Markers are written into the irregular string MARKERS stream.
  addMarker(value, t = now()) {
    if (!this.recording) return;
    this.checkpointer.add(STREAM.MARKERS, [{ t, value }]);
    this.session.markerCount++;
    this.emit('marker-added', { t, value });
  }

  // Convenience marker helpers ------------------------------------------------
  labelStart(label) { this.addMarker(`label/${label}/start`); }
  labelStop(label) { this.addMarker(`label/${label}/stop`); }
  assessment(phase, value) { this.addMarker(`assessment/${phase}/${value}`); } // phase: start|mid|end
  event(name) { this.addMarker(`event/${name}`); }

  // Optional 60 s baseline (30 s eyes-open + 30 s eyes-closed). Returns a handle
  // the UI can await / cancel; markers bound each block.
  async runBaseline({ onPhase } = {}) {
    const block = async (name, secs) => {
      this.addMarker(`baseline/${name}/start`);
      onPhase && onPhase(name, secs);
      await new Promise((r) => setTimeout(r, secs * 1000));
      this.addMarker(`baseline/${name}/stop`);
    };
    this.addMarker('baseline/start');
    await block('eyes_open', 30);
    await block('eyes_closed', 30);
    this.addMarker('baseline/stop');
    onPhase && onPhase('done', 0);
  }

  pause() {
    if (!this.recording) return;
    this.paused = true;
    this.addMarker('recording/pause');
    this.emit('paused', {});
  }

  resume() {
    if (!this.recording) return;
    this.paused = false;
    this.addMarker('recording/resume');
    this.emit('resumed', {});
  }

  async stop({ flagged = false } = {}) {
    if (!this.recording) return null;
    this.addMarker('session/stop');
    this.recording = false;
    this._detach();
    await this.checkpointer.stop();
    await this._releaseWakeLock();

    this.session.status = 'stopped';
    this.session.flagged = this.session.flagged || flagged;
    this.session.counts = { ...this.checkpointer.counts };
    this.session.chunkCounts = { ...this.checkpointer.seq };
    this.session.dropped = { ...this.client.dropped };
    this.session.endedAt = Date.now();
    await this.store.updateSession(this.session.id, this.session);

    // Build the .xdf file from durable chunks.
    const blob = await this.export(this.session.id);
    await this.store.saveFile(this.session.id, this.session.filename, blob);
    this.session.exported = true;
    await this.store.updateSession(this.session.id, this.session);
    this.emit('stopped', { session: this.session, blob });
    return this.session;
  }

  async discard() {
    const id = this.session && this.session.id;
    this.recording = false;
    this._detach();
    if (this.checkpointer) await this.checkpointer.stop();
    await this._releaseWakeLock();
    if (id) await this.store.deleteSession(id);
    this.emit('discarded', { id });
    this.session = null;
  }

  _detach() {
    this.client.removeEventListener('samples', this._onSamples);
    this.client.removeEventListener('marker', this._onMarker);
    this.client.removeEventListener('disconnected', this._onDisconnect);
  }

  // ---- disconnect handling ------------------------------------------------
  async _handleDisconnect() {
    if (!this.recording) return;
    this.session.flagged = true;
    this.emit('disconnect-detected', { session: this.session });
    await this.stop({ flagged: true });
    if (!this._reconnectTried) {
      this._reconnectTried = true;
      this.emit('reconnecting', {});
      try {
        await this.client.connect({ includeAux: this.session ? this.session.includeAux : false });
        this.emit('reconnected', {});
      } catch (err) {
        this.emit('reconnect-failed', { error: err.message });
      }
    }
  }

  // ---- wake lock ----------------------------------------------------------
  async _acquireWakeLock() {
    try {
      if ('wakeLock' in navigator) {
        this.wakeLock = await navigator.wakeLock.request('screen');
        document.addEventListener('visibilitychange', this._visHandler = async () => {
          if (this.recording && document.visibilityState === 'visible' && !this.wakeLock) {
            try { this.wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {}
          }
          if (document.visibilityState === 'hidden') {
            this.emit('backgrounded', {});
          }
        });
      } else {
        this.emit('wakelock-unavailable', {});
      }
    } catch (_) {
      this.emit('wakelock-unavailable', {});
    }
  }

  async _releaseWakeLock() {
    if (this._visHandler) document.removeEventListener('visibilitychange', this._visHandler);
    if (this.wakeLock) { try { await this.wakeLock.release(); } catch (_) {} this.wakeLock = null; }
  }

  // ---- export -------------------------------------------------------------
  // Rebuild a valid .xdf from durable chunks. Streams are interleaved roughly by
  // checkpoint window (round-robin over chunk seq) so the file matches the order
  // in which data was captured, while reading one chunk at a time keeps memory
  // bounded.
  async export(sessionId) {
    const session = await this.store.getSession(sessionId);
    const defs = buildStreamDefs({
      includeAux: session.includeAux,
      deviceType: session.meta.deviceType || 'Muse',
      serial: session.meta.serial || 'unknown',
      firmware: session.meta.firmware || 'unknown',
    });
    const orderedDefs = [
      defs[STREAM.EEG], defs[STREAM.PPG], defs[STREAM.ACC],
      defs[STREAM.GYRO], defs[STREAM.MARKERS], defs[STREAM.TELEMETRY],
    ];

    const w = new XdfWriter();
    w.writeFileHeader({
      subjectId: session.meta.subjectId,
      sessionType: session.meta.sessionType,
      deviceType: session.meta.deviceType,
      serial: session.meta.serial,
      firmware: session.meta.firmware,
      fitNotes: session.meta.fitNotes,
      posture: session.meta.posture,
      note: session.meta.note,
      sleepHours: session.meta.sleepHours,
      caffeine: session.meta.caffeine,
      datetime: session.datetime,
    });
    for (const d of orderedDefs) w.writeStreamHeader(d);
    for (const d of orderedDefs) w.writeClockOffset(d, now(), 0);

    // Track footer stats per stream while we stream chunks out.
    const stats = {};
    for (const d of orderedDefs) stats[d.key] = { first: null, last: null, count: 0 };

    const chunkCounts = session.chunkCounts || {};
    const maxSeq = Math.max(0, ...orderedDefs.map((d) => chunkCounts[d.key] || 0));
    for (let seq = 0; seq < maxSeq; seq++) {
      for (const d of orderedDefs) {
        if (seq >= (chunkCounts[d.key] || 0)) continue;
        const samples = await this.store.getChunk(sessionId, d.key, seq);
        if (!samples || !samples.length) continue;
        w.writeSamples(d, samples);
        const st = stats[d.key];
        if (st.first === null) st.first = samples[0].t;
        st.last = samples[samples.length - 1].t;
        st.count += samples.length;
      }
    }

    for (const d of orderedDefs) w.writeStreamFooter(d, stats[d.key]);
    return w.toBlob();
  }

  async exportExisting(sessionId) {
    const f = await this.store.getFile(sessionId);
    if (f) return f.blob;
    return this.export(sessionId);
  }
}

export { makeFilename };
