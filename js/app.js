// app.js — UI controller for the Muse Recorder PWA.
import { MuseClient } from './muse.js';
import { Recorder } from './recorder.js';
import { ACTIVITY_LABELS, ASSESSMENT_LABELS } from './streams.js';

const $ = (id) => document.getElementById(id);
const fmtTime = (s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const state = {
  client: new MuseClient(),
  recorder: null,
  connected: false,
  sessionType: 'record',
  baseline: false,
  activeLabels: new Set(),
  customLabels: [],
  startAssessment: new Set(),
  startTime: 0,
  timerId: null,
  fit: {},
};

// ---- navigation ----------------------------------------------------------
function show(screen) {
  document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${screen}`));
  window.scrollTo(0, 0);
}
let backTarget = 'home';
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => show(backTarget)));

function toast(msg, ms = 2600) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}

// ---- connection UI -------------------------------------------------------
function setConn(status, text) {
  const dot = $('connDot');
  dot.className = 'dot' + (status === 'on' ? ' on' : status === 'warn' ? ' warn' : '');
  $('connText').textContent = text;
}

function renderFit(rowEl) {
  rowEl.innerHTML = '';
  const labels = Object.keys(state.fit);
  if (!labels.length) { rowEl.innerHTML = '<span class="muted small">waiting for signal…</span>'; return; }
  for (const label of labels) {
    const f = state.fit[label];
    const pill = document.createElement('span');
    pill.className = 'pill';
    pill.innerHTML = `<span class="q ${f.quality}"></span>${label}`;
    rowEl.appendChild(pill);
  }
}

function setBattery(pct) {
  if (pct == null || isNaN(pct)) return;
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  $('battWrap').hidden = false;
  $('battText').textContent = `${p}%`;
  $('battFill').style.setProperty('--batt', `${p}%`);
  $('battFill').style.background = p < 20 ? 'var(--bad)' : p < 40 ? 'var(--ok)' : 'var(--good)';
}

// ---- client events -------------------------------------------------------
function wireClient() {
  const c = state.client;
  c.addEventListener('connected', (e) => {
    state.connected = true;
    setConn('on', e.detail.device || 'Connected');
    $('fitCard').hidden = false;
    $('btnRecord').disabled = false;
    $('btnActivity').disabled = false;
    $('btnConnect').textContent = 'Reconnect / change device';
    toast('Headband connected');
  });
  c.addEventListener('disconnected', () => {
    state.connected = false;
    setConn('off', 'Disconnected');
    if (!state.recorder || !state.recorder.recording) {
      $('btnRecord').disabled = true;
      $('btnActivity').disabled = true;
    }
  });
  c.addEventListener('info', (e) => {
    if (e.detail && e.detail.serial && e.detail.serial !== 'unknown') {
      setConn('on', `${e.detail.deviceType} · ${e.detail.serial}`);
    }
  });
  c.addEventListener('telemetry', (e) => setBattery(e.detail.battery));
  c.addEventListener('fit', (e) => {
    state.fit[e.detail.label] = e.detail;
    renderFit($('fitCard').hidden ? $('liveFitRow') : $('fitRow'));
    if (state.recorder && state.recorder.recording) renderFit($('liveFitRow'));
  });
}

$('btnConnect').addEventListener('click', async () => {
  if (!MuseClient.isSupported()) {
    toast('Web Bluetooth unavailable. Use Chrome (Android) or Bluefy (iOS).');
    return;
  }
  setConn('warn', 'Connecting…');
  try {
    await state.client.connect({ includeAux: $('auxToggle').checked });
  } catch (err) {
    setConn('off', 'Disconnected');
    toast('Connection cancelled or failed.');
  }
});

// ---- chips helpers -------------------------------------------------------
function buildChips(container, items, selectedSet, { multi = true } = {}) {
  container.innerHTML = '';
  items.forEach((item) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chip' + (selectedSet && selectedSet.has(item) ? ' active' : '');
    chip.textContent = item;
    chip.addEventListener('click', () => {
      if (!selectedSet) return;
      if (multi) {
        selectedSet.has(item) ? selectedSet.delete(item) : selectedSet.add(item);
      } else {
        selectedSet.clear(); selectedSet.add(item);
      }
      chip.classList.toggle('active');
      container._onToggle && container._onToggle(item, selectedSet.has(item));
    });
    container.appendChild(chip);
  });
}

// ---- start a session -----------------------------------------------------
function openSetup(type) {
  state.sessionType = type;
  state.startAssessment = new Set();
  $('setupTitle').textContent = type === 'activity' ? 'New Activity Session' : 'New Record Session';
  backTarget = 'home';
  buildChips($('startAssessChips'), ASSESSMENT_LABELS, state.startAssessment, { multi: true });
  $('baselineToggle').checked = false;
  show('setup');
}
$('btnRecord').addEventListener('click', () => openSetup('record'));
$('btnActivity').addEventListener('click', () => openSetup('activity'));
$('btnSessions').addEventListener('click', () => { backTarget = 'home'; renderSessions(); show('sessions'); });

$('setupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!state.connected) { toast('Connect the headband first.'); return; }
  const fd = new FormData(e.target);
  const meta = {
    subjectId: fd.get('subjectId').trim(),
    sessionType: state.sessionType,
    posture: fd.get('posture'),
    sleepHours: fd.get('sleepHours'),
    caffeine: fd.get('caffeine'),
    fitNotes: fd.get('fitNotes'),
    note: fd.get('note'),
    deviceType: state.client.deviceInfo.deviceType,
    serial: state.client.deviceInfo.serial,
    firmware: state.client.deviceInfo.firmware,
  };
  const custom = $('startAssessCustom').value.trim();
  if (custom) state.startAssessment.add(custom);

  state.recorder = await Recorder.create(state.client);
  wireRecorder(state.recorder);
  await state.recorder.start(meta, { includeAux: $('auxToggle').checked });

  // start-of-session assessments
  for (const a of state.startAssessment) state.recorder.assessment('start', a);

  enterLive(meta);

  // optional baseline
  if ($('baselineToggle').checked) await runBaseline();
});

// ---- live screen ---------------------------------------------------------
function enterLive(meta) {
  state.activeLabels = new Set();
  state.customLabels = [];
  $('liveName').textContent = `${meta.subjectId} · ${meta.sessionType}`;
  $('liveFlag').hidden = true;
  $('markerList').innerHTML = '';
  $('bgWarn').hidden = true;
  $('btnPause').textContent = 'Pause';
  $('activityPanel').hidden = state.sessionType !== 'activity';
  if (state.sessionType === 'activity') renderActivityChips();
  renderFit($('liveFitRow'));
  state.startTime = performance.now();
  startTimer();
  show('live');
}

function startTimer() {
  stopTimer();
  state.timerId = setInterval(() => {
    if (state.recorder && state.recorder.paused) return;
    const s = (performance.now() - state.startTime) / 1000;
    $('timer').textContent = fmtTime(s);
    const d = state.client.dropped;
    $('dropRow').textContent = `dropped — EEG ${d.EEG} · PPG ${d.PPG} · ACC ${d.ACC} · GYRO ${d.GYRO}`;
  }, 500);
}
function stopTimer() { if (state.timerId) clearInterval(state.timerId); state.timerId = null; }

function renderActivityChips() {
  const items = [...ACTIVITY_LABELS, ...state.customLabels];
  const c = $('activityChips');
  buildChips(c, items, state.activeLabels, { multi: true });
  c._onToggle = (label, active) => {
    active ? state.recorder.labelStart(label) : state.recorder.labelStop(label);
    toast(`${label} ${active ? 'started' : 'stopped'}`);
  };
}
$('btnAddCustomLabel').addEventListener('click', () => {
  const v = $('customLabelInput').value.trim();
  if (!v) return;
  state.customLabels.push(v);
  $('customLabelInput').value = '';
  renderActivityChips();
});

function pushMarkerRow(t, value) {
  const li = document.createElement('li');
  const rel = state.recorder ? Math.max(0, (performance.now() - state.startTime) / 1000) : 0;
  li.innerHTML = `<span>${value}</span><span class="mt">${fmtTime(rel)}</span>`;
  $('markerList').prepend(li);
}

// ---- assessment / marker bottom sheet ------------------------------------
let sheetCtx = null;
function openSheet({ title, items, onConfirm }) {
  sheetCtx = { selected: new Set(), onConfirm };
  $('sheetTitle').textContent = title;
  $('sheetCustom').value = '';
  buildChips($('sheetChips'), items, sheetCtx.selected, { multi: true });
  $('sheetBackdrop').hidden = false;
}
function closeSheet() { $('sheetBackdrop').hidden = true; sheetCtx = null; }
$('sheetCancel').addEventListener('click', closeSheet);
$('sheetBackdrop').addEventListener('click', (e) => { if (e.target.id === 'sheetBackdrop') closeSheet(); });
$('sheetConfirm').addEventListener('click', () => {
  if (!sheetCtx) return;
  const custom = $('sheetCustom').value.trim();
  if (custom) sheetCtx.selected.add(custom);
  sheetCtx.onConfirm([...sheetCtx.selected]);
  closeSheet();
});

$('btnAssess').addEventListener('click', () => {
  openSheet({
    title: 'Log assessment',
    items: ASSESSMENT_LABELS,
    onConfirm: (vals) => { vals.forEach((v) => state.recorder.assessment('mid', v)); if (vals.length) toast('Assessment logged'); },
  });
});
$('btnMark').addEventListener('click', () => {
  openSheet({
    title: 'Add marker',
    items: ['Note', 'Artifact', 'Blink', 'Movement', 'Event'],
    onConfirm: (vals) => { vals.forEach((v) => state.recorder.event(v)); if (vals.length) toast('Marker added'); },
  });
});

// ---- controls ------------------------------------------------------------
$('btnPause').addEventListener('click', () => {
  if (!state.recorder) return;
  if (state.recorder.paused) { state.recorder.resume(); $('btnPause').textContent = 'Pause'; }
  else { state.recorder.pause(); $('btnPause').textContent = 'Resume'; }
});

$('btnStop').addEventListener('click', async () => {
  if (!state.recorder) return;
  await endOfSessionAssessment();
  $('btnStop').disabled = true;
  await state.recorder.stop();
  $('btnStop').disabled = false;
  stopTimer();
  toast('Session saved');
  backTarget = 'home';
  renderSessions();
  show('sessions');
});

$('btnDiscard').addEventListener('click', async () => {
  if (!state.recorder) return;
  if (!confirm('Discard this session? Recorded data will be deleted.')) return;
  await state.recorder.discard();
  stopTimer();
  toast('Session discarded');
  show('home');
});

function endOfSessionAssessment() {
  return new Promise((resolve) => {
    openSheet({
      title: 'End-of-session assessment',
      items: ASSESSMENT_LABELS,
      onConfirm: (vals) => { vals.forEach((v) => state.recorder.assessment('end', v)); resolve(); },
    });
    // if cancelled, still resolve
    const cancel = $('sheetCancel');
    const orig = cancel.onclick;
    cancel.addEventListener('click', function once() { cancel.removeEventListener('click', once); resolve(); }, { once: true });
  });
}

// ---- baseline ------------------------------------------------------------
async function runBaseline() {
  const banner = $('baselineBanner');
  banner.hidden = false;
  await state.recorder.runBaseline({
    onPhase: (name, secs) => {
      if (name === 'done') { banner.hidden = true; toast('Baseline complete'); return; }
      banner.textContent = name === 'eyes_open' ? `Baseline: eyes OPEN — ${secs}s` : `Baseline: eyes CLOSED — ${secs}s`;
      let remain = secs;
      const id = setInterval(() => {
        remain--;
        if (remain <= 0) { clearInterval(id); return; }
        banner.textContent = `${name === 'eyes_open' ? 'Eyes OPEN' : 'Eyes CLOSED'} — ${remain}s`;
      }, 1000);
    },
  });
}

// ---- recorder events -----------------------------------------------------
function wireRecorder(r) {
  r.addEventListener('marker-added', (e) => pushMarkerRow(e.detail.t, e.detail.value));
  r.addEventListener('backgrounded', () => { $('bgWarn').hidden = false; });
  r.addEventListener('wakelock-unavailable', () => toast('Screen wake lock unavailable — keep the screen on.'));
  r.addEventListener('disconnect-detected', () => { $('liveFlag').hidden = false; toast('Headband disconnected — session stopped & flagged.'); });
  r.addEventListener('reconnecting', () => setConn('warn', 'Reconnecting…'));
  r.addEventListener('reconnected', () => { setConn('on', 'Reconnected'); toast('Reconnected. Start a new session to continue.'); });
  r.addEventListener('reconnect-failed', () => { setConn('off', 'Disconnected'); toast('Auto-reconnect failed.'); });
  r.addEventListener('stopped', () => { stopTimer(); });
}

// ---- sessions list -------------------------------------------------------
async function renderSessions() {
  const store = state.recorder ? state.recorder.store : (await Recorder.create(state.client)).store;
  const sessions = await store.listSessions();
  const list = $('sessionList');
  list.innerHTML = '';
  $('sessionsEmpty').hidden = sessions.length > 0;
  for (const s of sessions) {
    const li = document.createElement('li');
    const dur = s.endedAt ? Math.round((s.endedAt - s.createdAt) / 1000) : 0;
    const counts = s.counts || {};
    li.innerHTML = `
      <div class="fn">${s.filename}${s.flagged ? '<span class="badge flag">flagged</span>' : ''}${s.exported ? '' : '<span class="badge">no file</span>'}</div>
      <div class="meta2">${new Date(s.createdAt).toLocaleString()} · ${fmtTime(dur)} · EEG ${counts.EEG || 0} · markers ${s.markerCount || 0}</div>
      <div class="acts"></div>`;
    const acts = li.querySelector('.acts');
    const dl = document.createElement('button'); dl.className = 'btn small'; dl.textContent = 'Download';
    dl.addEventListener('click', () => downloadSession(store, s));
    const sh = document.createElement('button'); sh.className = 'btn small'; sh.textContent = 'Share';
    sh.addEventListener('click', () => shareSession(store, s));
    const del = document.createElement('button'); del.className = 'btn small ghost'; del.textContent = 'Delete';
    del.addEventListener('click', async () => { if (confirm('Delete this session?')) { await store.deleteSession(s.id); renderSessions(); } });
    acts.append(dl, sh, del);
    list.appendChild(li);
  }
}

async function getBlob(store, s) {
  const f = await store.getFile(s.id);
  if (f) return f.blob;
  // fallback: rebuild from chunks
  const r = state.recorder || (await Recorder.create(state.client));
  return r.export(s.id);
}

async function downloadSession(store, s) {
  const blob = await getBlob(store, s);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = s.filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function shareSession(store, s) {
  const blob = await getBlob(store, s);
  const file = new File([blob], s.filename, { type: 'application/octet-stream' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: s.filename }); } catch (_) {}
  } else {
    toast('Sharing unsupported — using download.');
    downloadSession(store, s);
  }
}

// ---- boot ----------------------------------------------------------------
function boot() {
  wireClient();
  $('supportNote').textContent = MuseClient.isSupported()
    ? 'Connect over Bluetooth. Data is stored only on this device.'
    : 'Web Bluetooth not detected. On iOS open this in Bluefy; on Android use Chrome.';
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  // warn before unload while recording
  window.addEventListener('beforeunload', (e) => {
    if (state.recorder && state.recorder.recording) { e.preventDefault(); e.returnValue = ''; }
  });
}
boot();
