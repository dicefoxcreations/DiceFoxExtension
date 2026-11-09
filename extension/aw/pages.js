/* Pages for the export, read without a tab and kept for the next one.

   A page is fetched as the browser would ask for it, with the reader's own
   sign-in, and read as served: its scripts never run, nothing waits for
   pictures, fonts or scrolling. What was read is kept, compressed, in this
   browser only — exporting again, into another world or after a change to
   the conversion, takes it from here instead of asking the site again. */
(() => {
  'use strict';
  const DB_NAME='dicefox-pages',STORE='pages',LIMIT=16*1024*1024;
  let opened=null;
  function db(){
    if(opened)return opened;
    opened=new Promise((resolve,reject)=>{
      const request=indexedDB.open(DB_NAME,1);
      request.onupgradeneeded=()=>request.result.createObjectStore(STORE);
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>{opened=null;reject(request.error);};
    });
    return opened;
  }
  function run(mode,fn){
    return db().then(d=>new Promise((resolve,reject)=>{
      const tx=d.transaction(STORE,mode);let result;
      tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error);
      const request=fn(tx.objectStore(STORE));if(request)request.onsuccess=()=>{result=request.result;};
    }));
  }
  const key=(url,extract)=>extract+'\u0000'+url;
  const pack=async value=>new Response(new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'))).blob();
  const unpack=async blob=>JSON.parse(await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).text());
  // Only what the export uses of a page is kept.
  function compact(result){
    const one=r=>r&&{url:r.url,title:r.title,html:r.html,links:r.links||[],meta:r.meta||{}};
    return result.detail?{detail:one(result.detail)}:{page:one(result.page),glossary:result.glossary||[]};
  }
  /* The page as read before — only while it was read under the same capture
     rules; a change to them reads it again. */
  async function kept({url,extract,rules}){
    const saved=await run('readonly',s=>s.get(key(url,extract))).catch(()=>null);
    if(!saved||saved.rules!==(rules??null))return {ok:true,result:null};
    try{return {ok:true,result:{ok:true,kept:saved.at,finalUrl:saved.finalUrl,...await unpack(saved.blob)}};}
    catch{return {ok:true,result:null};}
  }
  async function keep({url,extract,rules,result}){
    if(!result?.ok||!(result.detail||result.page)?.html)return {ok:true};
    const blob=await pack(compact(result));
    await run('readwrite',s=>s.put({at:Date.now(),rules:rules??null,finalUrl:result.finalUrl||url,blob},key(url,extract)));
    return {ok:true};
  }
  async function fetchOnce(url){
    const response=await fetch(url,{credentials:'include',signal:AbortSignal.timeout(45000)});
    if([429,503].includes(response.status)){
      const seconds=Number(response.headers.get('retry-after'));
      await response.body?.cancel().catch(()=>{});
      return {wait:Number.isFinite(seconds)&&seconds>0?Math.min(120,seconds)*1000:30000};
    }
    return {response};
  }
  /* Reads a page without a tab. The answer has the shape a tab's has, and
     where the page ended up, for the caller's own checks. */
  async function read({url,message,signedOut}){
    let response;
    for(let attempt=0;;attempt++){
      const got=await fetchOnce(url);
      if(got.response){response=got.response;break;}
      if(attempt>=2)return {ok:true,result:{ok:false,error:'The site asks to slow down.',busy:true}};
      await new Promise(resolve=>setTimeout(resolve,got.wait));
    }
    const finalUrl=response.url||url;
    if([404,410].includes(response.status)){await response.body?.cancel().catch(()=>{});return {ok:true,result:{ok:false,unavailable:true,gone:true,error:'Unavailable content: page not found',finalUrl}};}
    if(!response.ok){await response.body?.cancel().catch(()=>{});return {ok:true,result:{ok:false,error:'HTTP '+response.status,finalUrl}};}
    if(!/text\/html/i.test(response.headers.get('content-type')||'')){await response.body?.cancel().catch(()=>{});return {ok:true,result:{ok:false,error:'Not a page',finalUrl}};}
    const html=await response.text();
    if(html.length>LIMIT)return {ok:true,result:{ok:false,error:'The page is too large',finalUrl}};
    // Served as to someone not signed in: what the reader owns would be missing.
    if(signedOut&&html.includes(signedOut))return {ok:true,result:{ok:false,signedOut:true,error:'Not signed in without a tab',finalUrl}};
    let result;
    try{result={...LWLContentCapture.read(html,finalUrl,message),finalUrl};}
    catch(error){result={ok:false,error:String(error.message||error),finalUrl};}
    return {ok:true,result};
  }
  async function count(){return {ok:true,count:await run('readonly',s=>s.count()).catch(()=>0)};}
  async function forget(){await run('readwrite',s=>s.clear());return {ok:true};}
  globalThis.AWPages=Object.freeze({read,kept,keep,count,forget});
})();
