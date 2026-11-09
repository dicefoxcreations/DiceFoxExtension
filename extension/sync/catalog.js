/* Shared worker module; loaded by background.js. */
async function syncDetail(source,item,force=false){
 const url=canonical(item.url);
 if(!LWLProviders.allows(profile,source,url))throw Error('Detail outside supported export scope: '+url);
 const key=detailKey(url);
 const previous=(await chrome.storage.local.get(key))[key];
 if(reuseDuringSync(previous,source,force)){await saveCapture(key,previous);return previous;}
 setField("source",source.name);setField("page",item.title||url);
 const result=await openTask(url,{type:"EXTRACT_DETAIL",source:capturedSource(source)},async(tab,res)=>{
 if(res?.unavailable)throw new Error(res.error||`Unavailable: ${url}`);
 if(!res?.ok)throw new Error(res?.error||`Detail extraction failed: ${url}`);
 const d=res.detail||{};
 const rec={
  id:safeId(url),url:canonical(d.url||url),requestedUrl:url,sourceId:source.id,sourceName:source.name,sourceType:source.type,
  title:d.title||item.title||url,
  html:d.html||"",text:d.text||"",
  captureVersion:d.captureVersion,contentBoundaryVersion:d.contentBoundaryVersion,captureRules:d.captureRules,presentation:d.presentation,styleId:d.styleId,theme:d.theme,
  captureWarnings:[...(d.styles?.warnings||[]),"Resource capture is unfinished. Resume synchronization to capture page styling and media."],resourceCapturePending:true,
  meta:{...(item.meta||{}),...(d.meta||{})},
  headings:d.headings||[],
  related:d.related||[],
  links:(d.links||[]).map(x=>({...x,url:canonicalWithHash(x.url)})).filter(x=>x.url),
  images:d.images||[],
  characterCount:d.characterCount||0,
  updatedAt:new Date().toISOString()
 };
 if(previous?.catalogPreviews)rec.catalogPreviews=previous.catalogPreviews;
 if(!rec.html.trim())throw new Error(`Empty article for ${rec.title} – check detailSelector for ${source.name}.`);
 await chrome.storage.local.set({[key]:rec});
 await saveCapture(key,rec);
 state.captured=(await localKeys()).filter(k=>k.startsWith(`${prefix()}page:`)||k.startsWith(`${prefix()}detail:`)).length;
 broadcast();
 rec.styleId=await storePresentation(d,tab.id);
 rec.resourceCapturePending=false;
 rec.captureWarnings=d.styles?.warnings||[];
 await chrome.storage.local.set({[key]:rec});
 await saveCapture(key,rec);
 return rec;
 });
 if(result?.unavailable)throw new Error(result.error||`Unavailable: ${url}`);
 return result;
}

/* ---------- exact filters ----------

   Harvesting metadata out of the page can only recover what the page prints.
   A site's own filter controls know more: they are backed by data the site
   holds, not by text in the markup. Asking the site itself - walking the list
   once per option value and recording which items come back - reproduces those
   filters exactly, including dimensions that appear nowhere in an item's HTML.

   The mechanism is plain HTML: a select with a name filters through a URL
   parameter of that name. Nothing here is specific to any site. */

function filterOptionUrl(startUrl, paramName, value, pageParam="page"){
 try{
  const u=new URL(startUrl);
  if(value==="")u.searchParams.delete(paramName);else u.searchParams.set(paramName,String(value));
  u.searchParams.delete(pageParam);return u.href;
 }catch{return null;}
}
const selectableOptions=LWLReaderModel.selectableOptions;
const facetKeyFor=LWLReaderModel.facetKey;

/* Never report a partial scan, an ignored parameter, or a filter reset by a
   replayed form action as an exact membership. */
