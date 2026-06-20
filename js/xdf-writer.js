// xdf-writer.js
// Self-contained XDF (Extensible Data Format) writer. Pure ES module that uses
// only ArrayBuffer / DataView / TextEncoder, so the exact same file runs both in
// the browser (recording) and in Node (the pyxdf validation harness).
//
// XDF binary layout implemented here (see https://github.com/sccn/xdf):
//   [4-byte magic "XDF:"]
//   then a sequence of chunks, each:
//     [1 byte NumLengthBytes (1|4|8)] [Length] [2-byte Tag (LE)] [Content]
//   where Length = number of bytes of (Tag + Content).
//
// Chunk tags:
//   1 FileHeader   : XML
//   2 StreamHeader : uint32 streamId + XML
//   3 Samples      : uint32 streamId + varlen numSamples + Sample[]
//   4 ClockOffset  : uint32 streamId + double collectionTime + double offset
//   5 Boundary     : 16-byte magic (optional, aids recovery)
//   6 StreamFooter : uint32 streamId + XML
//
// Each Sample: [uint8 tsBytes] [if tsBytes==8: double timestamp] [channel values]
// For float32 streams: channelCount * float32 (LE).
// For string streams : varlen strLen + UTF-8 bytes  (one channel).
//
// We always write an explicit 8-byte timestamp per sample (tsBytes=8) so that
// loaded timestamps are exact and never rely on rate-based deduction.

const TEXT = new TextEncoder();

const BOUNDARY_MAGIC = new Uint8Array([
  0x43, 0xa5, 0x46, 0xdc, 0xcb, 0xf5, 0x41, 0x0f,
  0xb3, 0x0e, 0xd5, 0x46, 0x73, 0x83, 0xcb, 0xe4,
]);

class ByteBuilder {
  constructor() {
    this.parts = [];
    this.length = 0;
  }
  _push(u8) {
    this.parts.push(u8);
    this.length += u8.length;
  }
  u8(v) { this._push(new Uint8Array([v & 0xff])); return this; }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v, true); this._push(b); return this; }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this._push(b); return this; }
  u64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); this._push(b); return this; }
  f32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); this._push(b); return this; }
  f64(v) { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v, true); this._push(b); return this; }
  raw(u8) { this._push(u8); return this; }
  str(s) { this._push(TEXT.encode(s)); return this; }
  // XDF variable-length integer: tag byte (1|4|8) then the value little-endian.
  varlen(n) {
    if (n <= 0xff) { this.u8(1); this.u8(n); }
    else if (n <= 0xffffffff) { this.u8(4); this.u32(n); }
    else { this.u8(8); this.u64(n); }
    return this;
  }
  build() {
    const out = new Uint8Array(this.length);
    let off = 0;
    for (const p of this.parts) { out.set(p, off); off += p.length; }
    return out;
  }
}

function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function streamHeaderXml(def) {
  const ch = def.channels
    .map(
      (c) =>
        `<channel><label>${xmlEscape(c.label)}</label><unit>${xmlEscape(c.unit)}</unit><type>${xmlEscape(c.type)}</type></channel>`
    )
    .join('');
  return (
    `<?xml version="1.0"?>` +
    `<info>` +
    `<name>${xmlEscape(def.name)}</name>` +
    `<type>${xmlEscape(def.type)}</type>` +
    `<channel_count>${def.channels.length}</channel_count>` +
    `<nominal_srate>${def.nominal_srate}</nominal_srate>` +
    `<channel_format>${def.channel_format}</channel_format>` +
    `<source_id>${xmlEscape(def.serial)}</source_id>` +
    `<manufacturer>${xmlEscape(def.manufacturer)}</manufacturer>` +
    `<desc>` +
    `<manufacturer>${xmlEscape(def.manufacturer)}</manufacturer>` +
    `<device_type>${xmlEscape(def.device_type)}</device_type>` +
    `<serial>${xmlEscape(def.serial)}</serial>` +
    `<firmware>${xmlEscape(def.firmware)}</firmware>` +
    `<channels>${ch}</channels>` +
    `</desc>` +
    `</info>`
  );
}

