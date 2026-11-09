/* Shared worker module; loaded by background.js. */
async function syncGlossary(source,force=false){
 status(`Syncing ${source.name}`);
 const start=canonical(source.startUrl); if(!start)throw new Error(`Invalid glossary start URL: ${source.startUrl}`);
 const explicitPages=Number(source.pagination?.maxPages||0);
 const isPaginated=Boolean(source.pagination?.selector)||(Number.isFinite(explicitPages)&&explicitPages>1);
 let pageUrls=[start];
 if(isPaginated){
  const disc=await discoverPaged({...source,detailPages:false});
  if(disc.listPages?.length)pageUrls=disc.listPages;
 }
 log(`${source.name}: ${pageUrls.length} glossary page(s) to extract.`);
 const captured=await pool(pageUrls,1,async u=>Boolean((await syncPage(source,u,{title:source.name},force))?.html));
 const meta={sourceId:source.id,name:source.name,type:source.type,pageCount:captured.filter(Boolean).length,complete:!stopRequested&&captured.filter(Boolean).length===pageUrls.length,pages:pageUrls.map(url=>({url})),updatedAt:new Date().toISOString()};
 await chrome.storage.local.set({[sourceKey(source.id)]:meta});
}
async function syncSection(source,force=false){const start=canonical(source.startUrl);const queue=[{url:start,depth:0}],seen=new Set(),list=[];while(queue.length&&!stopRequested&&list.length<(source.maxItems||5000)){const cur=queue.shift();const c=canonical(cur.url);if(seen.has(c)||cur.depth>source.followDepth)continue;seen.add(c);list.push({url:c,depth:cur.depth,title:LWLUrl.slugFromUrl(c)});if(cur.depth<source.followDepth){const res=await openTask(c,{type:"DISCOVER_SECTION_LINKS",source}).catch(()=>null);for(const l of res?.links||[]){const u=canonical(l.url);if(!seen.has(u)&&LWLUrl.sameOrigin(u,profile)&&!shouldSkipUrl(u))queue.push({url:u,depth:cur.depth+1,title:l.title});}}}log(`${source.name}: ${list.length} section page(s) discovered.`);await pool(list,1,async(x,i)=>Boolean(await syncPage(source,x.url,{title:x.title,navIndex:i},force)));await chrome.storage.local.set({[sourceKey(source.id)]:{sourceId:source.id,name:source.name,type:source.type,pageCount:list.length,pages:list,updatedAt:new Date().toISOString()}});}

async function discoverPaged(source){
 const seenPages=new Set(),items=new Map(),pageStats=[];
 const explicitPages=Number(source.pagination?.maxPages||0);
 const generatedPaging=Boolean(source.pagination?.pageParam)&&Number.isFinite(explicitPages)&&explicitPages>1;
 const maxPages=generatedPaging?explicitPages:(Number.isFinite(explicitPages)&&explicitPages>0?explicitPages:10000);
 let url=generatedPaging?pageUrlFor(source,1):source.startUrl,pageNo=0,complete=true;
 while(url&&pageNo<maxPages&&!stopRequested){
  const requested=canonical(url);if(!requested||seenPages.has(requested)){complete=false;break;}
  pageNo++;
  let res;
  try{ res=await openTask(url,{type:"DISCOVER_SOURCE",source}); }
  catch(e){ complete=false;log(`WARNING ${source.name}: list page ${pageNo} failed (${e.message||e}); continuing with the ${items.size} item(s) found so far.`); break; }
  if(!res?.ok){ complete=false;log(`WARNING ${source.name}: list page ${pageNo} returned no data (${res?.error||'unknown'}); continuing with the ${items.size} item(s) found so far.`); break; }
  const actual=canonical(res.url||requested)||requested;seenPages.add(actual);
  const pageItems=res.items||[];pageStats.push({pageNo,url:actual,itemCount:pageItems.length});
  for(const item of pageItems){const itemUrl=canonical(item.url);if(!itemUrl)continue;const key=source.type==="collection"?`${String(item.title||"").toLowerCase()}\u0000${itemUrl}`:itemUrl;items.set(key,{...item,url:itemUrl});}
  if(items.size>=(source.maxItems||5000)){complete=!res.nextUrl&&items.size===(source.maxItems||5000);break;}
  if(generatedPaging){if(pageNo>=explicitPages)break;if(pageNo>1&&!pageItems.length){complete=false;break;}url=pageUrlFor(source,pageNo+1);continue;}
  const next=res.nextUrl?canonical(res.nextUrl):null;
  if(!next)break;
  if(!LWLUrl.sameOrigin(next,profile)||seenPages.has(next)||pageNo>=maxPages){complete=false;break;}
  url=next;
 }
 return{items:[...items.values()].slice(0,source.maxItems||5000),listPages:[...seenPages],pageStats,complete:complete&&!stopRequested};
}

