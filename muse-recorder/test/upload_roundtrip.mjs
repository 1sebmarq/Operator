// upload_roundtrip.mjs
// Simulates the full client->Apps Script transport for a session file WITHOUT a
// network: base64-encode the .xdf exactly as the browser uploader does, build the
// same JSON body, then replay the server side (token check + base64 decode +
// write) and confirm the bytes are byte-identical. A second pass proves the
// idempotency contract (same filename => "exists", no duplicate).
//
// Run: node test/upload_roundtrip.mjs  (then validate_xdf.py can load the result)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, 'session_synth.xdf');
const OUT = join(here, 'uploaded_copy.xdf');
const TOKEN = 'test-token-123';

// ---- client side (mirrors js/uploader.js base64 + body) ----
const original = readFileSync(SRC);
const dataB64 = original.toString('base64'); // FileReader.readAsDataURL yields the same base64
const body = JSON.stringify({
  token: TOKEN,
  filename: 'S001_record_20260620-112513.xdf',
  mime: 'application/octet-stream',
  dataB64,
  meta: { subjectId: 'S001', durationSec: 6 },
});

// ---- server side (mirrors cloud/Code.gs doPost) ----
const folder = new Map(); // filename -> bytes  (stands in for the Drive folder)
function doPost(rawBody, SHARED_TOKEN) {
  let req;
  try { req = JSON.parse(rawBody); } catch { return { status: 'error', error: 'bad json' }; }
  if (!req.token || req.token !== SHARED_TOKEN) return { status: 'error', error: 'unauthorized' };
  const name = (req.filename || '').replace(/[^A-Za-z0-9._-]/g, '_');
  if (!name) return { status: 'error', error: 'no filename' };
  if (folder.has(name)) return { status: 'exists', name }; // idempotent
  const bytes = Buffer.from(req.dataB64, 'base64');
  folder.set(name, bytes);
  return { status: 'ok', name, bytes: bytes.length };
}

let fails = 0;
const expect = (cond, msg) => { console.log(`[${cond ? 'PASS' : 'FAIL'}] ${msg}`); if (!cond) fails++; };

// 1. wrong token rejected
expect(doPost(body, 'WRONG').status === 'error', 'bad token is rejected');

// 2. first upload stored ok
const r1 = doPost(body, TOKEN);
expect(r1.status === 'ok', 'first upload returns ok');

// 3. bytes are byte-identical after base64 round-trip
const stored = folder.get('S001_record_20260620-112513.xdf');
writeFileSync(OUT, stored);
expect(stored.length === original.length, `byte length preserved (${stored.length})`);
expect(Buffer.compare(stored, original) === 0, 'decoded bytes identical to source');

// 4. retry of the SAME filename is idempotent (no duplicate)
const r2 = doPost(body, TOKEN);
expect(r2.status === 'exists', 'retry returns exists (idempotent, no duplicate)');
expect(folder.size === 1, 'folder still holds exactly 1 file');

console.log(fails ? `\n${fails} FAIL` : '\nALL PASS — transport round-trip + idempotency verified');
process.exit(fails ? 1 : 0);
