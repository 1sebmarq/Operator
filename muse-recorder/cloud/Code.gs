/**
 * Muse Recorder — central Drive collector (Google Apps Script web app).
 *
 * Receives one .xdf session per POST and saves it into a single Drive folder, so
 * any number of devices can collect into one place. The credential (your Google
 * account, via the script's own authorization) stays server-side — nothing
 * secret is shipped in the public web app.
 *
 * Requests are sent as Content-Type: text/plain so the browser treats them as
 * "simple" requests and skips the CORS preflight that Apps Script cannot answer.
 *
 * Idempotent by filename: if a file with the same name already exists in the
 * folder, we DON'T create a duplicate — we return {status:"exists"}. This makes
 * client retries safe even if a previous attempt actually succeeded but the
 * browser couldn't read the response.
 *
 * SETUP (see cloud/DEPLOY.md):
 *   1. Set FOLDER_ID to the destination Drive folder's id.
 *   2. Set SHARED_TOKEN to a random string; put the same value in js/config.js.
 *   3. Deploy > New deployment > Web app > Execute as: Me,
 *      Who has access: Anyone. Copy the /exec URL into js/config.js.
 */

// ====== CONFIG ======
var FOLDER_ID = 'PASTE_DRIVE_FOLDER_ID_HERE';
var SHARED_TOKEN = 'change-me-to-a-long-random-string';
var MAX_BYTES = 45 * 1024 * 1024; // ~45 MB safety cap per session
// ====================

function _json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function doGet() {
  // Health check / sanity ping.
  return _json({ status: 'ready', service: 'muse-recorder-collector' });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return _json({ status: 'error', error: 'no body' });
    }
    var req;
    try {
      req = JSON.parse(e.postData.contents);
    } catch (err) {
      return _json({ status: 'error', error: 'bad json' });
    }

    if (!req.token || req.token !== SHARED_TOKEN) {
      return _json({ status: 'error', error: 'unauthorized' });
    }
    var name = (req.filename || '').replace(/[^A-Za-z0-9._-]/g, '_');
    if (!name) return _json({ status: 'error', error: 'no filename' });
    if (!req.dataB64) return _json({ status: 'error', error: 'no data' });

    var folder = DriveApp.getFolderById(FOLDER_ID);

    // Idempotency: skip if this filename already landed.
    var existing = folder.getFilesByName(name);
    if (existing.hasNext()) {
      var f0 = existing.next();
      return _json({ status: 'exists', id: f0.getId(), name: name });
    }

    var bytes = Utilities.base64Decode(req.dataB64);
    if (bytes.length > MAX_BYTES) {
      return _json({ status: 'error', error: 'too large', bytes: bytes.length });
    }
    var blob = Utilities.newBlob(bytes, req.mime || 'application/octet-stream', name);
    var file = folder.createFile(blob);

    // Optionally stash session metadata alongside as a sidecar .json.
    if (req.meta) {
      try {
        folder.createFile(Utilities.newBlob(
          JSON.stringify(req.meta, null, 2), 'application/json', name + '.meta.json'));
      } catch (err) { /* non-fatal */ }
    }

    return _json({ status: 'ok', id: file.getId(), name: name, bytes: bytes.length });
  } catch (err) {
    return _json({ status: 'error', error: String(err) });
  }
}