async function syncCollection(source,force=false,selectedItems=null){
 status(`Discovering ${source.name}`);
 const disc=selectedItems?{items:selectedItems,complete:true}:await discoverPaged(source),key=sourceKey(source.id),previous=(await chrome.storage.local.get(key))[key];
 const meta={sourceId:source.id,name:source.name,type:source.type,itemCount:disc.items.length,uniqueTargetCount:new Set(disc.items.map(x=>canonical(x.url))).size,items:[],complete:false,updatedAt:new Date().toISOString()};
 const targetCache=new Map();let done=0;
 setProgress(0,Math.max(1,disc.items.length));
 const checkpoint=async()=>{
  const seen=new Set(meta.items.map(x=>canonical(x.url)));
  // During an interrupted run, retain books not visited yet.
  const tail=(previous?.items||[]).filter(x=>!seen.has(canonical(x.url)));
  await chrome.storage.local.set({[key]:{...meta,complete:selectedItems?previous?.complete===true:meta.complete,items:[...meta.items,...tail],itemCount:meta.items.length+tail.length}});
 };
 for(const [entryIndex,item] of disc.items.entries()){
  if(stopRequested)break;
  while(paused&&!stopRequested)await sleep(250);
  const itemUrl=canonical(item.url),bookSource={...source,collectionRoot:itemUrl};
  let target=targetCache.get(itemUrl);
  if(!target){
   const nav=await openTask(itemUrl,{type:'DISCOVER_NAVIGATION',source:bookSource}).catch(e=>({ok:false,error:String(e.message||e)}));
   target={targetId:safeId(itemUrl),pageCount:0,expectedPages:0,ok:false,complete:false};targetCache.set(itemUrl,target);
   if(!nav?.ok)target.error=nav?.error||'Book navigation unavailable';
   else{
    if(selectedItems)item.title=LWLPresentation.chooseTitle([nav.title,(previous?.items||[]).find(p=>canonical(p.url)===itemUrl)?.title,item.title],itemUrl);
    const pages=new Map([[itemUrl,{title:item.title,url:itemUrl}],...(nav.pages||[]).filter(p=>LWLProviders.allows(profile,bookSource,p.url)).map(p=>[canonical(p.url),{...p,url:canonical(p.url)}])]);
    const queue=[...pages.values()].slice(0,source.maxItems||5000),seen=new Set(queue.map(p=>p.url));let offset=0,truncated=queue.length<pages.size;
    for(let depth=0;offset<queue.length&&!stopRequested&&depth<=Math.max(1,source.followDepth||1);depth++){
     const batch=queue.slice(offset);offset=queue.length;
     const results=await pool(batch,1,(page,i)=>syncPage(bookSource,page.url,{title:page.title,collectionId:target.targetId,collectionTitle:LWLPresentation.chooseTitle([item.title,nav.title],item.url),collectionCover:item.cover||null,navIndex:offset-batch.length+i},force));
     target.pageCount+=results.filter(r=>r?.html).length;
     for(const rec of results)for(const link of rec?.links||[]){
      const url=canonical(link.url);
      if(!url||seen.has(url)||!url.startsWith(itemUrl.replace(/\/$/,'')+'/')||!LWLProviders.allows(profile,bookSource,url))continue;
      if(depth>=source.followDepth||queue.length>=(source.maxItems||5000)){truncated=true;continue;}
      seen.add(url);queue.push({url,title:link.title});
     }
    }
    target.expectedPages=queue.length;target.ok=target.pageCount>0;
    target.complete=!stopRequested&&!truncated&&target.pageCount===target.expectedPages;
    if(truncated)target.error='Book discovery reached its configured depth or page limit';
    if(!target.ok)target.error='No accessible book pages captured';
   }
  }
  meta.items.push({entryId:safeId(`${itemUrl}\u0000${item.title||''}\u0000${entryIndex}`),targetId:target.targetId,title:item.title,cover:item.cover||null,url:itemUrl,pageCount:target.pageCount,expectedPages:target.expectedPages,complete:target.complete,duplicateTarget:meta.items.some(x=>x.url===itemUrl),available:target.ok,error:target.error||null});
  if(!target.ok)log(`Skip collection entry ${item.title}: ${target.error}`);
  setProgress(++done);await checkpoint();
 }
 meta.complete=!stopRequested&&disc.complete!==false&&meta.items.length===disc.items.length&&meta.items.every(x=>x.complete);
 await checkpoint();
 return meta.complete;
}
