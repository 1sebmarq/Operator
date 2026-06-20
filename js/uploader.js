// uploader.js — send a finished .xdf to the central Apps Script collector.
//
// We POST JSON as Content-Type text/plain so the browser treats it as a "simple"
// request and skips the CORS preflight (which Apps Script can't answer). The
// collector is idempotent by filename, so retrying after an unconfirmed attempt
// is always safe — at worst the server replies {status:'exists'}.
//
// The endpoint + token are passed in by the caller (app.js reads them from the
// optional, gitignored config.js) so this module has no secrets and no hard
// dependency on config.js existing.

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(fr.error);
    fr.onload = () => {
      const s = String(fr.result);
      const comma = s.indexOf(',');
      resolve(comma >= 0 ? s.slice(comma + 1) : s); // strip "data:...;base64,"
    };
    fr.readAsDataURL(blob);
  });
}

// Returns { status: 'ok'|'exists', id?, name? } on success; throws on failure.
export async function uploadBlob(endpoint, token, filename, blob, meta = {}) {
  if (!endpoint || !endpoint.startsWith('http')) {
    throw new Error('cloud upload not configured');
  }
  const dataB64 = await blobToBase64(blob);
  const body = JSON.stringify({
    token,
    filename,
    mime: 'application/octet-stream',
    dataB64,
    meta,
  });

  const res = await fetch(endpoint, {
    method: 'POST',
    // text/plain keeps this a CORS "simple request" (no preflight).
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body,
    redirect: 'follow',
  });

  // Apps Script redirects to googleusercontent, whose response carries CORS, so
  // we can usually read the JSON. If we can't (opaque), fall back to res.ok.
  let json = null;
  try { json = await res.json(); } catch (_) { /* opaque or non-JSON */ }

  if (json) {
    if (json.status === 'ok' || json.status === 'exists') return json;
    throw new Error(json.error || 'upload rejected');
  }
  if (res.ok || res.type === 'opaque' || res.type === 'opaqueredirect') {
    // Couldn't read body but request went through; treat as best-effort success.
    // The idempotent server makes a later confirming retry harmless.
    return { status: 'ok', unconfirmed: true };
  }
  throw new Error('HTTP ' + res.status);
}
// end of uploader.js
