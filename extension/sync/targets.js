/* Explicit D&D Beyond selections use the same extractors and cache as full
   captures. They never replace full-catalog metadata or trigger cache pruning. */
function validateExportTargets(selected,targets,sourceIds){
 if(!Array.isArray(targets)||targets.length>100000)throw new Error('The individual selection is too large. Select whole categories instead.');
 return [...new Set(targets.map(value=>String(value).trim()).filter(Boolean))].map(value=>{
  const url=new URL(value);url.hash='';url.search='';
  if(url.protocol!=='https:'||url.origin!=='https://www.dndbeyond.com')throw new Error('Individual selections must be D&D Beyond URLs.');
  const provider=LWLProviders.get('dndbeyond'),kind=provider.classify(url.href);
  if(!kind||/^\/(?:en\/library|classes|subclasses|backgrounds|species|feats|spells|equipment|magic-items|monsters)\/?$/.test(url.pathname))throw new Error('Choose a book or entry URL, rather than a category.');
  if(url.pathname.startsWith('/subclasses/'))throw new Error('Choose the parent class page to include its subclasses with their class association.');
  if(kind==='my-library'&&!/^\/sources\/(?:dnd\/)?[^/]+\/?$/.test(url.pathname))throw new Error('For a book, choose its start page. Captured chapters can be selected individually in Send captured library.');
  if(!selected.sources.some(s=>sourceIds.includes(s.id)&&(s.providerSource||s.id)===kind))throw new Error('Select the corresponding category for this URL.');
  return url.href.replace(/\/+$/,'').replace('/sources/dnd/free-rules','/sources/dnd/br-2024');
 });
}
function validateWholeSources(selected,ids,sourceIds){
 if(!Array.isArray(ids)||ids.some(id=>!sourceIds.includes(id)||!selected.sources.some(s=>s.id===id)))throw new Error('Invalid whole-category selection.');
 return [...new Set(ids)];
}
async function syncTargets(source,force){
 const urls=config.targets.filter(url=>(LWLProviders.get('dndbeyond').classify(url)===(source.providerSource||source.id)));
 if(source.type==='glossary'){await syncGlossary(source,force);return sourceComplete((await chrome.storage.local.get(sourceKey(source.id)))[sourceKey(source.id)]);}
 // Dependencies such as the glossary remain part of a selected export.
 if(!urls.length)return true;
 if(source.type==='collection')return syncCollection(source,force,urls.map(url=>({url,title:LWLUrl.slugFromUrl(url)})));
 const key=sourceKey(source.id),previous=(await chrome.storage.local.get(key))[key]||{},items=new Map((previous.items||[]).map(i=>[canonical(i.url),i]));
 let complete=true;
 for(const url of urls){
  if(stopRequested){complete=false;break;}
  const item=items.get(url)||{url,title:LWLUrl.slugFromUrl(url)};
  try{
   const rec=await syncDetail(source,item,force);
   items.set(url,{...item,title:rec.title||item.title,captureStatus:'complete',meta:{...item.meta,...rec.meta}});
  }catch(error){complete=false;items.set(url,{...item,captureStatus:'error'});log(`Selected entry failed: ${url}: ${error.message}`);}
  await chrome.storage.local.set({[key]:{...previous,sourceId:source.id,name:source.name,type:source.type,mode:'content',items:[...items.values()],complete:previous.complete===true,updatedAt:new Date().toISOString()}});
 }
 return complete&&!stopRequested;
}