async function itemsForFilterValue(source,def,option,maxPages){
 const seen=new Set(),signatures=new Set(),urls=new Set();
 const probe={...source,expandCards:false,probeFilter:{selector:def.selector,type:"select"},
  filters:(source.filters||[]).filter(f=>f.selector!==def.selector && f.name!==def.name)};
 let url=filterOptionUrl(source.startUrl,def.name,option.value,source.pagination?.pageParam||"page"),pageNo=0;
 const incomplete=reason=>({urls,complete:false,reason});
 while(url&&pageNo<maxPages&&!stopRequested){
  while(paused&&!stopRequested)await sleep(250);
  if(stopRequested)break;
  const requested=canonical(url);if(!requested||seen.has(requested))return incomplete("repeated-page");
  seen.add(requested);pageNo++;
  let res;
  try{
   if(source.catalogView?.filterTransport==='html'){
    await sleep(pace());
    res=await askOffscreen({type:'CATALOG_MEMBERSHIP',url,source:probe,def});
   }
   else res=await openTask(url,{type:"EXTRACT_CATALOG_PAGE",source:probe});
  }catch(e){return incomplete(String(e.message||e));}
  if(!res?.ok)return incomplete(res?.error||"page-error");
  const control=res.filterState?.[0];
  const selected=Array.isArray(control?.value)?control.value:[control?.value];
  if(!control?.exists||!selected.includes(option.value))return incomplete("filter-not-applied");
  const actual=canonical(res.url||url);
  if(actual!==requested&&seen.has(actual))return incomplete("repeated-page");
  seen.add(actual);
  if(res.itemsLimited)return incomplete('truncated-page');
  const items=res.items||[],signature=items.map(x=>canonical(x.url)).sort().join("\n");
  if(items.length&&signatures.has(signature))return incomplete("repeated-items");
  signatures.add(signature);
  for(const item of items){const u=canonical(item.url);if(u)urls.add(u);}
  const detected=res.pagination||{},last=Number(detected.lastPage||0);
  if(!items.length || (last&&pageNo>=last) || (!last&&!res.nextUrl))return {urls,complete:true};
  const param=detected.pageParam||source.pagination?.pageParam;
  if(res.nextUrl){
   const next=new URL(res.nextUrl,url);
   if(!LWLUrl.sameOrigin(next.href,profile))return incomplete("pagination-outside-origin");
   next.searchParams.set(def.name,option.value);url=next.href;
  }else if(param){const next=new URL(actual);next.searchParams.set(param,String(pageNo+1));url=next.href;}
  else return incomplete("missing-next-page");
 }
 return incomplete(stopRequested?"stopped":"max-pages");
}

