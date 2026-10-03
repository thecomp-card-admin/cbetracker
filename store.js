// store.js — IndexedDB persistence. Everything stays on this device.
const DB_NAME = 'cbe-tracker';
const DB_VERSION = 1;
const KV_KEYS = ['settings', 'routine', 'events', 'meta', 'draft'];
let dbp = null;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('sessions')) db.createObjectStore('sessions', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('Database blocked by another tab'));
    });
  }
  return dbp;
}

const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const txDone = (t) => new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('aborted')); });

export async function kvGet(key) {
  const db = await open();
  return reqP(db.transaction('kv').objectStore('kv').get(key));
}

export async function kvSet(key, value) {
  const db = await open();
  const t = db.transaction('kv', 'readwrite');
  if (value === null || value === undefined) t.objectStore('kv').delete(key);
  else t.objectStore('kv').put(value, key);
  return txDone(t);
}

export async function putSession(s) {
  const db = await open();
  const t = db.transaction('sessions', 'readwrite');
  t.objectStore('sessions').put(s);
  return txDone(t);
}

export async function deleteSession(id) {
  const db = await open();
  const t = db.transaction('sessions', 'readwrite');
  t.objectStore('sessions').delete(id);
  return txDone(t);
}

export async function loadAll() {
  const db = await open();
  const t = db.transaction(['kv', 'sessions']);
  const kv = t.objectStore('kv');
  const vals = await Promise.all(KV_KEYS.map((k) => reqP(kv.get(k))));
  const sessions = await reqP(t.objectStore('sessions').getAll());
  const out = { sessions: sessions || [] };
  KV_KEYS.forEach((k, i) => { out[k] = vals[i]; });
  return out;
}

/** Replace everything (import / reset) in one transaction. */
export async function replaceAll(data) {
  const db = await open();
  const t = db.transaction(['kv', 'sessions'], 'readwrite');
  const kv = t.objectStore('kv');
  const ss = t.objectStore('sessions');
  kv.clear();
  ss.clear();
  KV_KEYS.forEach((k) => { if (data[k] !== undefined && data[k] !== null) kv.put(data[k], k); });
  (data.sessions || []).forEach((s) => ss.put(s));
  return txDone(t);
}

export async function persistStatus() {
  try {
    if (!navigator.storage || !navigator.storage.persisted) return 'unsupported';
    return (await navigator.storage.persisted()) ? 'persistent' : 'best-effort';
  } catch { return 'unknown'; }
}

export async function requestPersist() {
  try {
    if (!navigator.storage || !navigator.storage.persist) return 'unsupported';
    return (await navigator.storage.persist()) ? 'persistent' : 'best-effort';
  } catch { return 'unknown'; }
}
