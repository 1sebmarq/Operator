// viewer.js
// EEG viewer page controller. Loads a .xdf recording (parsed in-browser via
// xdf-reader.js), applies preprocessing filters (dsp.js), and renders three
// views on plain <canvas>: a multi-channel time-series scroll with marker
// overlays, a Welch PSD spectrum, and band power over time. No dependencies.

import { parseXdf, toChannelMajor } from './xdf-reader.js';
import {
  applyFilters, welchPSD, allBandPowers, bandPowerOverTime, BANDS,
} from './dsp.js';

const CH_COLORS = ['#5b8cff', '#36d39a', '#f5c451', '#ff7ab6', '#a78bfa', '#ff8c5a'];
const BAND_COLORS = {
  delta: '#5b8cff', theta: '#36d39a', alpha: '#f5c451', beta: '#ff7ab6', gamma: '#a78bfa',
};
const BAND_FILL = {
  delta: 'rgba(91,140,255,.10)', theta: 'rgba(54,211,154,.10)', alpha: 'rgba(245,196,81,.10)',
  beta: 'rgba(255,122,182,.10)', gamma: 'rgba(167,139,250,.10)',
};

const $ = (id) => document.getElementById(id);

const state = {
  doc: null,
  eeg: null,          // channel-major raw {labels, fs, channels, n, t0, timestamps}
  filtered: [],       // Float64Array per channel (post-filter)
  selected: [],       // bool per channel
  markers: [],        // {t (rel sec), label, raw}
  startSec: 0,
  duration: 0,
};

// ---------------- file loading ----------------
const drop = $('drop'), fileInput = $('fileInput');
drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag'); });
drop.addEventListener('dragleave', () => drop.classList.remove('drag'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('drag');
  if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) loadFile(fileInput.files[0]); });

async function loadFile(file) {
  const err = $('loadErr'); err.classList.add('hidden');
  try {
    const buf = await file.arrayBuffer();
    const doc = parseXdf(buf);
    const eegStream = doc.streamsByName['Muse-EEG']
      || doc.streams.find((s) => (s.info.type || '').toUpperCase() === 'EEG');
    if (!eegStream) throw new Error('No EEG stream found in this file.');
    const eeg = toChannelMajor(eegStream);
    if (!eeg.n) throw new Error('EEG stream contains no samples.');

    state.doc = doc;
    state.eeg = eeg;
    state.duration = eeg.timestamps[eeg.n - 1] - eeg.t0;
    state.selected = eeg.labels.map(() => true);
    state.startSec = 0;

    // markers (relative to EEG start)
    const mk = doc.streamsByName['Muse-Markers'];
    state.markers = mk ? mk.time_stamps.map((t, i) => ({
      t: t - eeg.t0, label: String(mk.time_series[i]), raw: String(mk.time_series[i]),
    })).filter((m) => m.t >= -0.5 && m.t <= state.duration + 0.5) : [];

    $('fileSub').textContent = `${file.name} · ${eeg.n.toLocaleString()} samples · ${eeg.fs.toFixed(1)} Hz · ${fmtDur(state.duration)}`;
    $('fsNote').textContent = `Effective sample rate ${eeg.fs.toFixed(2)} Hz (computed from timestamps). Filters are zero-phase (filtfilt).`;
    $('loadCard').classList.add('hidden');
    showSession();
    buildChannelChips();
    buildBandChanSelect();
    ['metaCard', 'filterCard', 'chanCard', 'scrollCard', 'psdCard', 'bandCard']
      .forEach((id) => $(id).classList.remove('hidden'));
    recomputeFilters();
  } catch (e) {
    err.textContent = 'Could not load file: ' + e.message;
    err.classList.remove('hidden');
  }
}

function fmtDur(s) {
  const m = Math.floor(s / 60), sec = Math.round(s % 60);
  return m ? `${m}m ${sec}s` : `${s.toFixed(1)}s`;
}

