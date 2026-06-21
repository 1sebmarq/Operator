// xdf-reader.js
// Dependency-free XDF reader — the exact inverse of js/xdf-writer.js. Pure ES
// module using only ArrayBuffer / DataView / TextDecoder, so it runs in the
// browser (viewer page) AND in Node (validation harness). No pyxdf needed.
//
// Binary layout (see js/xdf-writer.js for the writer side):
//   [4-byte magic "XDF:"]
//   chunks: [1 byte NumLengthBytes (1|4|8)] [Length LE] [2-byte Tag LE] [Content]
//     Length = bytes of (Tag + Content)  =>  contentLen = Length - 2
//   Tags: 1 FileHeader(XML) | 2 StreamHeader(u32 id + XML) |
//         3 Samples(u32 id + varlen N + Sample[]) | 4 ClockOffset |
//         5 Boundary(16B) | 6 StreamFooter(u32 id + XML)
//   Sample: [u8 tsBytes][if 8: f64 timestamp][values]
//     float32 stream: nch * f32 LE ; string stream: varlen len + UTF-8
//
// parseXdf(arrayBuffer) -> { fileHeader, streams: [ {info, channels,
//   time_stamps, time_series}, ... ] } mirroring the pyxdf shape closely enough
// for the viewer.

const DEC = new TextDecoder();

function xmlField(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  return m ? xmlUnescape(m[1]) : undefined;
}
function xmlUnescape(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}
function parseChannels(xml) {
  const out = [];
  const block = xml.match(/<channels>([\s\S]*?)<\/channels>/);
  if (!block) return out;
  const re = /<channel>([\s\S]*?)<\/channel>/g;
  let m;
  while ((m = re.exec(block[1])) !== null) {
    out.push({
      label: xmlField(m[1], 'label') || '',
      unit: xmlField(m[1], 'unit') || '',
      type: xmlField(m[1], 'type') || '',
    });
  }
  return out;
}

class Reader {
  constructor(buf) {
    this.dv = new DataView(buf);
    this.u8 = new Uint8Array(buf);
    this.pos = 0;
    this.len = buf.byteLength;
  }
  byte() { return this.u8[this.pos++]; }
  u32() { const v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; }
  u16() { const v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; }
  f32() { const v = this.dv.getFloat32(this.pos, true); this.pos += 4; return v; }
  f64() { const v = this.dv.getFloat64(this.pos, true); this.pos += 8; return v; }
  varlen() {
    const nb = this.byte();
    if (nb === 1) return this.byte();
    if (nb === 4) return this.u32();
    if (nb === 8) {
      const v = this.dv.getBigUint64(this.pos, true); this.pos += 8; return Number(v);
    }
    throw new Error(`bad varlen prefix ${nb} at ${this.pos}`);
  }
  bytes(n) { const s = this.u8.subarray(this.pos, this.pos + n); this.pos += n; return s; }
}

