// dsp.js
// Dependency-free EEG signal processing: zero-phase IIR filtering (high-pass,
// low-pass, notch), an iterative radix-2 FFT, Welch power spectral density, and
// band-power extraction. Pure ES module — runs in browser and Node.
//
// Filter design uses the Audio-EQ "RBJ cookbook" biquads. A 2nd-order
// Butterworth response is obtained with Q = 1/sqrt(2) for HP/LP. Filters are
// applied forward then backward (filtfilt) so the result is ZERO-PHASE (no
// time shift of EEG features) with double the effective roll-off.

// ---------- biquad design (RBJ cookbook) ----------
// Returns normalized coefficients {b0,b1,b2,a1,a2} (a0 divided out).

function lowpassCoef(fs, fc, Q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * fc) / fs;
  const cos = Math.cos(w0), sin = Math.sin(w0);
  const alpha = sin / (2 * Q);
  const b1 = 1 - cos, b0 = b1 / 2, b2 = b0;
  const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  return norm(b0, b1, b2, a0, a1, a2);
}
function highpassCoef(fs, fc, Q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * fc) / fs;
  const cos = Math.cos(w0), sin = Math.sin(w0);
  const alpha = sin / (2 * Q);
  const b0 = (1 + cos) / 2, b1 = -(1 + cos), b2 = b0;
  const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  return norm(b0, b1, b2, a0, a1, a2);
}
function notchCoef(fs, f0, Q = 30) {
  const w0 = (2 * Math.PI * f0) / fs;
  const cos = Math.cos(w0), sin = Math.sin(w0);
  const alpha = sin / (2 * Q);
  const b0 = 1, b1 = -2 * cos, b2 = 1;
  const a0 = 1 + alpha, a1 = -2 * cos, a2 = 1 - alpha;
  return norm(b0, b1, b2, a0, a1, a2);
}
function norm(b0, b1, b2, a0, a1, a2) {
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

// One forward pass of a biquad (Direct Form II transposed).
function biquadForward(x, c, out) {
  let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const xn = x[i];
    const yn = c.b0 * xn + z1;
    z1 = c.b1 * xn - c.a1 * yn + z2;
    z2 = c.b2 * xn - c.a2 * yn;
    out[i] = yn;
  }
  return out;
}

// Zero-phase: forward, reverse, forward again, reverse back. Reflect-pad the
// edges to suppress startup transients (poor-man's filtfilt).
function filtfiltBiquad(x, c) {
  const n = x.length;
  if (n < 4) return Float64Array.from(x);
  const pad = Math.min(n - 1, Math.round(0.5 * 1)); // small reflect pad
  const padN = Math.min(n - 1, Math.max(8, pad));
  const ext = new Float64Array(n + 2 * padN);
  // reflect around endpoints: 2*x0 - x[k]
  for (let i = 0; i < padN; i++) ext[i] = 2 * x[0] - x[padN - i];
  for (let i = 0; i < n; i++) ext[padN + i] = x[i];
  for (let i = 0; i < padN; i++) ext[padN + n + i] = 2 * x[n - 1] - x[n - 2 - i];

  const tmp = new Float64Array(ext.length);
  biquadForward(ext, c, tmp);
  tmp.reverse();
  const tmp2 = new Float64Array(ext.length);
  biquadForward(tmp, c, tmp2);
  tmp2.reverse();
  return tmp2.subarray(padN, padN + n);
}

// ---------- public filtering API ----------
// opts: { highpass: Hz|null, lowpass: Hz|null, notch: Hz|null, notchQ }
// Applies in order: high-pass -> low-pass -> notch. Returns new Float64Array.
export function applyFilters(signal, fs, opts = {}) {
  let y = Float64Array.from(signal);
  if (opts.highpass && opts.highpass > 0) {
    y = filtfiltBiquad(y, highpassCoef(fs, opts.highpass));
  }
  if (opts.lowpass && opts.lowpass > 0 && opts.lowpass < fs / 2) {
    y = filtfiltBiquad(y, lowpassCoef(fs, opts.lowpass));
  }
  if (opts.notch && opts.notch > 0 && opts.notch < fs / 2) {
    y = filtfiltBiquad(y, notchCoef(fs, opts.notch, opts.notchQ || 30));
  }
  return y;
}

// ---------- FFT (iterative radix-2, in place) ----------
export function fft(re, im) {
  const n = re.length;
  // bit reversal
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1, cwi = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const tr = cwr * re[b] - cwi * im[b];
        const ti = cwr * im[b] + cwi * re[b];
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr; cwr = ncwr;
      }
    }
  }
}

function nextPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }
function hann(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  return w;
}

