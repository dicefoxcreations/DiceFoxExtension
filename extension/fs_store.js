/* File System Access store.
   Replaces chrome.downloads: the user picks one library folder, the handle is
   kept in IndexedDB and reader/export files are written below it.

   Runs in document contexts only (extension pages and the offscreen document).
   The service worker never touches the file system directly; it hands blobs to
   the offscreen writer through the pending-write queue in lwl_idb.js. */
(() => {
  "use strict";

  const ROOT_KEY = "root";

  function splitPath(path) {
    return String(path || "")
      .replace(/\\/g, "/")
      .split("/")
      .map(s => s.trim())
      .filter(s => s && s !== "." && s !== "..");
  }

  async function storedRoot() {
    return (await LWLIdb.getHandle(ROOT_KEY)) || null;
  }

  /* showDirectoryPicker needs a user gesture and a real window; it is called
     from runner.html only, never from the offscreen document. */
  async function pickRoot() {
    const handle = await self.showDirectoryPicker({ id: "lwl-library", mode: "readwrite", startIn: "documents" });
    await LWLIdb.putHandle(ROOT_KEY, handle);
    return handle;
  }

  async function forgetRoot() {
    await LWLIdb.deleteHandle(ROOT_KEY);
  }

  async function permissionState(handle, request = false) {
    if (!handle?.queryPermission) return "granted";
    const opts = { mode: "readwrite" };
    let state = await handle.queryPermission(opts);
    if (state !== "granted" && request) state = await handle.requestPermission(opts);
    return state;
  }

  /* { ok, reason, handle } – reason is "no-folder" or "no-permission" so the
     caller can show the right button instead of a generic error. */
  async function root({ request = false } = {}) {
    const handle = await storedRoot();
    if (!handle) return { ok: false, reason: "no-folder", handle: null };
    let state;
    try {
      state = await permissionState(handle, request);
    } catch (e) {
      return { ok: false, reason: "no-permission", handle, error: String(e.message || e) };
    }
    if (state !== "granted") return { ok: false, reason: "no-permission", handle };
    return { ok: true, reason: null, handle };
  }

  async function directoryFor(segments, { create = false, handle = null } = {}) {
    const r = handle ? { ok: await permissionState(handle) === "granted", handle, reason: "no-permission" } : await root({ request: false });
    if (!r.ok) throw new Error(r.reason === "no-folder" ? "No library folder selected" : "No permission for the library folder");
    let dir = r.handle;
    for (const segment of segments) dir = await dir.getDirectoryHandle(segment, { create });
    return dir;
  }

  async function write(path, blob, handle = null) {
    const parts = splitPath(path);
    if (!parts.length) throw new Error(`Invalid file path: ${path}`);
    const name = parts.pop();
    const dir = await directoryFor(parts, { create: true, handle });
    const file = await dir.getFileHandle(name, { create: true });
    const stream = await file.createWritable();
    try {
      await stream.write(blob);
      await stream.close();
    } catch (error) {
      await stream.abort().catch(() => {});
      throw error;
    }
    return { path: parts.concat(name).join("/"), bytes: blob.size ?? 0 };
  }

  async function stat(path) {
    const parts = splitPath(path);
    if (!parts.length) return null;
    const name = parts.pop();
    try {
      const dir = await directoryFor(parts, { create: false });
      const file = await (await dir.getFileHandle(name, { create: false })).getFile();
      return { name, bytes: file.size, modifiedAt: new Date(file.lastModified).toISOString() };
    } catch {
      return null;
    }
  }

  async function exists(path) {
    return Boolean(await stat(path));
  }

  async function readText(path) {
    return (await readFile(path)).text();
  }

  async function readFile(path) {
    const parts = splitPath(path);
    const name = parts.pop();
    const dir = await directoryFor(parts, { create: false });
    return await (await dir.getFileHandle(name, { create: false })).getFile();
  }

  function checkedSegments(path = []) {
    const parts = Array.isArray(path) ? path : String(path).split("/").filter(Boolean);
    if (parts.some(p => typeof p !== "string" || !p || p === "." || p === ".." || /[\\/\x00]/.test(p))) throw new Error("Invalid folder path");
    return parts;
  }

  async function listDirectory(path = []) {
    const parts = checkedSegments(path), dir = await directoryFor(parts), entries = [];
    for await (const entry of dir.values()) {
      const row = { name: entry.name, kind: entry.kind };
      if (entry.kind === "file") {
        try { const file = await entry.getFile(); row.bytes = file.size; row.modifiedAt = file.lastModified; }
        catch { row.unavailable = true; }
      }
      entries.push(row);
      if (entries.length >= 10000) return { path: parts, entries, complete: false };
    }
    entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));
    return { path: parts, entries, complete: true };
  }

  async function measureDirectory(path = []) {
    const start = await directoryFor(checkedSegments(path));
    const stack = [start]; let bytes = 0, files = 0, folders = 0, unavailable = 0;
    const deadline = Date.now() + 20000;
    while (stack.length) {
      const dir = stack.pop();
      for await (const entry of dir.values()) {
        if (files + folders >= 50000 || Date.now() > deadline) return { bytes, files, folders, unavailable, complete: false };
        if (entry.kind === "directory") { folders++; stack.push(entry); }
        else { files++; try { bytes += (await entry.getFile()).size; } catch { unavailable++; } }
      }
    }
    return { bytes, files, folders, unavailable, complete: unavailable === 0 };
  }

  async function remove(path) {
    const parts = splitPath(path);
    if (!parts.length) return false;
    const name = parts.pop();
    try {
      const dir = await directoryFor(parts, { create: false });
      await dir.removeEntry(name, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }
  async function removeFile(path) {
    const parts = checkedSegments(path), name = parts.pop();
    if (!name) return false;
    const dir = await directoryFor(parts);
    await dir.removeEntry(name); // never remove a directory tree during cleanup
    return true;
  }

  /* Writes and reads back a probe file. The offscreen document runs this once
     after a folder is picked, so a context that cannot write is reported at
     setup rather than in the middle of a long crawl. */
  async function selfTest() {
    const path = ".lwl-store-check.json";
    const stamp = new Date().toISOString();
    await write(path, new Blob([JSON.stringify({ writtenAt: stamp })], { type: "application/json" }));
    const text = await readText(path);
    if (!text.includes(stamp)) throw new Error("Probe file read back with unexpected content");
    return true;
  }

  globalThis.LWLStore = Object.freeze({
    splitPath, pickRoot, forgetRoot, storedRoot, root, write, stat, exists, readText, readFile, remove, selfTest,
    checkedSegments, listDirectory, measureDirectory, removeFile
  });
})();