export function parseXdf(arrayBuffer) {
  const r = new Reader(arrayBuffer);
  const magic = DEC.decode(r.bytes(4));
  if (magic !== 'XDF:') throw new Error('Not an XDF file (bad magic "' + magic + '")');

  let fileHeader = null;
  const byId = new Map(); // streamId -> stream object

  function ensureStream(id) {
    if (!byId.has(id)) {
      byId.set(id, {
        id,
        info: {},
        channels: [],
        channel_format: 'float32',
        channel_count: 0,
        nominal_srate: 0,
        time_stamps: [],
        time_series: [], // numeric: array of Float arrays (per sample); string: array of strings
      });
    }
    return byId.get(id);
  }

  while (r.pos < r.len) {
    // read chunk length (varlen) then 2-byte tag
    const totalLen = r.varlen();      // = tag(2) + content
    const tagId = r.u16();
    const contentLen = totalLen - 2;
    const contentEnd = r.pos + contentLen;

    if (tagId === 1) {
      fileHeader = DEC.decode(r.bytes(contentLen));
    } else if (tagId === 2) {
      const id = r.u32();
      const xml = DEC.decode(r.bytes(contentEnd - r.pos));
      const st = ensureStream(id);
      st.info.name = xmlField(xml, 'name');
      st.info.type = xmlField(xml, 'type');
      st.channel_count = parseInt(xmlField(xml, 'channel_count') || '0', 10);
      st.nominal_srate = parseFloat(xmlField(xml, 'nominal_srate') || '0');
      st.channel_format = xmlField(xml, 'channel_format') || 'float32';
      st.channels = parseChannels(xml);
      st.headerXml = xml;
    } else if (tagId === 3) {
      const id = r.u32();
      const st = ensureStream(id);
      const n = r.varlen();
      const isStr = st.channel_format === 'string';
      const nch = st.channel_count || (st.channels.length || 1);
      let lastT = st.time_stamps.length ? st.time_stamps[st.time_stamps.length - 1] : 0;
      const dt = st.nominal_srate > 0 ? 1 / st.nominal_srate : 0;
      for (let i = 0; i < n; i++) {
        const tsBytes = r.byte();
        let t;
        if (tsBytes === 8) { t = r.f64(); }
        else { t = lastT + dt; } // deduced timestamp (writer always uses 8, but stay safe)
        lastT = t;
        st.time_stamps.push(t);
        if (isStr) {
          const sl = r.varlen();
          st.time_series.push(DEC.decode(r.bytes(sl)));
        } else {
          const row = new Float32Array(nch);
          for (let c = 0; c < nch; c++) row[c] = r.f32();
          st.time_series.push(row);
        }
      }
    } else if (tagId === 4) {
      // ClockOffset: u32 id + f64 collectionTime + f64 offset — recorded as 0, skip.
      r.pos = contentEnd;
    } else if (tagId === 6) {
      const id = r.u32();
      const xml = DEC.decode(r.bytes(contentEnd - r.pos));
      const st = ensureStream(id);
      st.footer = {
        first: parseFloat(xmlField(xml, 'first_timestamp') || 'NaN'),
        last: parseFloat(xmlField(xml, 'last_timestamp') || 'NaN'),
        count: parseInt(xmlField(xml, 'sample_count') || '0', 10),
      };
    } else {
      // Boundary (5) or unknown — skip content.
      r.pos = contentEnd;
    }

    // Safety: never run past the declared chunk end.
    if (r.pos !== contentEnd) r.pos = contentEnd;
  }

  const streams = [...byId.values()].sort((a, b) => a.id - b.id);
  // Compute an effective sample rate from real timestamps (Muse runs slightly
  // off its nominal label, and DSP wants a single fs).
  for (const st of streams) {
    const n = st.time_stamps.length;
    if (n > 1) {
      const span = st.time_stamps[n - 1] - st.time_stamps[0];
      st.effective_srate = span > 0 ? (n - 1) / span : st.nominal_srate;
    } else {
      st.effective_srate = st.nominal_srate;
    }
  }

  return {
    fileHeader,
    session: parseSession(fileHeader),
    streams,
    streamsByName: Object.fromEntries(streams.map((s) => [s.info.name, s])),
  };
}

function parseSession(xml) {
  if (!xml) return {};
  const fields = ['subject_id', 'session_type', 'device_type', 'serial', 'firmware',
    'fit_notes', 'posture', 'note', 'sleep_hours', 'caffeine', 'datetime'];
  const out = {};
  for (const f of fields) { const v = xmlField(xml, f); if (v !== undefined) out[f] = v; }
  return out;
}

// Extract a numeric stream as channel-major Float64Arrays for DSP.
// Returns { labels, fs, t0, channels: [Float64Array, ...], n }.
export function toChannelMajor(stream) {
  const n = stream.time_stamps.length;
  const nch = stream.channel_count || (stream.channels.length || 1);
  const channels = Array.from({ length: nch }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    const row = stream.time_series[i];
    for (let c = 0; c < nch; c++) channels[c][i] = row[c];
  }
  return {
    labels: stream.channels.map((c) => c.label),
    units: stream.channels.map((c) => c.unit),
    fs: stream.effective_srate || stream.nominal_srate,
    t0: n ? stream.time_stamps[0] : 0,
    timestamps: stream.time_stamps,
    channels,
    n,
  };
}
