// clock.js
// One monotonic clock for the whole app. We use performance.now() (milliseconds,
// monotonic, unaffected by wall-clock changes) and expose LSL-style float
// timestamps in SECONDS. Every sample from every stream is stamped against this
// single clock so streams remain mutually alignable even though they run at
// different rates and arrive in packets of different sizes.

// A fixed origin captured once at module load. performance.timeOrigin lets us
// also recover an approximate UNIX time for the FileHeader if desired.
const T_ORIGIN_MS = (typeof performance !== 'undefined' && performance.timeOrigin) || Date.now();

// Current monotonic time in seconds (LSL-style). Page-load relative is fine:
// XDF only requires timestamps to be consistent within a recording.
export function now() {
  return (typeof performance !== 'undefined' ? performance.now() : Date.now() - T_ORIGIN_MS) / 1000;
}

// Approximate UNIX epoch seconds corresponding to a monotonic timestamp `t`.
export function toUnix(t) {
  return T_ORIGIN_MS / 1000 + t;
}

// Given the arrival time of a packet containing `count` regularly-spaced samples
// at `srate` Hz, return the per-sample timestamps. The newest sample is anchored
// to arrival time and earlier samples are back-dated by 1/srate. This keeps
// inter-sample spacing regular while staying tied to the real arrival clock.
export function packetTimestamps(arrival, count, srate) {
  const dt = 1 / srate;
  const out = new Array(count);
  for (let i = 0; i < count; i++) {
    out[i] = arrival - (count - 1 - i) * dt;
  }
  return out;
}