function showSession() {
  const s = state.doc.session || {};
  const map = {
    subject_id: 'Subject', session_type: 'Type', device_type: 'Device', serial: 'Serial',
    firmware: 'Firmware', posture: 'Posture', datetime: 'Recorded', note: 'Note',
    sleep_hours: 'Sleep (h)', caffeine: 'Caffeine', fit_notes: 'Fit notes',
  };
  const el = $('sessionMeta'); el.innerHTML = '';
  for (const [k, label] of Object.entries(map)) {
    if (!s[k]) continue;
    const d = document.createElement('div');
    let v = s[k];
    if (k === 'datetime') { const dt = new Date(v); if (!isNaN(dt)) v = dt.toLocaleString(); }
    d.innerHTML = `<span>${label}</span>${escapeHtml(v)}`;
    el.appendChild(d);
  }
  const d2 = document.createElement('div');
  d2.innerHTML = `<span>EEG channels</span>${state.eeg.labels.join(', ')}`;
  el.appendChild(d2);
}
function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ---------------- channel chips ----------------
function buildChannelChips() {
  const box = $('chanChips'); box.innerHTML = '';
  state.eeg.labels.forEach((lab, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.innerHTML = `<span class="sw" style="background:${CH_COLORS[i % CH_COLORS.length]}"></span>${lab}`;
    chip.addEventListener('click', () => {
      state.selected[i] = !state.selected[i];
      chip.classList.toggle('off', !state.selected[i]);
      renderAll();
    });
    box.appendChild(chip);
  });
}
function buildBandChanSelect() {
  const sel = $('bandChan'); sel.innerHTML = '';
  state.eeg.labels.forEach((lab, i) => {
    const o = document.createElement('option'); o.value = i; o.textContent = lab; sel.appendChild(o);
  });
}

// ---------------- filtering ----------------
function currentFilterOpts() {
  return {
    highpass: $('hpOn').checked ? parseFloat($('hpFreq').value) : null,
    lowpass: $('lpOn').checked ? parseFloat($('lpFreq').value) : null,
    notch: $('notchOn').checked ? parseFloat($('notchFreq').value) : null,
    notchQ: 30,
    detrend: $('detrendOn').checked,
  };
}
function recomputeFilters() {
  if (!state.eeg) return;
  const opts = currentFilterOpts();
  const fs = state.eeg.fs;
  state.filtered = state.eeg.channels.map((raw) => {
    let x = raw;
    if (opts.detrend) {
      let mean = 0; for (let i = 0; i < raw.length; i++) mean += raw[i]; mean /= raw.length;
      x = Float64Array.from(raw, (v) => v - mean);
    }
    return applyFilters(x, fs, opts);
  });
  renderAll();
}

let filterTimer = null;
function scheduleRefilter() { clearTimeout(filterTimer); filterTimer = setTimeout(recomputeFilters, 120); }

['hpOn', 'lpOn', 'notchOn', 'detrendOn'].forEach((id) => $(id).addEventListener('change', recomputeFilters));
['hpFreq', 'lpFreq'].forEach((id) => $(id).addEventListener('input', scheduleRefilter));
$('notchFreq').addEventListener('change', recomputeFilters);
$('resetFilters').addEventListener('click', () => {
  $('hpOn').checked = true; $('hpFreq').value = 1;
  $('lpOn').checked = true; $('lpFreq').value = 40;
  $('notchOn').checked = true; $('notchFreq').value = 60;
  $('detrendOn').checked = true;
  recomputeFilters();
});

// ---------------- canvas helpers ----------------
function fitCanvas(canvas, cssH) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.parentElement.clientWidth;
  canvas.style.height = cssH + 'px';
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: cssW, h: cssH };
}