async function resolveExactFilters(source,disc,onDefinition=null){
 const wanted=new Set(source.facetFilters||[]);
 const ranges=new Set((source.catalogView?.filterBindings||[]).filter(b=>b.operator==='gte'||b.operator==='lte'||b.capture===false).map(b=>b.name));
 const definitions=(disc.filterDefinitions||[]).filter(d=>d.type==="select"&&d.name&&!ranges.has(d.name)&&(wanted.has("*")||wanted.has(d.name))&&!/sort|order|page[-_]?size/i.test(d.name)&&selectableOptions(d).length);
 const perItem=new Map(),resolved=[];
 const known=new Set(disc.items.map(x=>canonical(x.url)).filter(Boolean));
 const ordered=[...known].sort(),indices=new Map(ordered.map((url,i)=>[url,i]));
 const cacheKey=source.id?`${prefix()}filter-capture:${source.id}`:null;
 // Membership depends on the captured URLs and rules, not the date a repair
 // command happened to write the metadata. Ordinary sync and repair share it.
 const operational=['previewUrlTemplate','filterTransport','rowsTransport'];
 const views=[source.catalogView];
 for(const key of operational)for(const view of [...views])if(view&&Object.hasOwn(view,key)){
  const copy={...view};delete copy[key];views.push(copy);
 }
 const signatureFor=(revision,view)=>hashText(stableJson([3,revision,source.startUrl,source.filters,view,source.itemUrlPatterns,ordered,definitions]));
 const signature=signatureFor(null,views.at(-1));
 const oldCache=cacheKey?(await chrome.storage.local.get(cacheKey))[cacheKey]:null;
 // Legacy checkpoints can differ only in the execution method. Their sorted
 // URL set, selectors, options and base filters still have to match exactly.
 const compatible=oldCache&&views.some(view=>oldCache.signature===signatureFor(null,view)||(disc.revision&&oldCache.signature===signatureFor(disc.revision,view)));
 const cache=compatible?{...oldCache,signature}:{sourceId:source.id,signature,definitions:{}};
 let saveQueue=Promise.resolve();
 const save=()=>{if(!cacheKey)return Promise.resolve();const task=saveQueue.then(()=>chrome.storage.local.set({[cacheKey]:cache}));saveQueue=task.catch(()=>{});return task;};
 if(compatible&&oldCache.signature!==signature)await save();
 for(const def of definitions){
  if(stopRequested)break;
  const options=selectableOptions(def),key=facetKeyFor(def),membership=new Map([...known].map(u=>[u,[]]));
  let complete=true,reason=null,done=0;
  const saved=cache.definitions[def.name]||={};
  setProgress(0,options.length);
  await pool(options,1,async option=>{
   while(paused&&!stopRequested)await sleep(250);
   if(stopRequested)return;
   status(`${source.name}: ${def.label} = ${option.label} (${done+1}/${options.length})`);
   const cached=saved[option.value];
   const result=cached?.complete?{complete:true,urls:new Set(cached.indices.map(i=>ordered[i]).filter(Boolean))}:await itemsForFilterValue(source,def,option,Math.max(1,Number(source.pagination?.maxPages)||10000));
   if(!result.complete){complete=false;reason=result.reason;}
   else {
    for(const url of result.urls)if(membership.has(url))membership.get(url).push(option.value);
    if(!cached?.complete){saved[option.value]={complete:true,indices:[...result.urls].filter(url=>indices.has(url)).map(url=>indices.get(url)),total:result.urls.size,updatedAt:new Date().toISOString()};await save();}
   }
   setProgress(++done);
  });
  if(stopRequested||done<options.length){complete=false;reason=stopRequested?'stopped':reason||'option-error';}
  resolved.push({...def,key,options,complete,reason});
  if(complete){
   for(const [url,values] of membership){if(!perItem.has(url))perItem.set(url,{});perItem.get(url)[key]=values;}
  }else log(`${source.name}: filter "${def.label}" is incomplete (${reason}); it will not be shown as an exact filter.`);
  if(onDefinition)await onDefinition(resolved[resolved.length-1],membership);
 }
 return {perItem,definitions:resolved};
}

/* Capture real row panels during ordinary sync as well as explicit repair.
   Static list responses cannot execute an expansion control. */
