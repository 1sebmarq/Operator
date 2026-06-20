// storage.js
// Crash-safe, RAM-light session storage on IndexedDB.
//
// During recording we never hold a whole session in memory: incoming samples
// are appended to small per-stream buffers and flushed ("checkpointed") to
// IndexedDB as discrete chunk records every CHECKPOINT_MS or when a buffer fills.
// If the tab crashes mid-session, every checkpointed chunk is already durable, so
// the session can be recovered and exported. Export streams chunks back out in
// order to build the .xdf without ever materialising the full session at once.
//
// Object stores:
//   sessions: { id, meta, status, createdAt, streamDefs, counts, dropped, flagged }
//   chunks  : { key:[sessionId, streamKey, seq], sessionId, streamKey, seq, samples }
//   files   : { id:sessionId, name, blob }   (finalised .xdf blobs)

const DB_NAME = 'muse-recorder';
const DB_VERSION = 1;

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('chunks')) {
        const s = db.createObjectStore('chunks', { keyPath: ['sessionId', 'streamKey', 'seq'] });
        s.createIndex('bySession', 'sessionId', { unique: false });
      }
      if (!db.objectStoreNames.contains('files')) {
        db.createObjectStore('files', { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, stores, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    const res = fn(t);
    t.oncomplete = () => resolve(res);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export class SessionStore {
  constructor(db) {
    this.db = db;
  }
  static async open() {
    return new SessionStore(await openDb());
  }

  async createSession(session) {
    await tx(this.db, ['sessions'], 'readwrite', (t) => t.objectStore('sessions').put(session));
    return session;
  }

  async updateSession(id, patch) {
    const s = await this.getSession(id);
    const merged = { ...s, ...patch };
    await tx(this.db, ['sessions'], 'readwrite', (t) => t.objectStore('sessions').put(merged));
    return merged;
  }

  getSession(id) {
    return tx(this.db, ['sessions'], 'readonly', (t) => {
      return new Promise((resolve) => {
        const r = t.objectStore('sessions').get(id);
        r.onsuccess = () => resolve(r.result);
      });
    });
  }

  listSessions() {
    return tx(this.db, ['sessions'], 'readonly', (t) => {
      return new Promise((resolve) => {
        const r = t.objectStore('sessions').getAll();
        r.onsuccess = () => resolve((r.result || []).sort((a, b) => b.createdAt - a.createdAt));
      });
    });
  }

  // Append one chunk (a batch of samples for one stream). seq must be unique &
  // monotonically increasing per (sessionId, streamKey).
  putChunk(sessionId, streamKey, seq, samples) {
    return tx(this.db, ['chunks'], 'readwrite', (t) =>
      t.objectStore('chunks').put({ sessionId, streamKey, seq, samples })
    );
  }

  // Iterate chunks for a stream in seq order, calling cb(samples) for each.
  // Uses a cursor so the whole session is never loaded into memory at once.
  iterateChunks(sessionId, streamKey, cb) {
    return tx(this.db, ['chunks'], 'readonly', (t) => {
      return new Promise((resolve, reject) => {
        const store = t.objectStore('chunks');
        const range = IDBKeyRange.bound(
          [sessionId, streamKey, -Infinity],
          [sessionId, streamKey, Infinity]
        );
        const cur = store.openCursor(range);
        cur.onsuccess = (e) => {
          const c = e.target.result;
          if (c) {
            cb(c.value.samples);
            c.continue();
          } else {
            resolve();
          }
        };
        cur.onerror = () => reject(cur.error);
      });
    });
  }

  // Fetch a single chunk by exact key (used for time-ordered export merge).
  getChunk(sessionId, streamKey, seq) {
    return tx(this.db, ['chunks'], 'readonly', (t) => {
      return new Promise((resolve) => {
        const r = t.objectStore('chunks').get([sessionId, streamKey, seq]);
        r.onsuccess = () => resolve(r.result ? r.result.samples : null);
      });
    });
  }

  async saveFile(sessionId, name, blob) {
    await tx(this.db, ['files'], 'readwrite', (t) =>
      t.objectStore('files').put({ id: sessionId, name, blob })
    );
  }

  getFile(sessionId) {
    return tx(this.db, ['files'], 'readonly', (t) => {
      return new Promise((resolve) => {
        const r = t.objectStore('files').get(sessionId);
        r.onsuccess = () => resolve(r.result);
      });
    });
  }

  async deleteSession(sessionId) {
    // delete chunks via cursor, then session + file
    await tx(this.db, ['chunks'], 'readwrite', (t) => {
      return new Promise((resolve) => {
        const idx = t.objectStore('chunks').index('bySession');
        const cur = idx.openCursor(IDBKeyRange.only(sessionId));
        cur.onsuccess = (e) => {
          const c = e.target.result;
          if (c) {
            c.delete();
            c.continue();
          } else resolve();
        };
      });
    });
    await tx(this.db, ['sessions', 'files'], 'readwrite', (t) => {
      t.objectStore('sessions').delete(sessionId);
      t.objectStore('files').delete(sessionId);
    });
  }
}

// Buffers samples per stream and flushes to the store on a cadence. One instance
// per active recording.
export class StreamCheckpointer {
  constructor(store, sessionId, { checkpointMs = 2000, maxBuffer = 1024 } = {}) {
    this.store = store;
    this.sessionId = sessionId;
    this.checkpointMs = checkpointMs;
    this.maxBuffer = maxBuffer;
    this.buffers = {};   // streamKey -> samples[]
    this.seq = {};       // streamKey -> next chunk seq
    this.counts = {};    // streamKey -> total samples written
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.flushAll().catch(() => {}), this.checkpointMs);
  }

  add(streamKey, samples) {
    if (!samples || !samples.length) return;
    if (!this.buffers[streamKey]) {
      this.buffers[streamKey] = [];
      this.seq[streamKey] = 0;
      this.counts[streamKey] = 0;
    }
    const buf = this.buffers[streamKey];
    for (const s of samples) buf.push(s);
    if (buf.length >= this.maxBuffer) this._flush(streamKey).catch(() => {});
  }

  async _flush(streamKey) {
    const buf = this.buffers[streamKey];
    if (!buf || !buf.length) return;
    const batch = buf.splice(0, buf.length);
    const seq = this.seq[streamKey]++;
    this.counts[streamKey] += batch.length;
    await this.store.putChunk(this.sessionId, streamKey, seq, batch);
  }

  async flushAll() {
    for (const k of Object.keys(this.buffers)) await this._flush(k);
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flushAll();
  }
}