// ---------- Welch PSD ----------
// Returns { freqs: Float64Array, psd: Float64Array } in units^2 / Hz.
export function welchPSD(signal, fs, { nfft = 512, overlap = 0.5 } = {}) {
  const N = signal.length;
  let seg = Math.min(nfft, N);
  // use a power-of-two segment for the radix-2 FFT
  const segLen = nextPow2(seg) > seg ? nextPow2(seg) >> 1 : seg;
  const L = Math.max(64, Math.min(segLen, 1 << Math.floor(Math.log2(Math.max(2, N)))));
  const win = hann(L);
  let winPow = 0; for (let i = 0; i < L; i++) winPow += win[i] * win[i];
  const step = Math.max(1, Math.floor(L * (1 - overlap)));
  const nFreq = L / 2 + 1;
  const psd = new Float64Array(nFreq);
  let segCount = 0;

  // detrend (remove mean) per segment
  for (let start = 0; start + L <= N; start += step) {
    let mean = 0; for (let i = 0; i < L; i++) mean += signal[start + i]; mean /= L;
    const re = new Float64Array(L), im = new Float64Array(L);
    for (let i = 0; i < L; i++) re[i] = (signal[start + i] - mean) * win[i];
    fft(re, im);
    for (let k = 0; k < nFreq; k++) {
      const mag2 = re[k] * re[k] + im[k] * im[k];
      let scale = (2 * mag2) / (fs * winPow);
      if (k === 0 || k === nFreq - 1) scale /= 2; // DC & Nyquist not doubled
      psd[k] += scale;
    }
    segCount++;
  }
  if (segCount === 0) { // signal shorter than one segment: single padded FFT
    const Lp = nextPow2(N);
    const re = new Float64Array(Lp), im = new Float64Array(Lp);
    let mean = 0; for (let i = 0; i < N; i++) mean += signal[i]; mean /= N;
    for (let i = 0; i < N; i++) re[i] = signal[i] - mean;
    fft(re, im);
    const nf = Lp / 2 + 1;
    const freqs = new Float64Array(nf), p = new Float64Array(nf);
    for (let k = 0; k < nf; k++) {
      freqs[k] = (k * fs) / Lp;
      p[k] = (re[k] * re[k] + im[k] * im[k]) / (fs * N);
    }
    return { freqs, psd: p };
  }
  for (let k = 0; k < nFreq; k++) psd[k] /= segCount;
  const freqs = new Float64Array(nFreq);
  for (let k = 0; k < nFreq; k++) freqs[k] = (k * fs) / L;
  return { freqs, psd };
}

// Standard EEG bands (Hz).
export const BANDS = {
  delta: [0.5, 4],
  theta: [4, 8],
  alpha: [8, 13],
  beta: [13, 30],
  gamma: [30, 45],
};

// Integrate PSD over a band (trapezoid) -> absolute band power (units^2).
export function bandPower(freqs, psd, lo, hi) {
  let p = 0;
  for (let k = 1; k < freqs.length; k++) {
    const f0 = freqs[k - 1], f1 = freqs[k];
    if (f1 < lo || f0 > hi) continue;
    const a = Math.max(f0, lo), b = Math.min(f1, hi);
    // linear interp PSD at a,b
    const frac = (x) => (x - f0) / (f1 - f0 || 1);
    const pa = psd[k - 1] + (psd[k] - psd[k - 1]) * frac(a);
    const pb = psd[k - 1] + (psd[k] - psd[k - 1]) * frac(b);
    p += ((pa + pb) / 2) * (b - a);
  }
  return p;
}

export function allBandPowers(freqs, psd) {
  const out = {};
  let total = 0;
  for (const [name, [lo, hi]] of Object.entries(BANDS)) {
    out[name] = bandPower(freqs, psd, lo, hi);
    total += out[name];
  }
  out._total = total;
  return out;
}

// Band power over time: slide a window, compute Welch PSD + band powers per
// window. Returns { times: [...], bands: { alpha: [...], ... } } where times are
// window-center sample offsets in seconds (add t0 outside if absolute).
export function bandPowerOverTime(signal, fs, { winSec = 2, stepSec = 1, relative = true } = {}) {
  const W = Math.max(64, Math.round(winSec * fs));
  const S = Math.max(1, Math.round(stepSec * fs));
  const names = Object.keys(BANDS);
  const times = [];
  const bands = Object.fromEntries(names.map((n) => [n, []]));
  for (let start = 0; start + W <= signal.length; start += S) {
    const seg = signal.subarray(start, start + W);
    const { freqs, psd } = welchPSD(seg, fs, { nfft: Math.min(512, W), overlap: 0.5 });
    const bp = allBandPowers(freqs, psd);
    const denom = relative ? (bp._total || 1) : 1;
    for (const n of names) bands[n].push(bp[n] / denom);
    times.push((start + W / 2) / fs);
  }
  return { times, bands };
}