async function captureCatalogPreviews(source,meta,{refreshRows=false}={}){
 const effective={...source,catalogView:{...meta.catalog?.config,...source.catalogView}};
 const template=effective.catalogView.previewUrlTemplate;
 const expectsPanels=Boolean(effective.catalogView.expandedRowSelector);
 if(!template&&!refreshRows&&(!expectsPanels||meta.items.every(item=>item.panelHtml))) {
  if(expectsPanels)meta.previewCapture={processed:meta.items.length,stored:meta.items.length,failed:0,complete:true,updatedAt:new Date().toISOString()};
  return;
 }
 let completed=0,failed=0;
 if(template){
  setProgress(0,meta.items.length);
  await pool(meta.items,1,async item=>{
   while(paused&&!stopRequested)await sleep(250);
   if(stopRequested)return;
   const saved=(await chrome.storage.local.get(detailKey(item.url)))[detailKey(item.url)];
   const itemKey=saved?.html?detailKey(item.url):previewKey(item.url);
   const record=saved?.html?saved:(await chrome.storage.local.get(itemKey))[itemKey]||{url:canonical(item.url),title:item.title,sourceId:source.id,html:'',text:'',meta:{},catalogPreviews:saved?.catalogPreviews};
   const url=template.replaceAll('{url}',canonical(item.url).replace(/\/$/,''));
   const previous=record.catalogPreviews?.[source.id];
   if(!previous?.html||previous.url!==url){
    status(`${source.name}: ${ui('row previews','Zeilenvorschauen')} ${completed+1}/${meta.items.length}`);
    const result=await askOffscreen({type:'CATALOG_PREVIEW',url,source:effective}).catch(error=>({ok:false,error:String(error.message||error)}));
    if(!result?.ok||!result.html?.trim()){failed++;log(`Preview ${item.title}: ${result?.error||'unavailable'}`);}
    else{
     record.catalogPreviews={...record.catalogPreviews,[source.id]:{html:result.html,meta:result.meta,url,updatedAt:new Date().toISOString()}};
     await chrome.storage.local.set({[itemKey]:record});
     if(record.html)await saveCapture(itemKey,record);
    }
    await sleep(pace());
   }
   setProgress(++completed);
  });
  meta.previewCapture={processed:completed,stored:completed-failed,failed,complete:completed===meta.items.length&&!failed&&!stopRequested,updatedAt:new Date().toISOString()};
 }else if(!stopRequested){
  // Sites without a declared HTML endpoint use their real expansion controls.
  const disc=await discoverCatalogCards({...effective,expandCards:true});
  // Rows and group positions belong to the same captured catalog. Updating
  // only their HTML strands refreshed cards under an old source heading.
  const previousItems=meta.items;
  meta.items=LWLCatalogState.mergeItems(disc.items,previousItems,canonical,{complete:false});
  meta.itemCount=meta.items.length;
  meta.exactFilters=LWLCatalogState.preserveDefinitions(meta.exactFilters,[],previousItems,meta.items,canonical);
  if(disc.catalog)meta.catalog=disc.catalog;
  if(expectsPanels){
   const stored=meta.items.filter(item=>item.panelHtml).length;
   meta.previewCapture={processed:disc.items.length,stored,failed:meta.items.length-stored,complete:stored===meta.items.length&&!stopRequested,updatedAt:new Date().toISOString()};
  }
 }
 if(template&&!stopRequested){
  // Capture the shell with preview CSS states, without a full list recrawl.
  const result=await openTask(source.startUrl,{type:'EXTRACT_CATALOG_PAGE',source:{...effective,captureCatalogLayout:true,expandCards:true,expandLimit:12}},async(tab,res)=>{
   if(res?.catalog)await storePresentation(res.catalog,tab.id);return res;
  });
  if(result?.catalog){
   meta.catalog=result.catalog;
   const styleKey=stylesKey(source.id),styles=(await chrome.storage.local.get(styleKey))[styleKey]||{};
   await chrome.storage.local.set({[styleKey]:{...styles,css:result.catalog.styles?.css||styles.css,updatedAt:new Date().toISOString()}});
  }
 }
 await chrome.storage.local.set({[sourceKey(source.id)]:meta});
}

/* Explicit enrichment reuses the same capture path as ordinary synchronization. */
async function completeCatalogs(){
 try{
  for(const source of profile.sources||[]){
   if(stopRequested)break;
   if(source.type!=='catalog'||(config.sourceIds?.length&&!config.sourceIds.includes(source.id)))continue;
   const key=sourceKey(source.id),meta=(await chrome.storage.local.get(key))[key];
   if(!meta?.items?.length||!meta.catalog)continue;
   const effective={...source,catalogView:{...meta.catalog.config,...source.catalogView},facetFilters:source.facetFilters?.length?source.facetFilters:['*']};
   meta.catalogRevision ||= meta.updatedAt;
   await captureCatalogPreviews(effective,meta,{refreshRows:true});
   meta.complete=sourceComplete(meta);
   await chrome.storage.local.set({[key]:meta});
   if(stopRequested)break;
   await resolveExactFilters(effective,{items:meta.items,filterDefinitions:meta.filters,revision:meta.catalogRevision},async(def,memberships)=>{
    const exact={definitions:[def],perItem:new Map(meta.items.map(item=>[canonical(item.url),{[def.key]:memberships.get(canonical(item.url))||[]}]))};
    LWLCatalogState.applyMemberships(meta,exact,canonical);
    await chrome.storage.local.set({[key]:meta});
    log(`${source.name}: ${def.label}: ${def.complete?'complete':def.reason}.`);
   });
   if(!stopRequested)await captureNumericFilters(effective,meta);
  }
 }finally{await closeCrawlWindow();}
 if(!stopRequested)await buildIndexes();
}

