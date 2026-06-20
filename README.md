# Muse Recorder (PWA)

Mobile-first, offline web app for recording multi-modal data from a **Muse S / Muse 2**
EEG headband to a valid **`.xdf`** file, stored entirely on-device. Single-user
research / data-collection workflow. No build step, no backend.

- **Android:** open in Chrome (Web Bluetooth is native).
- **iOS:** open in **Bluefy** (WebBLE browser); plain Safari/Chrome on iOS do not
  expose Web Bluetooth.
- Add to Home Screen to run standalone (PWA).

## What it captures

Every sample from every stream is stamped against **one monotonic clock**
(`performance.now()` → LSL-style float seconds), so streams that run at different
rates stay mutually alignable. Sample counts are **never** assumed equal across
streams.

| Stream | Channels | Nominal rate | Unit | XDF id |
|---|---|---|---|---|
| EEG | TP9, AF7, AF8, TP10 (+AUX optional) | 256 Hz | microvolts | 1 |
| PPG | ambient, IR, red | 64 Hz | arb | 2 |
| Accelerometer | X, Y, Z | 52 Hz | g | 3 |
| Gyroscope | X, Y, Z | 52 Hz | deg/s | 4 |
| Markers | label/assessment/event | irregular | string | 5 |
| Telemetry | battery %, fuel mV, adc, temperature °C | irregular | — | 6 |

Rates follow the muse-js / web-muse decoders, confirmed against a real recording:
EEG measured ~255.8 Hz, IMU measured ~53.8 Hz (the device runs slightly above its
52 Hz nominal label). PPG requires the **`p50`** preset (the default); `p21` streams
EEG+IMU only and leaves PPG empty. The AUX EEG channel is toggleable.
Per-characteristic **sequence indices** are tracked and **dropped/missing samples**
are counted per stream (shown live and stored on the session).

## Files

```
index.html              app shell (dark, mobile-first, one-thumb live controls)
manifest.webmanifest    PWA manifest
sw.js                   service worker (caches app shell; data stays in IndexedDB)
css/styles.css          dark theme, large touch targets
js/streams.js           stream + channel + BLE-UUID definitions
js/clock.js             single monotonic clock → LSL float timestamps
js/muse.js              Web Bluetooth Muse layer (decoders from muse-js/web-muse,
                        injectMarker pattern, fit heuristic, drop tracking)
js/xdf-writer.js        self-contained XDF writer (runs in browser AND Node)
js/storage.js           IndexedDB chunked, crash-safe storage + checkpointer
js/recorder.js          session orchestration, markers, baseline, wake lock,
                        disconnect handling, XDF export
js/app.js               UI controller
icons/                  PWA icons
test/                   validation gate (see below)
```

## XDF output

`js/xdf-writer.js` is a dependency-free writer producing: the 4-byte `XDF:` magic,
a **FileHeader** chunk (session metadata embedded as XML), one **StreamHeader** per
stream (name, type, channel labels + units, channel count, nominal rate, channel
format, `manufacturer = Interaxon`, device type, serial, firmware), **interleaved
Sample chunks**, **ClockOffset** chunks (offset 0 — single-clock recording), and a
**StreamFooter** per stream. Every sample carries an explicit 8-byte timestamp so
loaded timestamps are exact.

The **same file** runs in the browser (recording) and in Node (the test harness),
so the writer is validated by the exact code the app ships.

## Validation gate (treat any pyxdf failure as a build failure)

```
bash test/run_validation.sh
```

This (1) generates a short **synthetic** session with `test/synth.mjs` using the
shipping XDF writer, then (2) loads it with **pyxdf** (`test/validate_xdf.py`) and
asserts. `pyxdf` is vendored at `test/vendor/pyxdf.py` (depends only on numpy) so the
gate runs offline. Each check is documented as **action → expected outcome**:

