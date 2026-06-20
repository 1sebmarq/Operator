// synth.mjs
// Generates a short SYNTHETIC recording session and writes a real .xdf file
// using the exact same xdf-writer.js the browser app uses. Also emits an
// expectations JSON that validate_xdf.py checks against. This proves the writer
// produces pyxdf-loadable output without needing real Muse hardware.
//
// Run: node test/synth.mjs  (writes session_synth.xdf + expected.json here)

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { XdfWriter } from '../js/xdf-writer.js';
import { buildStreamDefs, STREAM } from '../js/streams.js';

const here = dirname(fileURLToPath(import.meta.url));

// --- session parameters --------------------------------------------------
const T0 = 10.0;            // monotonic clock origin (seconds)
const DURATION = 6.0;       // seconds of continuous data
const FLUSH = 0.5;          // simulate flushing every 0.5 s (interleaved chunks)

const defs = buildStreamDefs({
  includeAux: false,
  deviceType: 'Muse S',
  serial: 'MUSE-ABCD',
  firmware: '1.2.3',
});

// Helper: build regular numeric samples for [tStart, tEnd) at srate, nch channels.
function genNumeric(srate, nch, tStart, tEnd, fn) {
  const dt = 1 / srate;
  const out = [];
  // first sample index aligned to global grid from T0
  let k = Math.ceil((tStart - T0) / dt);
  for (;; k++) {
    const t = T0 + k * dt;
    if (t >= tEnd) break;
    if (t < tStart) continue;
    const values = [];
    for (let c = 0; c < nch; c++) values.push(fn(t, c));
    out.push({ t, values });
  }
  return out;
}

const numericPlan = [
  { def: defs[STREAM.EEG], srate: 256, nch: 4, fn: (t, c) => 20 * Math.sin(2 * Math.PI * (8 + c) * t) },
  { def: defs[STREAM.PPG], srate: 64, nch: 3, fn: (t, c) => 1000 + 50 * Math.sin(2 * Math.PI * 1.1 * t + c) },
  { def: defs[STREAM.ACC], srate: 52, nch: 3, fn: (t, c) => (c === 2 ? 1 : 0) + 0.01 * Math.sin(t) },
  { def: defs[STREAM.GYRO], srate: 52, nch: 3, fn: (t) => 0.5 * Math.sin(t) },
];

// Telemetry: irregular, a couple of points.
const telemetry = [
  { t: T0 + 0.1, values: [88, 3900, 0.6, 27.5] },
  { t: T0 + 3.0, values: [87, 3895, 0.6, 27.6] },
  { t: T0 + 5.9, values: [87, 3890, 0.6, 27.7] },
];

// Markers: assessments, baseline, labels — known timestamps.
const markers = [
  { t: T0 + 0.0, value: 'assessment/start/Fresh' },
  { t: T0 + 0.5, value: 'baseline/eyes_open/start' },
  { t: T0 + 1.0, value: 'baseline/eyes_open/stop' },
  { t: T0 + 1.0, value: 'baseline/eyes_closed/start' },
  { t: T0 + 1.5, value: 'baseline/eyes_closed/stop' },
  { t: T0 + 2.0, value: 'label/Scrolling/start' },
  { t: T0 + 4.0, value: 'label/Scrolling/stop' },
  { t: T0 + 5.9, value: 'assessment/end/Tired' },
];

// --- write the file ------------------------------------------------------
const w = new XdfWriter();

w.writeFileHeader({
  subjectId: 'S001',
  sessionType: 'record',
  deviceType: 'Muse S',
  serial: 'MUSE-ABCD',
  firmware: '1.2.3',
  fitNotes: 'good fit, dry skin',
  posture: 'seated',
  note: 'synthetic validation session',
  sleepHours: '7',
  caffeine: 'none',
});

const allDefs = [defs[STREAM.EEG], defs[STREAM.PPG], defs[STREAM.ACC], defs[STREAM.GYRO], defs[STREAM.MARKERS], defs[STREAM.TELEMETRY]];
for (const d of allDefs) w.writeStreamHeader(d);

// Initial clock offset per stream (single-clock recording => offset 0).
for (const d of allDefs) w.writeClockOffset(d, T0, 0);

// Pre-generate full numeric series, then slice into interleaved flush windows.
const series = numericPlan.map((p) => ({ ...p, data: genNumeric(p.srate, p.nch, T0, T0 + DURATION, p.fn) }));
const counts = {};

let cursor = {};
series.forEach((s) => (cursor[s.def.key] = 0));

for (let wStart = T0; wStart < T0 + DURATION; wStart += FLUSH) {
  const wEnd = wStart + FLUSH;
  // numeric streams, interleaved per window
  for (const s of series) {
    const chunk = [];
    while (cursor[s.def.key] < s.data.length && s.data[cursor[s.def.key]].t < wEnd) {
      chunk.push(s.data[cursor[s.def.key]]);
      cursor[s.def.key]++;
    }
    if (chunk.length) {
      w.writeSamples(s.def, chunk);
      counts[s.def.key] = (counts[s.def.key] || 0) + chunk.length;
    }
  }
  // markers in this window
  const mchunk = markers.filter((m) => m.t >= wStart && m.t < wEnd);
  if (mchunk.length) w.writeSamples(defs[STREAM.MARKERS], mchunk);
  // telemetry in this window
  const tchunk = telemetry.filter((m) => m.t >= wStart && m.t < wEnd);
  if (tchunk.length) w.writeSamples(defs[STREAM.TELEMETRY], tchunk);
  // periodic clock offset
  for (const d of allDefs) w.writeClockOffset(d, wEnd, 0);
}

counts[STREAM.MARKERS] = markers.length;
counts[STREAM.TELEMETRY] = telemetry.length;

// Footers
for (const s of series) {
  const d = s.data;
  w.writeStreamFooter(s.def, { first: d[0].t, last: d[d.length - 1].t, count: d.length });
}
w.writeStreamFooter(defs[STREAM.MARKERS], { first: markers[0].t, last: markers[markers.length - 1].t, count: markers.length });
w.writeStreamFooter(defs[STREAM.TELEMETRY], { first: telemetry[0].t, last: telemetry[telemetry.length - 1].t, count: telemetry.length });

const bytes = w.toUint8Array();
const xdfPath = join(here, 'session_synth.xdf');
writeFileSync(xdfPath, bytes);

const expected = {
  file: xdfPath,
  stream_count: 6,
  streams: {
    'Muse-EEG': { channel_count: 4, nominal_srate: 256, n_samples: counts[STREAM.EEG] },
    'Muse-PPG': { channel_count: 3, nominal_srate: 64, n_samples: counts[STREAM.PPG] },
    'Muse-Accelerometer': { channel_count: 3, nominal_srate: 52, n_samples: counts[STREAM.ACC] },
    'Muse-Gyroscope': { channel_count: 3, nominal_srate: 52, n_samples: counts[STREAM.GYRO] },
    'Muse-Telemetry': { channel_count: 4, nominal_srate: 0, n_samples: telemetry.length },
    'Muse-Markers': { channel_count: 1, nominal_srate: 0, n_samples: markers.length },
  },
  markers: markers.map((m) => ({ t: m.t, value: m.value })),
};
writeFileSync(join(here, 'expected.json'), JSON.stringify(expected, null, 2));

console.log(`Wrote ${xdfPath} (${bytes.length} bytes)`);
console.log('Expected:', JSON.stringify(expected.streams, null, 2));