async function syncCatalogContent(source,force=false){
 status(`${ui('Discovering','Erkennen')} ${source.name}`);
 const disc=await discoverCatalogCards(source);
 const previous=(await chrome.storage.local.get(sourceKey(source.id)))[sourceKey(source.id)];
 const meta={sourceId:source.id,name:source.name,type:source.type,mode:'content',
  itemCount:disc.items.length,
  items:disc.items.map(x=>({url:x.url,title:x.title,meta:x.meta||{},rowGroup:x.rowGroup||0,rowHtml:x.rowHtml||null,panelHtml:x.panelHtml||null,summaryText:String(x.summaryText||'').slice(0,400)})),
  catalog:disc.catalog||previous?.catalog||null,
  exactFilters:previous?.exactFilters||[],
  listPages:disc.pageStats||[],filters:disc.filterDefinitions||[],appliedFilters:source.filters||[],
  expectedListPages:disc.expectedListPages||null,paginationEndReason:disc.endedReason||null,
  discoveryComplete:!['stopped','page-error','max-items','repeated-page'].includes(disc.endedReason)&&(!disc.expectedListPages||disc.listPages.length>=disc.expectedListPages),
  complete:false,
  updatedAt:new Date().toISOString()};
 meta.items=LWLCatalogState.mergeItems(meta.items,previous?.items,canonical,{complete:meta.discoveryComplete});
 meta.itemCount=meta.items.length;
 meta.exactFilters=LWLCatalogState.preserveDefinitions(previous?.exactFilters,[],previous?.items,meta.items,canonical);
 await chrome.storage.local.set({[sourceKey(source.id)]:meta});
 log(`${source.name}: ${disc.items.length} item(s) from ${disc.listPages.length}${disc.expectedListPages?`/${disc.expectedListPages}`:''} list page(s).`);
 if(disc.expectedListPages&&disc.listPages.length<disc.expectedListPages)log(`WARNING ${source.name}: only ${disc.listPages.length} of ${disc.expectedListPages} list pages were read (${disc.endedReason||'unknown reason'}). The item pages found so far are stored now; run the sync again to pick up the rest.`);
 setProgress(0,Math.max(1,disc.items.length));
 let done=0,stored=0,failed=0,unavailable=0;
 const itemStates=new Map(meta.items.map(item=>[canonical(item.url),item]));
 // Detail pages are read with a low worker count on purpose: this is a long
 // authenticated crawl of one site, not a burst.
 // mergeItems retained the known tail after failed/limited discovery. It also
 // needs detail retries even if the current list request could not reach it.
 status(`${ui('Capturing content','Inhalte erfassen')}: ${source.name}`);
 setProgress(0,Math.max(1,meta.items.length));
 const workers=1;
 const related=new Map();
 const captureItem=async item=>{
  if(stopRequested)return null;
  while(paused&&!stopRequested)await sleep(250);
  const itemState=itemStates.get(canonical(item.url));
  try{
   const rec=await syncDetail(source,item,force);
   if(!rec?.html?.trim())throw new Error('Empty article returned by detail capture');
   stored++;if(itemState){itemState.captureStatus='stored';delete itemState.captureError;}
   for(const child of rec?.related||[])if(LWLProviders.allows(profile,source,child.url)&&!itemStates.has(canonical(child.url)))related.set(canonical(child.url),{...child,parentUrl:item.url});
  }
  catch(e){
   /* An item that redirects off the profile origin is not a failure of ours:
      the page is unavailable in the current browser session. Counting it
      separately keeps extraction errors visible. */
   const msg=String(e.message||e);
   if(/Redirect outside (?:profile origin|supported export scope)|Unavailable content|Skipped by profile rule/.test(msg)){ unavailable++;if(itemState)itemState.captureStatus='unavailable'; }
   else { failed++;if(itemState)itemState.captureStatus='error';if(failed<=20)log(`Detail failed: ${item.title||item.url}: ${msg}`); }
   if(itemState)itemState.captureError=msg;
  }
  setProgress(++done);
  if(done%25===0)await chrome.storage.local.set({[sourceKey(source.id)]:{...meta,complete:false,detailStored:stored,detailFailed:failed,detailUnavailable:unavailable}});
  if(done%50===0)status(`${source.name}: ${done}/${meta.items.length}`);
  return null;
 };
 await pool(meta.items,workers,captureItem);
 // Related details are explicit adapter links, never an unrestricted crawl.
 if(source.relatedLinkSelector&&!stopRequested){
  const children=[...related.values()].slice(0,Math.max(0,(source.maxItems||5000)-meta.items.length));
  for(const item of children){meta.items.push(item);itemStates.set(canonical(item.url),item);}
  meta.itemCount=meta.items.length;
  await chrome.storage.local.set({[sourceKey(source.id)]:meta});
  await pool(children,workers,captureItem);
 }
 // Save useful content first. Exact filter reconstruction can be a much longer
 // second crawl, during which the content counter otherwise appears frozen.
 meta.detailStored=stored;meta.detailFailed=failed;meta.detailUnavailable=unavailable;
 meta.complete=meta.discoveryComplete&&stored===meta.items.length&&!failed&&!unavailable&&!stopRequested;
 meta.detailFinishedAt=new Date().toISOString();
 await chrome.storage.local.set({[sourceKey(source.id)]:meta});
 if(!stopRequested){
  if(source.catalogView?.expandedRowSelector)await captureCatalogPreviews(source,meta);
  const exact=await resolveExactFilters(source,disc);
  LWLCatalogState.applyMemberships(meta,exact,canonical);
  if(!meta.discoveryComplete)meta.exactFilters=meta.exactFilters.map(def=>({...def,complete:false,reason:'catalog-incomplete'}));
  if(!stopRequested)await captureNumericFilters(source,meta);
 }
 meta.complete=meta.complete&&stored===meta.items.length&&meta.previewCapture?.complete!==false&&!stopRequested;
 await chrome.storage.local.set({[sourceKey(source.id)]:meta});
 log(`${source.name}: ${stored} item page(s) stored${failed?`, ${failed} failed`:''}${unavailable?`, ${unavailable} not accessible in this browser session`:''}.`);
}


