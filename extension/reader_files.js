/* Deletes only tracked, unchanged files belonging to a completed Reader build. */
(() => {
  "use strict";
  const MANIFEST = ".lwl-reader-files.json";
  const managedPath = path => /^(?:index\.html|(?:app|model|catalog|presentation|references)\.js|app\.css|capture-report\.json|data\/(?:index|fts|content-\d+|(?:site|catalog)-[a-f0-9]{8,64}|previews-[a-f0-9]{8,64}-\d+)\.js|assets\/[a-f0-9]{8,64}\.[a-z0-9]{2,5})$/.test(path);
  const validFile = file => file && managedPath(file.path) && Number.isSafeInteger(file.bytes) && file.bytes >= 0 && /^[a-f0-9]{64}$/.test(file.sha256);
  const digest = async blob => [...new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))].map(n => n.toString(16).padStart(2, "0")).join("");
  function checkRoot(root) {
    const parts = LWLStore.checkedSegments(root);
    if (parts.length !== 2 || parts[1] !== "Reader") throw new Error("Invalid reader folder");
  }
  async function read(root, profileId) {
    checkRoot(root);
    let raw;
    try { raw = await LWLStore.readText(`${root}/${MANIFEST}`); }
    catch (error) { if (error.name === "NotFoundError") return null; throw error; }
    const manifest = JSON.parse(raw);
    if (manifest.format !== "lwl-reader-files" || manifest.version !== 1 || manifest.profileId !== profileId || !Array.isArray(manifest.files) || !Array.isArray(manifest.retired) || ![...manifest.files, ...manifest.retired].every(validFile)) throw new Error("Reader file inventory is invalid or belongs to another profile");
    return manifest;
  }
  async function save(root, manifest) { await LWLStore.write(`${root}/${MANIFEST}`, new Blob([JSON.stringify(manifest)], { type: "application/json" })); }
  async function verify(root, files) {
    for (const expected of files) {
      const file = await LWLStore.readFile(`${root}/${expected.path}`);
      if (file.size !== expected.bytes || await digest(file) !== expected.sha256) throw new Error("Reader files changed or are incomplete. Rebuild before cleaning exported files.");
    }
  }
  async function cleanup(root, profileId) {
    const manifest = await read(root, profileId);
    if (!manifest) return { removed: 0, bytes: 0, kept: 0, tracked: false };
    if (!manifest.retired.length) return {removed:0,bytes:0,kept:0,tracked:true};
    await verify(root, manifest.files);
    const current = new Set(manifest.files.map(file => file.path));
    const retained = []; let removed = 0, bytes = 0;
    for (const old of manifest.retired) {
      if (current.has(old.path)) continue;
      try {
        const file = await LWLStore.readFile(`${root}/${old.path}`);
        if (file.size !== old.bytes || await digest(file) !== old.sha256) { retained.push(old); continue; }
        if (!await LWLStore.removeFile(`${root}/${old.path}`)) { retained.push(old); continue; }
        removed++; bytes += old.bytes;
      } catch (error) { if (error.name !== "NotFoundError") retained.push(old); }
    }
    manifest.retired = retained;
    await save(root, manifest);
    return { removed, bytes, kept: retained.length, tracked: true };
  }
  async function commit(root, profileId, files, autoCleanup = true) {
    if (!Array.isArray(files) || !files.length || !files.every(validFile) || new Set(files.map(f => f.path)).size !== files.length) throw new Error("Invalid completed reader file inventory");
    const previous = await read(root, profileId);
    // A write acknowledgement alone is insufficient if the selected folder was
    // changed or a file was edited during the build. Verify the completed set.
    await verify(root, files);
    const current = new Set(files.map(file => file.path)), obsolete = new Map();
    for (const old of [...(previous?.retired || []), ...(previous?.files || [])]) if (!current.has(old.path)) obsolete.set(old.path, old);
    // Persist the complete live set before deleting anything. An interrupted
    // cleanup can retry; a failed build never replaces the previous inventory.
    await save(root, { format: "lwl-reader-files", version: 1, profileId, builtAt: new Date().toISOString(), files, retired: [...obsolete.values()] });
    return autoCleanup ? cleanup(root, profileId) : { removed: 0, bytes: 0, kept: obsolete.size, tracked: true };
  }
  async function registerLibrary(root, profile) {
    checkRoot(root);
    if(!await LWLStore.exists(root+'/index.html'))throw Error('Reader entry point is missing');
    const file='.lwl-library-directory.json';
    let directory={format:'lwl-library-directory',version:1,libraries:[]};
    try{directory=JSON.parse(await LWLStore.readText(file));}catch(error){if(error.name!=='NotFoundError')throw error;}
    if(directory.format!=='lwl-library-directory'||directory.version!==1||!Array.isArray(directory.libraries))throw Error('Invalid library directory');
    const libraries=[];
    for(const entry of directory.libraries){
      if(entry.id===profile.id||entry.path===root+'/index.html')continue;
      if(typeof entry.path!=='string'||!entry.path.endsWith('/index.html'))throw Error('Invalid library entry');
      checkRoot(entry.path.slice(0,-11));
      if(await LWLStore.exists(entry.path))libraries.push(entry);
    }
    libraries.push({id:profile.id,name:profile.name||profile.id,path:root+'/index.html'});
    libraries.sort((a,b)=>String(a.name).localeCompare(String(b.name)));
    directory={format:'lwl-library-directory',version:1,libraries};
    await LWLStore.write(file,new Blob([JSON.stringify(directory)],{type:'application/json'}));
    await LWLStore.write('.lwl-library-directory.js',new Blob(['window.LWL_LIBRARY_DIRECTORY='+JSON.stringify(directory)+';'],{type:'text/javascript'}));
    return {libraries:libraries.length};
  }
  globalThis.LWLReaderFiles = Object.freeze({ managedPath, digest, read, commit, cleanup, registerLibrary });
})();
