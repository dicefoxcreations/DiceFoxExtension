/* Bounded, durable JSONL batches. Each save closes a real file before it is
   acknowledged. Only the current batch is rewritten, never the whole library.
   The existing IndexedDB write queue provides crash-safe, idempotent replay. */
(() => {
  "use strict";
  function create({root, profileId, write, onCommit = () => {}, maxRecords = 25, maxBytes = 1024 * 1024}) {
    let serial = Promise.resolve(), failure = null, batch = 1, rows = new Map();
    const committed = new Set();
    const snapshot=(key,record)=>[key,JSON.stringify({format:"lwl-capture",version:1,profileId,key,savedAt:new Date().toISOString(),record})+"\n"];
    async function commit(){
      const path=`${root}/part-${String(batch).padStart(6,"0")}.jsonl`;
      await write(path,new Blob([...rows.values()],{type:"application/x-ndjson"}));
      for(const key of rows.keys())committed.add(key);
      onCommit({count:committed.size,path,at:Date.now()});
    }
    function enqueue(entries){
      const next=serial.then(async()=>{
        if(failure)throw failure;
        let dirty=false;
        for(const [key,line] of entries){
          const candidate=new Map(rows).set(key,line);
          if(rows.size&&(candidate.size>maxRecords||new Blob([...candidate.values()]).size>maxBytes)){
            if(dirty)await commit();
            rows=new Map();batch++;dirty=false;
          }
          rows.set(key,line);dirty=true;
        }
        if(dirty)await commit();
      }).catch(error=>{failure=error;throw error;});
      serial=next.catch(()=>{});return next;
    }
    return Object.freeze({
      // The initial backup has no live producers. Commit bounded batches once
      // instead of rewriting each batch up to 25 times while filling it.
      saveMany(entries){return enqueue(entries.map(([key,record])=>snapshot(key,record)));},
      save(key, record) {
        // Snapshot before yielding: callers may mutate their object afterwards.
        return enqueue([snapshot(key,record)]);
      }
    });
  }
  globalThis.LWLCaptureBackup = Object.freeze({create});
})();
