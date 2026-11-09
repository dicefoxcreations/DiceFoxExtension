/* Shared IndexedDB layer.

   Durable folder handles, temporary writes and reusable resource blobs:

   handles – the FileSystemDirectoryHandle of the library folder. Handles are
     structured-cloneable, so they survive a browser restart here; only the
     read/write permission may need one confirming click afterwards.

   writes – the pending-write queue. Extension messages are JSON-serialised, so
     a Blob cannot be passed from the service worker to the offscreen writer
     directly. The worker parks the blob here, the offscreen document picks it
     up and writes it to disk. The queue therefore doubles as crash safety: a
     write that was in flight when the worker was killed is still on disk-bound
     storage and gets flushed on the next start. */
(() => {
  "use strict";

  const DB_NAME = "lwl-store";
  const DB_VERSION = 2;
  const HANDLES = "handles";
  const WRITES = "writes";

  let dbPromise = null;

  function open() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(HANDLES)) db.createObjectStore(HANDLES);
        if (!db.objectStoreNames.contains(WRITES)) db.createObjectStore(WRITES, { keyPath: "id", autoIncrement: true });
        if (!db.objectStoreNames.contains("resources")) db.createObjectStore("resources");
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  function run(store, mode, fn) {
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(store, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
      const request = fn(tx.objectStore(store));
      if (request) request.onsuccess = () => { result = request.result; };
    }));
  }

  const getHandle = key => run(HANDLES, "readonly", s => s.get(key));
  const putHandle = (key, handle) => run(HANDLES, "readwrite", s => s.put(handle, key));
  const deleteHandle = key => run(HANDLES, "readwrite", s => s.delete(key));

  /* Returns the queue id so the caller can await exactly this write. */
  const enqueueWrite = async (path, blob, profileId = null) => {
    const folder = await getHandle("root");
    return run(WRITES, "readwrite", s => s.add({ path: String(path), blob, profileId, folder, createdAt: Date.now() }));
  };

  const takeWrite = id => run(WRITES, "readonly", s => s.get(id));
  const dropWrite = id => run(WRITES, "readwrite", s => s.delete(id));
  const pendingWrites = () => writeEntries();
  const clearWrites = () => run(WRITES, "readwrite", s => s.clear());
  const putResource = (profileId,url,blob) => run("resources","readwrite",s=>s.put(blob,`${profileId}\u0000${url}`));
  const getResource = (profileId,url) => run("resources","readonly",s=>s.get(`${profileId}\u0000${url}`));
  const clearResources = profileId => run("resources","readwrite",s=>s.delete(IDBKeyRange.bound(`${profileId}\u0000`,`${profileId}\u0001`,false,true)));

  // Read only metadata into memory. Blob payloads never become an array of bytes.
  function scan(store, project) {
    return open().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(store, "readonly"), result = [];
      const request = tx.objectStore(store).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        result.push(project(cursor.key, cursor.value));
        cursor.continue();
      };
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    }));
  }
  const resourceEntries = () => scan("resources", (key, blob) => {
    const split = String(key).indexOf("\u0000");
    return { key, profileId: String(key).slice(0, split), url: String(key).slice(split + 1), bytes: blob.size || 0, type: blob.type || "" };
  });
  const writeEntries = () => scan(WRITES, (id, row) => ({
    id, profileId: row.profileId || null, path: row.path, bytes: row.blob?.size || 0,
    createdAt: row.createdAt, folderName: row.folder?.name || null
  }));
  const deleteResources = keys => run("resources", "readwrite", s => { for (const key of keys) s.delete(key); });
  const deleteWrites = ids => run(WRITES, "readwrite", s => { for (const id of ids) s.delete(id); });

  globalThis.LWLIdb = Object.freeze({
    getHandle, putHandle, deleteHandle,
    enqueueWrite, takeWrite, dropWrite, pendingWrites, clearWrites,
    putResource, getResource, clearResources,
    resourceEntries, writeEntries, deleteResources, deleteWrites
  });
})();