// ---------------- scroll plot ----------------
function renderScroll() {
  const { ctx, w, h } = fitCanvas($('scrollCanvas'), 420);
  ctx.clearRect(0, 0, w, h);
  const fs = state.eeg.fs;
  const winSec = parseFloat($('winSec').value);
  const ampScale = parseFloat($('ampScale').value); // µV per half-lane
  const showMarkers = $('showMarkers').checked;
  const showRaw = $('showRaw').checked;

  // clamp start
  const maxStart = Math.max(0, state.duration - winSec);
  if (state.startSec > maxStart) state.startSec = maxStart;
  const start = state.startSec, end = start + winSec;
  updateNav(maxStart, winSec);

  const padL = 56, padR = 12, padT = 10, padB = 26;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const sel = state.eeg.labels.map((_, i) => i).filter((i) => state.selected[i]);
  if (!sel.length) { ctx.fillStyle = '#8a93a6'; ctx.fillText('No channels selected', padL, padT + 20); return; }
  const laneH = plotH / sel.length;
  const xOf = (t) => padL + ((t - start) / winSec) * plotW;

  // time grid (1 s)
  ctx.strokeStyle = '#1b2233'; ctx.lineWidth = 1; ctx.fillStyle = '#8a93a6'; ctx.font = '11px system-ui';
  const gstep = winSec <= 5 ? 1 : winSec <= 20 ? 2 : 5;
  for (let t = Math.ceil(start); t <= end; t += gstep) {
    const x = xOf(t); ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
    ctx.fillText(t.toFixed(0) + 's', x + 2, padT + plotH + 16);
  }

  const i0 = Math.max(0, Math.floor(start * fs));
  const i1 = Math.min(state.eeg.n - 1, Math.ceil(end * fs));

  sel.forEach((ci, laneIdx) => {
    const laneTop = padT + laneIdx * laneH;
    const mid = laneTop + laneH / 2;
    const pxPerUv = (laneH * 0.45) / ampScale;
    // center line + label
    ctx.strokeStyle = '#161d2e'; ctx.beginPath(); ctx.moveTo(padL, mid); ctx.lineTo(padL + plotW, mid); ctx.stroke();
    ctx.fillStyle = CH_COLORS[ci % CH_COLORS.length]; ctx.font = '12px system-ui';
    ctx.fillText(state.eeg.labels[ci], 6, mid + 4);

    if (showRaw) drawTrace(ctx, state.eeg.channels[ci], i0, i1, fs, xOf, mid, pxPerUv, plotW, padL, 'rgba(138,147,166,.45)');
    drawTrace(ctx, state.filtered[ci], i0, i1, fs, xOf, mid, pxPerUv, plotW, padL, CH_COLORS[ci % CH_COLORS.length]);
  });

  // amplitude scale bar
  ctx.strokeStyle = '#8a93a6'; ctx.fillStyle = '#8a93a6'; ctx.font = '11px system-ui';
  const barH = (laneH * 0.45);
  ctx.beginPath(); ctx.moveTo(w - padR - 4, padT + 8); ctx.lineTo(w - padR - 4, padT + 8 + barH); ctx.stroke();
  ctx.fillText(`${ampScale}µV`, w - padR - 40, padT + 8 + barH / 2);

  // markers
  if (showMarkers) {
    ctx.font = '10px system-ui';
    state.markers.forEach((m) => {
      if (m.t < start || m.t > end) return;
      const x = xOf(m.t);
      ctx.strokeStyle = 'rgba(245,90,108,.7)'; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.setLineDash([]);
      ctx.save(); ctx.translate(x + 3, padT + 4); ctx.rotate(Math.PI / 2);
      ctx.fillStyle = '#ff8c5a'; ctx.fillText(shortMarker(m.label), 0, 0); ctx.restore();
    });
  }
}

