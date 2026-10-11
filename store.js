// Vault persistence in IndexedDB. Records hold the cut-out PNG blob plus layout
// fields: { id, blob, nw, nh, wFrac, xc, floorOff, z }. The vertical position is
// never stored: items always rest on the floor.

const DB_NAME = "nukki-vault";
const STORE = "items";

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const out = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); resolve(out && out.result); };
    tx.onerror = tx.onabort = () => { db.close(); reject(tx.error); };
  });
}

export const getAll = () => run("readonly", (s) => s.getAll());
export const put = (rec) => run("readwrite", (s) => s.put(rec));
export const remove = (id) => run("readwrite", (s) => s.delete(id));
