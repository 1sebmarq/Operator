// uploader_test.mjs
// Exercises the REAL js/uploader.js (after the config-decoupling refactor) with a
// mocked fetch + FileReader, so we cover: correct request shape, base64 fidelity,
// success parsing, and the "not configured" guard. No network, no config.js.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { uploadBlob } from '../js/uploader.js';

const here = dirname(fileURLToPath(import.meta.url));
let fails = 0;
const expect = (c, m) => { console.log(`[${c ? 'PASS' : 'FAIL'}] ${m}`); if (!c) fails++; };

// --- minimal FileReader polyfill (Node has Blob but not FileReader) ---
globalThis.FileReader = class {
  readAsDataURL(blob) {
    blob.arrayBuffer().then((ab) => {
      const b64 = Buffer.from(ab).toString('base64');
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${b64}`;
      this.onload && this.onload();
    }).catch((e) => { this.error = e; this.onerror && this.onerror(); });
  }
};

// --- mock fetch that plays the Apps Script server (idempotent by filename) ---
const folder = new Set();
let lastBody = null;
globalThis.fetch = async (url, opts) => {
  lastBody = JSON.parse(opts.body);
  if (opts.headers['Content-Type'] !== 'text/plain;charset=utf-8') {
    return { ok: false, status: 400, type: 'basic', json: async () => ({ status: 'error', error: 'preflight would trigger' }) };
  }
  if (lastBody.token !== 'tok') return { ok: true, type: 'basic', json: async () => ({ status: 'error', error: 'unauthorized' }) };
  const bytes = Buffer.from(lastBody.dataB64, 'base64');
  if (folder.has(lastBody.filename)) return { ok: true, type: 'basic', json: async () => ({ status: 'exists', name: lastBody.filename }) };
  folder.add(lastBody.filename);
  globalThis.__decoded = bytes;
  return { ok: true, type: 'basic', json: async () => ({ status: 'ok', name: lastBody.filename, bytes: bytes.length }) };
};

const fileBytes = readFileSync(join(here, 'session_synth.xdf'));
const blob = new Blob([fileBytes], { type: 'application/octet-stream' });

// 1. guard: not configured
let threw = false;
try { await uploadBlob('', 'tok', 'x.xdf', blob); } catch (_) { threw = true; }
expect(threw, 'empty endpoint throws "not configured"');

// 2. happy path
const r1 = await uploadBlob('https://script/exec', 'tok', 'S001_record.xdf', blob, { subjectId: 'S001' });
expect(r1.status === 'ok', 'configured upload returns ok');
expect(lastBody.token === 'tok', 'token included in request body');
expect(lastBody.meta && lastBody.meta.subjectId === 'S001', 'metadata included');
expect(Buffer.compare(globalThis.__decoded, fileBytes) === 0, 'server-decoded bytes identical to source');

// 3. idempotent retry
const r2 = await uploadBlob('https://script/exec', 'tok', 'S001_record.xdf', blob);
expect(r2.status === 'exists', 'retry of same filename returns exists');

// 4. bad token surfaces as error
let threw2 = false;
try { await uploadBlob('https://script/exec', 'WRONG', 'y.xdf', blob); } catch (_) { threw2 = true; }
expect(threw2, 'wrong token rejected');

console.log(fails ? `\n${fails} FAIL` : '\nALL PASS — real uploader.js verified (request shape, base64, idempotency, guards)');
process.exit(fails ? 1 : 0);