function fileHeaderXml(meta = {}) {
  const m = (k, v) => (v === undefined || v === null || v === '' ? '' : `<${k}>${xmlEscape(v)}</${k}>`);
  return (
    `<?xml version="1.0"?>` +
    `<info>` +
    `<version>1.0</version>` +
    `<datetime>${xmlEscape(meta.datetime || new Date().toISOString())}</datetime>` +
    `<session>` +
    m('subject_id', meta.subjectId) +
    m('session_type', meta.sessionType) +
    m('device_type', meta.deviceType) +
    m('serial', meta.serial) +
    m('firmware', meta.firmware) +
    m('fit_notes', meta.fitNotes) +
    m('posture', meta.posture) +
    m('note', meta.note) +
    m('sleep_hours', meta.sleepHours) +
    m('caffeine', meta.caffeine) +
    `</session>` +
    `</info>`
  );
}

function streamFooterXml(stats) {
  return (
    `<?xml version="1.0"?>` +
    `<info>` +
    `<first_timestamp>${stats.first ?? 0}</first_timestamp>` +
    `<last_timestamp>${stats.last ?? 0}</last_timestamp>` +
    `<sample_count>${stats.count ?? 0}</sample_count>` +
    `<clock_offsets></clock_offsets>` +
    `</info>`
  );
}

export class XdfWriter {
  constructor() {
    this.parts = [];
    this.bytes = 0;
    // magic code first
    this._raw(TEXT.encode('XDF:'));
  }

  _raw(u8) {
    this.parts.push(u8);
    this.bytes += u8.length;
  }

  // Wrap content with the chunk framing (NumLengthBytes, Length, Tag).
  _chunk(tag, content) {
    const header = new ByteBuilder();
    const totalLen = 2 + content.length; // tag + content
    header.varlen(totalLen);
    header.u16(tag);
    this._raw(header.build());
    this._raw(content);
  }

  writeFileHeader(meta) {
    const b = new ByteBuilder().str(fileHeaderXml(meta));
    this._chunk(1, b.build());
    return this;
  }

  writeStreamHeader(def) {
    const b = new ByteBuilder().u32(def.xdfStreamId).str(streamHeaderXml(def));
    this._chunk(2, b.build());
    return this;
  }

  writeBoundary() {
    this._chunk(5, BOUNDARY_MAGIC.slice());
    return this;
  }

  // samples: array of { t: number(seconds), values: number[] } for numeric,
  // or { t, value: string } for string streams.
  writeSamples(def, samples) {
    if (!samples.length) return this;
    const b = new ByteBuilder();
    b.u32(def.xdfStreamId);
    b.varlen(samples.length);
    if (def.channel_format === 'string') {
      for (const s of samples) {
        b.u8(8).f64(s.t);
        const sb = TEXT.encode(String(s.value));
        b.varlen(sb.length).raw(sb);
      }
    } else {
      // float32 numeric
      const nch = def.channels.length;
      for (const s of samples) {
        b.u8(8).f64(s.t);
        for (let c = 0; c < nch; c++) b.f32(s.values[c] ?? 0);
      }
    }
    this._chunk(3, b.build());
    return this;
  }

  writeClockOffset(def, collectionTime, offset = 0) {
    const b = new ByteBuilder().u32(def.xdfStreamId).f64(collectionTime).f64(offset);
    this._chunk(4, b.build());
    return this;
  }

  writeStreamFooter(def, stats) {
    const b = new ByteBuilder().u32(def.xdfStreamId).str(streamFooterXml(stats));
    this._chunk(6, b.build());
    return this;
  }

  toUint8Array() {
    const out = new Uint8Array(this.bytes);
    let off = 0;
    for (const p of this.parts) { out.set(p, off); off += p.length; }
    return out;
  }

  toBlob(type = 'application/octet-stream') {
    return new Blob(this.parts, { type });
  }
}

// Convenience exports for testing / reuse.
export const _internal = { streamHeaderXml, fileHeaderXml, streamFooterXml, BOUNDARY_MAGIC };