| Action | Expected outcome |
|---|---|
| `pyxdf.load_xdf(session_synth.xdf)` | loads, no exception |
| `len(streams)` | 6 |
| `<stream>.channel_count` | EEG 4, PPG 3, ACC 3, GYRO 3, Telemetry 4, Markers 1 |
| `<stream>.nominal_srate` | EEG 256, PPG 64, ACC/GYRO 52, Markers/Telemetry 0 |
| `len(<stream>.time_series)` | equals samples written per stream |
| numeric `time_series.shape[1]` | equals channel count |
| marker count | 8 |
| marker `(timestamp, label)` pairs | all labels equal; timestamps within 1e-4 s |
| FileHeader | parses (session metadata present) |

Last run: **28 checks PASS / 0 FAIL.** A non-zero exit = build failure.

## Sessions, markers, assessments

- **Record session:** freeform; add markers/assessments live (also possible after
  the fact by editing markers — every marker is a timestamped entry in stream 5).
- **Activity session:** non-exclusive labels (Scrolling, Daydreaming, Driving,
  Passenger-princess, Custom). Each label **start** and **stop** is a marker.
- **Assessments** (non-exclusive: Engaged, Distracted, Rushed, Tired, Zombie,
  Fresh, Custom) are prompted at **start** and **end**, and can be added mid-session.
- **Optional baseline:** 60 s block (30 s eyes-open + 30 s eyes-closed), bounded by
  markers.
- **Metadata** (Subject ID, device serial/firmware, fit notes, posture, note, and
  optional sleep hours / caffeine) is captured at start and embedded in the
  FileHeader XML.

Marker naming: `session/start`, `session/stop`, `assessment/{start|mid|end}/<label>`,
`label/<name>/{start|stop}`, `baseline/{eyes_open|eyes_closed}/{start|stop}`,
`event/<name>`, `recording/{pause|resume}`.

## Reliability

- Samples stream to **IndexedDB in chunks** (checkpoint every 2 s or 1024 samples);
  the full session is never held in RAM. A crash mid-session keeps every
  checkpointed chunk.
- A **Screen Wake Lock** is held while recording; the UI warns that backgrounding
  the tab suspends capture.
- Controls: **start, pause/resume, stop, discard.** On BLE disconnect the session
  **auto-stops and is flagged**, then **one auto-reconnect** is attempted.

## Central cloud upload (optional)

Sessions can auto-upload to **one shared Google Drive folder** so multiple devices
collect into one place — no backend server. A small **Google Apps Script** web app
(`cloud/Code.gs`) receives each `.xdf` and saves it; the Drive credential stays
server-side (nothing secret ships in the public site). Uploads are **idempotent by
filename**, so the on-device retry can never create duplicates.

Configure `js/config.js` with your `/exec` endpoint + shared token, then upload
fires automatically on **Stop** (offline sessions stay on-device with an **Upload**
retry button; the session list shows ☁ uploaded / not uploaded / failed). Full
setup is in **`cloud/DEPLOY.md`**. Transport is covered by
`test/upload_roundtrip.mjs` (base64 byte-identity + idempotency; the round-tripped
file re-loads in pyxdf). GitHub Pages itself cannot receive uploads, which is why a
Drive collector is used rather than writing back to the repo.

## File naming & export

`subjectID_sessiontype_YYYYMMDD-HHMMSS.xdf`. The **Saved sessions** screen lists
recordings with **Download** and **Share** (Web Share API where available) plus
delete.

## Hardware caveats (please verify on a device)

EEG, IMU, markers, telemetry and timestamps have been **verified against a real
Muse recording** (loads in pyxdf; correct channels/units/rates; regular sample
timing; aligned cross-stream clock). PPG capture was fixed by switching the default
preset from `p21` to **`p50`**, and device serial/firmware parsing from the control
characteristic was hardened (unit-tested). Telemetry `temperature` reads 0 on real
firmware (Muse does not reliably expose it over BLE); battery and fuel-gauge voltage
are correct. The signal-fit indicator is a **local EEG-variance heuristic**, not
Muse's proprietary horseshoe (HSI) status. Re-confirm PPG on your own unit, since
PPG availability depends on the Muse model.

## Deploy

Serve the folder over **HTTPS** (Web Bluetooth and service workers require a secure
context; `localhost` is treated as secure for testing). Any static host works
(e.g. GitHub Pages). No build step.