function drawTrace(ctx, data, i0, i1, fs, xOf, mid, pxPerUv, plotW, padL, color) {
  ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.lineJoin = 'round'; ctx.lineCap = 'round'; ctx.beginPath();
  const nPts = i1 - i0;
  if (nPts <= plotW * 2) {
    // direct continuous polyline through every sample
    let first = true;
    for (let i = i0; i <= i1; i++) {
      const x = xOf(i / fs);
      const y = mid - data[i] * pxPerUv;
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
  } else {
    // min/max decimation, drawn as ONE continuous path (connect each column to
    // the next so the trace flows instead of rendering as separate ticks).
    const cols = Math.round(plotW);
    let first = true;
    for (let c = 0; c < cols; c++) {
      const a = i0 + Math.floor((c / cols) * nPts);
      const b = i0 + Math.floor(((c + 1) / cols) * nPts);
      let mn = Infinity, mx = -Infinity;
      for (let i = a; i < b && i <= i1; i++) { const v = data[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
      if (mn === Infinity) continue;
      const x = padL + (c / cols) * plotW;
      const yMax = mid - mx * pxPerUv, yMin = mid - mn * pxPerUv;
      if (first) { ctx.moveTo(x, yMax); first = false; } else ctx.lineTo(x, yMax);
      ctx.lineTo(x, yMin);
    }
  }
  ctx.stroke();
}

function shortMarker(s) {
  const parts = s.split('/');
  return parts.length > 1 ? parts.slice(1).join('/') : s;
}

function updateNav(maxStart, winSec) {
  const slider = $('navSlider');
  slider.max = maxStart > 0 ? maxStart : 0;
  slider.value = state.startSec;
  slider.step = Math.max(0.05, winSec / 50);
  $('navLabel').textContent = `${state.startSec.toFixed(1)}–${(state.startSec + winSec).toFixed(1)}s / ${fmtDur(state.duration)}`;
}
$('navSlider').addEventListener('input', () => { state.startSec = parseFloat($('navSlider').value); renderScroll(); renderPSDIfWindow(); });
$('navPrev').addEventListener('click', () => { state.startSec = Math.max(0, state.startSec - parseFloat($('winSec').value) * 0.5); renderScroll(); renderPSDIfWindow(); });
$('navNext').addEventListener('click', () => { state.startSec += parseFloat($('winSec').value) * 0.5; renderScroll(); renderPSDIfWindow(); });
['winSec', 'ampScale', 'showMarkers', 'showRaw'].forEach((id) => $(id).addEventListener('change', () => { renderScroll(); renderPSDIfWindow(); }));

// ---------------- PSD ----------------
function renderPSD() {
  const { ctx, w, h } = fitCanvas($('psdCanvas'), 320);
  ctx.clearRect(0, 0, w, h);
  const fs = state.eeg.fs;
  const fmax = Math.min(parseFloat($('psdMax').value), fs / 2);
  const logY = $('psdLog').checked;
  const whole = $('psdWholeRange').checked;
  const padL = 56, padR = 12, padT = 12, padB = 30;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const legend = $('psdLegend'); legend.innerHTML = '';

  const sel = state.eeg.labels.map((_, i) => i).filter((i) => state.selected[i]);
  if (!sel.length) { ctx.fillStyle = '#8a93a6'; ctx.fillText('No channels selected', padL, padT + 20); return; }

  // slice
  let sliceFn;
  if (whole) sliceFn = (ci) => state.filtered[ci];
  else {
    const winSec = parseFloat($('winSec').value);
    const i0 = Math.max(0, Math.floor(state.startSec * fs));
    const i1 = Math.min(state.eeg.n, Math.ceil((state.startSec + winSec) * fs));
    sliceFn = (ci) => state.filtered[ci].subarray(i0, i1);
  }

  // compute PSDs
  const psds = sel.map((ci) => {
    const seg = sliceFn(ci);
    const nfft = Math.min(512, 1 << Math.floor(Math.log2(Math.max(2, seg.length))));
    return { ci, ...welchPSD(seg, fs, { nfft, overlap: 0.5 }) };
  });

  // y range
  let yMin = Infinity, yMax = -Infinity;
  const yval = (p) => logY ? 10 * Math.log10(p + 1e-12) : p;
  psds.forEach((P) => P.freqs.forEach((f, k) => {
    if (f < 0.3 || f > fmax) return;
    const v = yval(P.psd[k]); if (v < yMin) yMin = v; if (v > yMax) yMax = v;
  }));
  if (!isFinite(yMin)) { yMin = 0; yMax = 1; }
  if (yMax - yMin < 1e-6) yMax = yMin + 1;
  const pad = (yMax - yMin) * 0.08; yMin -= pad; yMax += pad;

  const xOf = (f) => padL + (f / fmax) * plotW;
  const yOf = (v) => padT + plotH - ((v - yMin) / (yMax - yMin)) * plotH;

  // band shading
  for (const [name, [lo, hi]] of Object.entries(BANDS)) {
    if (lo > fmax) continue;
    const x0 = xOf(Math.max(0.3, lo)), x1 = xOf(Math.min(hi, fmax));
    ctx.fillStyle = BAND_FILL[name]; ctx.fillRect(x0, padT, x1 - x0, plotH);
    ctx.fillStyle = BAND_COLORS[name];
    ctx.font = '10px system-ui';
    ctx.fillText(name, (x0 + x1) / 2 - 8, padT + 11);
  }

  // axes
  ctx.strokeStyle = '#2a3550'; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH); ctx.stroke();
  ctx.fillStyle = '#8a93a6'; ctx.font = '11px system-ui';
  for (let f = 0; f <= fmax; f += (fmax <= 40 ? 5 : 10)) {
    const x = xOf(f); ctx.strokeStyle = '#161d2e';
    ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
    ctx.fillStyle = '#8a93a6'; ctx.fillText(f + '', x - 4, padT + plotH + 14);
  }
  ctx.fillText('Hz', padL + plotW - 14, padT + plotH + 26);
  ctx.save(); ctx.translate(14, padT + plotH / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText(logY ? 'Power (dB/Hz)' : 'Power (µV²/Hz)', -30, 0); ctx.restore();
  // y ticks
  for (let g = 0; g <= 4; g++) {
    const v = yMin + (g / 4) * (yMax - yMin); const y = yOf(v);
    ctx.fillStyle = '#8a93a6'; ctx.fillText(v.toFixed(logY ? 0 : 1), 22, y + 3);
  }

  // traces
  psds.forEach((P) => {
    const color = CH_COLORS[P.ci % CH_COLORS.length];
    ctx.strokeStyle = color; ctx.lineWidth = 1.4; ctx.beginPath();
    let first = true;
    for (let k = 0; k < P.freqs.length; k++) {
      const f = P.freqs[k]; if (f < 0.3 || f > fmax) continue;
      const x = xOf(f), y = yOf(yval(P.psd[k]));
      if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
    const item = document.createElement('span'); item.className = 'item';
    item.innerHTML = `<span class="sw" style="background:${color}"></span>${state.eeg.labels[P.ci]}`;
    legend.appendChild(item);
  });
}
function renderPSDIfWindow() { if (state.eeg && !$('psdWholeRange').checked) renderPSD(); }
['psdMax', 'psdLog', 'psdWholeRange'].forEach((id) => $(id).addEventListener('change', renderPSD));

// ---------------- band power over time ----------------
function renderBand() {
  const { ctx, w, h } = fitCanvas($('bandCanvas'), 300);
  ctx.clearRect(0, 0, w, h);
  const fs = state.eeg.fs;
  const ci = parseInt($('bandChan').value, 10) || 0;
  const winSec = parseFloat($('bandWin').value);
  const relative = $('bandRel').checked;
  const padL = 56, padR = 12, padT = 12, padB = 30;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const legend = $('bandLegend'); legend.innerHTML = '';

  const sig = state.filtered[ci];
  const res = bandPowerOverTime(sig, fs, { winSec, stepSec: Math.max(0.5, winSec / 2), relative });
  if (!res.times.length) { ctx.fillStyle = '#8a93a6'; ctx.fillText('Recording too short for this window.', padL, padT + 20); return; }

  const names = Object.keys(BANDS);
  let yMax = relative ? 1 : 0;
  if (!relative) names.forEach((n) => res.bands[n].forEach((v) => { if (v > yMax) yMax = v; }));
  if (yMax <= 0) yMax = 1;
  const tMax = res.times[res.times.length - 1], tMin = res.times[0];
  const xOf = (t) => padL + ((t - tMin) / (tMax - tMin || 1)) * plotW;
  const yOf = (v) => padT + plotH - (v / yMax) * plotH;

  // axes
  ctx.strokeStyle = '#2a3550';
  ctx.beginPath(); ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH); ctx.stroke();
  ctx.fillStyle = '#8a93a6'; ctx.font = '11px system-ui';
  const tstep = (tMax - tMin) <= 30 ? 5 : (tMax - tMin) <= 120 ? 20 : 60;
  for (let t = Math.ceil(tMin / tstep) * tstep; t <= tMax; t += tstep) {
    const x = xOf(t); ctx.strokeStyle = '#161d2e'; ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
    ctx.fillStyle = '#8a93a6'; ctx.fillText(t.toFixed(0) + 's', x - 6, padT + plotH + 14);
  }
  ctx.save(); ctx.translate(14, padT + plotH / 2); ctx.rotate(-Math.PI / 2);
  ctx.fillText(relative ? 'Relative power' : 'Power (µV²)', -30, 0); ctx.restore();
  for (let g = 0; g <= 4; g++) {
    const v = (g / 4) * yMax; const y = yOf(v);
    ctx.fillStyle = '#8a93a6'; ctx.fillText(relative ? (v * 100).toFixed(0) + '%' : v.toFixed(1), 18, y + 3);
  }

  // lines
  names.forEach((n) => {
    ctx.strokeStyle = BAND_COLORS[n]; ctx.lineWidth = 1.6; ctx.beginPath();
    res.times.forEach((t, i) => {
      const x = xOf(t), y = yOf(res.bands[n][i]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    const item = document.createElement('span'); item.className = 'item';
    item.innerHTML = `<span class="sw" style="background:${BAND_COLORS[n]}"></span>${n}`;
    legend.appendChild(item);
  });
}
['bandChan', 'bandWin', 'bandRel'].forEach((id) => $(id).addEventListener('change', renderBand));

// ---------------- orchestration ----------------
function renderAll() {
  if (!state.eeg) return;
  renderScroll();
  renderPSD();
  renderBand();
}
let resizeTimer = null;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderAll, 150); });