function mergeCatalogFilters(base=[],incoming=[]){
 const map=new Map(base.map(x=>[`${x.type||''}\u0000${x.label||x.selector||''}`,JSON.parse(JSON.stringify(x))]));
 for(const f of incoming||[]){const k=`${f.type||''}\u0000${f.label||f.selector||''}`;let cur=map.get(k);if(!cur){map.set(k,JSON.parse(JSON.stringify(f)));continue;}if(f.type==='select'){const om=new Map((cur.options||[]).map(o=>[String(o.value),o]));for(const o of f.options||[])if(!om.has(String(o.value)))om.set(String(o.value),o);cur.options=[...om.values()];}}
 return [...map.values()];
}
async function discoverCatalogCards(source){
 const items=new Map(),listPages=[],pageStats=[];let filterDefinitions=[];
 let catalog=null;
 let expectedPages=Number(source.pagination?.maxPages||0);if(!Number.isFinite(expectedPages)||expectedPages<1)expectedPages=0;
 let pageParam=source.pagination?.pageParam||null;
 let generatedPaging=Boolean(pageParam)&&expectedPages>1;
 let url=source.startUrl,pageNo=0,endedReason='end-of-pagination';
 while(url&&pageNo<10000&&!stopRequested){
  const requested=canonical(url);if(!requested||listPages.includes(requested)){endedReason='repeated-page';break;}
  pageNo++;status(`${source.name}: ${ui('list page','Listenseite')} ${pageNo}${expectedPages?`/${expectedPages}`:''}`);
  /* Discovery collects item URLs in memory and only the caller stores them, so
     throwing here would discard every list page read so far. Stop paginating
     instead and hand back what was found; the item pages are then read and
     stored, and a later run continues from the remaining list pages. */
  let res;
  try{ res=catalog&&source.catalogView?.rowsTransport==='html'&&!(source.expandCards!==false&&source.catalogView?.expandedRowSelector)
   ?await askOffscreen({type:'CATALOG_ROWS',url,source})
   :await openTask(url,{type:'EXTRACT_CATALOG_PAGE',source:{...source,captureCatalogLayout:!catalog}},async(tab,result)=>{
    if(result?.catalog&&!source.probeFilter&&result?.ok)await storePresentation(result.catalog,tab.id);
    return result;
  }); }
  catch(e){ log(`WARNING ${source.name}: list page ${pageNo} failed (${e.message||e}); keeping the ${items.size} item(s) found so far.`); endedReason='page-error'; break; }
  if(!res?.ok){ log(`WARNING ${source.name}: list page ${pageNo} returned no data (${res?.error||'unknown'}); keeping the ${items.size} item(s) found so far.`); endedReason='page-error'; break; }
  if(res.catalog){
   catalog=res.catalog;source={...source,catalogView:catalog.config,pageSelector:source.pageSelector||catalog.presentation?.pageSelector};
   const key=stylesKey(source.id),previous=(await chrome.storage.local.get(key))[key]||{};
   await chrome.storage.local.set({[key]:{...previous,css:catalog.styles?.css||'',updatedAt:new Date().toISOString()}});
  }
  const actual=canonical(res.url||requested)||requested;if(listPages.includes(actual)){endedReason='repeated-page';break;}listPages.push(actual);
  const pageItems=res.items||[];filterDefinitions=mergeCatalogFilters(filterDefinitions,res.filterDefinitions||[]);
  const detected=res.pagination||{};
  const detectedLast=Number(detected.lastPage||0);
  if(Number.isFinite(detectedLast)&&detectedLast>expectedPages)expectedPages=detectedLast;
  if(!pageParam&&detected.pageParam)pageParam=detected.pageParam;
  generatedPaging=Boolean(pageParam)&&expectedPages>1;
  for(const raw of pageItems){const itemUrl=canonical(raw.url);if(!itemUrl)continue;const item={...raw,url:itemUrl};const old=items.get(itemUrl);const oldLen=String(old?.summaryText||'').length+String(old?.cardHtml||'').length,newLen=String(item.summaryText||'').length+String(item.cardHtml||'').length;if(!old||newLen>oldLen)items.set(itemUrl,item);}
  pageStats.push({pageNo:Number(res.pageNumber||pageNo)||pageNo,url:actual,itemCount:pageItems.length,expandedCount:Number(res.expandedCount||0)});
  log(`${source.name}: ${ui('list page','Listenseite')} ${pageNo}${expectedPages?`/${expectedPages}`:''}: ${pageItems.length} ${ui('items','Einträge')}; ${items.size} ${ui('unique total','eindeutig insgesamt')}.`);
  if(items.size>=(source.maxItems||5000)){endedReason=!res.itemsLimited&&items.size===(source.maxItems||5000)&&expectedPages&&pageNo>=expectedPages?'expected-last-page':'max-items';break;}
  if(generatedPaging){
   if(pageNo>=expectedPages){endedReason='expected-last-page';break;}
   if(pageNo>1&&!pageItems.length){endedReason='empty-page';break;}
   url=pageUrlFor({...source,pagination:{...(source.pagination||{}),pageParam}},pageNo+1);continue;
  }
  const next=res.nextUrl?canonical(res.nextUrl):null;
  if(!next||!LWLUrl.sameOrigin(next,profile)||listPages.includes(next)){endedReason='no-next';break;}url=next;
 }
 if(stopRequested)endedReason='stopped';
 return{items:[...items.values()].slice(0,source.maxItems||5000),catalog,listPages,pageStats,filterDefinitions,expectedListPages:expectedPages||null,pageParam:pageParam||null,endedReason};
}
async function syncCatalog(source,force=false){return syncCatalogContent(source,force);}
async function refreshCatalogViews(){
 try{
  for(const source of profile.sources||[]){
   if(stopRequested)break;
   if(source.type!=='catalog'||(config.sourceIds?.length&&!config.sourceIds.includes(source.id)))continue;
   const previous=(await chrome.storage.local.get(sourceKey(source.id)))[sourceKey(source.id)];
   if(!previous?.items?.length)continue;
   const effective=source.discoveryMode==='auto'?await autoConfigureSource(source):source;
   // Only reread lists and their layout. Existing detail pages, filter
   // memberships and inaccessible-item statuses remain attached to their URLs.
   const disc=await discoverCatalogCards(effective);
   const old=new Map(previous.items.map(item=>[canonical(item.url),item]));
   const fresh=new Set(disc.items.map(item=>canonical(item.url)));
   const items=disc.items.map(item=>({...old.get(canonical(item.url)),...item,
     meta:{...(old.get(canonical(item.url))?.meta||{}),...(item.meta||{})},
     panelHtml:item.panelHtml||old.get(canonical(item.url))?.panelHtml||null}));
   items.push(...previous.items.filter(item=>!fresh.has(canonical(item.url))));
   const complete=!['stopped','page-error','max-items','repeated-page'].includes(disc.endedReason)&&(!disc.expectedListPages||disc.listPages.length>=disc.expectedListPages);
   const meta={...previous,items,itemCount:items.length,catalog:disc.catalog||previous.catalog,
     exactFilters:(previous.exactFilters||[]).map(def=>complete&&disc.items.every(item=>old.has(canonical(item.url)))?def:{...def,complete:false,reason:'catalog-membership-changed'}),
     filters:mergeCatalogFilters(previous.filters,disc.filterDefinitions),listPages:disc.pageStats,
     expectedListPages:disc.expectedListPages,paginationEndReason:disc.endedReason,
     discoveryComplete:complete,complete:complete&&sourceComplete(previous),updatedAt:new Date().toISOString()};
   await chrome.storage.local.set({[sourceKey(source.id)]:meta});
   log(`${source.name}: refreshed ${disc.items.length} catalog rows; existing detail content retained.`);
   if(!stopRequested && effective.captureMode==='page'){
    let tried=0;
    for(const item of items){
     const record=(await chrome.storage.local.get(detailKey(item.url)))[detailKey(item.url)];
     if(!record?.html || record.presentation?.mode==='page')continue;
     try{
      const result=await openTask(item.url,{type:'EXTRACT_DETAIL_LAYOUT',source:effective});
      if(result?.layout){
       const key=stylesKey(source.id),saved=(await chrome.storage.local.get(key))[key]||{};
       await chrome.storage.local.set({[key]:{...saved,articleLayout:result.layout}});break;
      }
     }catch(error){log(`Article layout: ${error.message||error}`);}
     if(++tried>=3||stopRequested)break;
    }
   }
  }
 }finally{await closeCrawlWindow();}
 if(!stopRequested)await buildIndexes();
}
