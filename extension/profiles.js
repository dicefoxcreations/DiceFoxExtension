"use strict";
const $=id=>document.getElementById(id); LWLI18n.apply();
let profiles=[],current=null,pendingDetection=null,selectedCandidate=null;
function setStatus(s,e=false){$("status").textContent=s;$("status").style.color=e?"#b42318":"";}

function safeDebugUrl(raw){
  try{const u=new URL(raw);const re=/(token|auth|session|sid|secret|password|passwd|key|signature|sig|jwt|cookie|csrf|xsrf|oauth|code)/i;for(const k of [...u.searchParams.keys()])if(re.test(k))u.searchParams.set(k,"<redacted>");u.hash="";return u.href;}catch{return String(raw||"");}
}
function sanitizeDetectionForReport(d){
  const clone=JSON.parse(JSON.stringify(d||{}));
  if(clone.page?.url)clone.page.url=safeDebugUrl(clone.page.url);
  if(clone.pagination?.nextUrl)clone.pagination.nextUrl=safeDebugUrl(clone.pagination.nextUrl);
  clone.controls=(clone.controls||[]).map(c=>{const x={...c};if(x.type!=="select"&&!['checkbox','radio','pressed'].includes(x.type)&&x.value)x.value="<redacted-user-input>";return x;});
  clone.suggestions=(clone.suggestions||[]).map(c=>({...c,samples:(c.samples||[]).map(x=>typeof x==='string'?x:{...x,url:safeDebugUrl(x.url)}),targets:(c.targets||[]).map(x=>({...x,url:safeDebugUrl(x.url)}))}));
  return clone;
}
function selectedOptionLabels(c){
  if(c?.type!=="select")return [];
  const wanted=new Set((Array.isArray(c.value)?c.value:[c.value]).filter(v=>v!==undefined&&v!==null).map(String));
  return (c.options||[]).filter(o=>o.selected||wanted.has(String(o.value))).map(o=>o.label||String(o.value));
}
function currentDetectionSelection(){
  const selectedFilters=[...document.querySelectorAll("#detectedFilters input[type=checkbox]:checked")].map(cb=>{
    const c=pendingDetection?.controls?.[Number(cb.dataset.idx)];if(!c)return null;
    const out={label:c.label,type:c.type,selector:c.selector};
    if(c.type==="select"){out.value=c.value;out.selectedOptionLabels=selectedOptionLabels(c);}
    else if(["checkbox","radio","pressed"].includes(c.type))out.checked=Boolean(c.checked);
    return out;
  }).filter(Boolean);
  const pages=Number(pendingDetection?.pagination?.lastPage||0);
  const fs=pendingDetection?.fullPaginationScan||null;
  const perPage=Number(fs?.previewItemCount||selectedCandidate?.usableItemCount||selectedCandidate?.itemCount||selectedCandidate?.familyMatchCount||0);
  const estimatedCatalogCapacity=fs?.completed&&Number(fs.uniqueItems)>0?Number(fs.uniqueItems):((Number.isFinite(pages)&&pages>1&&Number.isFinite(perPage)&&perPage>0)?Math.ceil(pages*perPage):null);
  return {candidateId:selectedCandidate?.id||null,suggestedKind:selectedCandidate?.kind||null,chosenType:$("detectedSourceType")?.value||null,chosenName:$("detectedSourceName")?.value||null,selectedFilters,estimatedCatalogCapacity,computedMaxItems:selectedCandidate?detectedMaxItems(selectedCandidate):null,fullPaginationScan:pendingDetection?.fullPaginationScan||null};
}
async function exportDetectionDebugReport(){
  if(!pendingDetection?.page)throw new Error(LWLI18n.t("noDetectionReport"));
  const clean=sanitizeDetectionForReport(pendingDetection);
  const report={
    format:"local-web-library-detection-debug",
    formatVersion:4,
    extensionVersion:chrome.runtime.getManifest().version,
    generatedAt:new Date().toISOString(),
    uiLanguage:LWLI18n.lang,
    privacy:{pageBodyIncluded:false,cookiesIncluded:false,localStorageIncluded:false,passwordValuesIncluded:false,textInputValuesIncluded:false,note:"Visible URLs, link titles and selectors are included because they are needed to debug detection. Sensitive-looking query parameters and typed text input values are redacted."},
    page:clean.page,
    detection:{contentSelector:clean.contentSelector,pagination:clean.pagination,controls:clean.controls,suggestions:clean.suggestions,diagnostics:clean.diagnostics||null,fullPaginationScan:clean.fullPaginationScan||null,paginationScanDebug:sanitizePaginationScanDebug(await collectPaginationScanDebug())},
    userSelection:currentDetectionSelection()
  };
  const blob=new Blob([JSON.stringify(report,null,2)],{type:"application/json;charset=utf-8"});
  const url=URL.createObjectURL(blob),a=document.createElement("a");
  let host="site";try{host=new URL(clean.page.url).hostname.replace(/[^a-z0-9.-]+/gi,"-");}catch{}
  a.href=url;a.download=`lwl-detection-debug-${host}-${new Date().toISOString().slice(0,10)}.json`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
}

function filterActionFromDetected(c){
  if(!c?.selector)return null;
  if(c.type==="checkbox"||c.type==="radio"||c.type==="pressed")return {type:c.type,selector:c.selector,checked:Boolean(c.checked),waitMs:150};
  if(c.type==="select")return {type:"select",selector:c.selector,value:c.value,waitMs:200};
  if(c.type==="click")return {type:"click",selector:c.selector,waitMs:200};
  if(c.type==="interactive"||c.type==="aria-check")return null;
  return {type:"input",selector:c.selector,value:c.value||"",waitMs:150};
}
function selectedDetectedFilters(){return [...document.querySelectorAll("#detectedFilters input[type=checkbox]:checked")].map(cb=>filterActionFromDetected(pendingDetection?.controls?.[Number(cb.dataset.idx)])).filter(Boolean);}
function detectedMaxItems(c){
  const base=5000,fs=pendingDetection?.fullPaginationScan||null;
  if(fs?.completed&&Number(fs.uniqueItems)>0)return Math.max(base,Number(fs.uniqueItems));
  const pages=Number(pendingDetection?.pagination?.lastPage||0);
  const perPage=Number(fs?.previewItemCount||c?.usableItemCount||c?.itemCount||c?.familyMatchCount||0);
  if(Number.isFinite(pages)&&pages>1&&Number.isFinite(perPage)&&perPage>0)return Math.max(base,Math.ceil(pages*perPage));
  return base;
}
/* The filters the site offers itself. Ticking one makes the sync walk the list
   once per option value, which reproduces that filter exactly - including
   dimensions that appear nowhere in an item's markup. The cost is shown per
   dimension because it is real: one extra pass over the list pages. */
const EXACT_FACET_MAX_OPTIONS=60;
function selectableFacetOptions(def){
  return (def.options||[])
    .filter(o=>String(o.value??"").trim()!=="")
    .map(o=>String(o.label||o.value).trim())
    .filter(l=>l && !/^(all|any|alle|beliebig|—|-)$/i.test(l));
}
function renderExactFacets(){
  const box=$("exactFacets"),panel=$("exactFacetDetails");
  if(!box||!panel)return;
  box.textContent="";
  const defs=(pendingDetection?.filterDefinitions||[]).filter(d=>d.name&&d.type==="select");
  const listPages=Math.max(1,Number(pendingDetection?.pagination?.lastPage||1));
  const usable=defs.filter(d=>selectableFacetOptions(d).length>=2);
  panel.hidden=!usable.length;
  if(!usable.length)return;
  for(const def of usable){
    const options=selectableFacetOptions(def);
    const tooMany=options.length>EXACT_FACET_MAX_OPTIONS;
    const lab=document.createElement("label");
    lab.className="filter-chip";
    const cb=document.createElement("input");
    cb.type="checkbox"; cb.dataset.name=def.name; cb.disabled=tooMany;
    const span=document.createElement("span");
    span.textContent=def.label||def.name;
    const sm=document.createElement("small");
    /* One pass per option value; a dimension where each item has exactly one
       value spreads the same items over its options, so the total is close to
       one extra walk of the list. */
    const pages=Math.max(options.length,listPages);
    sm.textContent=tooMany
      ? LWLI18n.t("exactFacetsTooMany",[String(options.length)])
      : LWLI18n.t("exactFacetsCost",[String(options.length),String(pages)]);
    span.append(sm); lab.append(cb,span); box.append(lab);
  }
}
function selectedExactFacets(){
  return [...document.querySelectorAll("#exactFacets input[type=checkbox]:checked")].map(cb=>cb.dataset.name).filter(Boolean);
}

function candidateToSource(c){
  const type=$("detectedSourceType").value||c.kind||"section";
  const discoveryMode=type===c.kind?"auto":"configured";
  const src={name:$("detectedSourceName").value.trim()||pendingDetection?.page?.title||"Detected source",type,startUrl:pendingDetection.page.url,contentSelector:pendingDetection.contentSelector||"main, article, [role='main'], body",filters:selectedDetectedFilters(),facetFilters:selectedExactFacets(),maxItems:detectedMaxItems(c),catalogMode:type==="catalog"?"content":undefined,expandCards:type==="catalog",detailPages:type!=="catalog",discoveryMode};
  if(c.metrics?.structuralContainerSelector)src.itemContainerSelector=c.metrics.structuralContainerSelector;
  if(c.catalogView){src.catalogView=c.catalogView;src.pageSelector=c.pageSelector;}
  if(c.navigationSelector)src.navigationSelector=c.navigationSelector;
  if(c.pageUrlPatterns)src.pageUrlPatterns=c.pageUrlPatterns;
  if(type==="section")src.followDepth=2;
  if(type==="glossary"&&(c.termSelector||c.definitionSelector))src.glossary={termSelector:c.termSelector||"dt",definitionSelector:c.definitionSelector||"dd"};
  if(pendingDetection.pagination?.detected){
    const lastPage=Number(pendingDetection.pagination.lastPage||0);
    src.pagination={mode:"auto",selector:pendingDetection.pagination.selector||null,pageParam:pendingDetection.pagination.pageParam||null};
    if(Number.isFinite(lastPage)&&lastPage>0)src.pagination.maxPages=lastPage;
  }
  return LWLProfiles.normalizeSource(src,0,pendingDetection.page.origin);
}
function inferSourceTypeFromLink(x){const h=`${x.title||""} ${x.url||""}`.toLowerCase();if(/glossar|glossary|definitions|terms|begriffe/.test(h))return"glossary";if(/library|books|sources|manuals|handbooks|publications|archive|bibliothek|bücher/.test(h))return"collection";if(/catalog|database|directory|index|reference|listing|results|components|entries|items|api/.test(h))return"catalog";return"section";}
function childTargetLabels(){return [...document.querySelectorAll("#childLinks .child-link")];}
function updateChildSelectionCount(){const boxes=[...document.querySelectorAll("#childLinks input[type=checkbox]")];const selected=boxes.filter(cb=>cb.checked).length;const shown=childTargetLabels().filter(lab=>!lab.hidden).length;const el=$("childSelectionCount");if(el)el.textContent=shown===boxes.length?LWLI18n.t("selectedOf",[String(selected),String(boxes.length)]):LWLI18n.t("selectedOfShown",[String(selected),String(boxes.length),String(shown)]);}
function setAllChildTargets(checked){document.querySelectorAll("#childLinks input[type=checkbox]").forEach(cb=>{if(!cb.disabled)cb.checked=checked;});updateChildSelectionCount();}
function setVisibleChildTargets(checked){childTargetLabels().filter(lab=>!lab.hidden).forEach(lab=>{const cb=lab.querySelector("input[type=checkbox]");if(cb&&!cb.disabled)cb.checked=checked;});updateChildSelectionCount();}
function filterChildTargets(){const q=String($("childSearch")?.value||"").trim().toLocaleLowerCase();for(const lab of childTargetLabels())lab.hidden=Boolean(q)&&!String(lab.dataset.search||"").includes(q);updateChildSelectionCount();}
function detectionPageUrl(startUrl,pageParam,pageNo){try{const u=new URL(startUrl);if(pageNo<=1)u.searchParams.delete(pageParam);else u.searchParams.set(pageParam,String(pageNo));return u.href;}catch{return startUrl;}}
const PAGINATION_SCAN_META_KEY="lwl_detection_scan_meta_v1",PAGINATION_SCAN_PAGE_PREFIX="lwl_detection_scan_page_v1_";
const PAGINATION_SCAN_DEBUG_META_KEY="lwl_detection_scan_debug_meta_v1",PAGINATION_SCAN_DEBUG_PAGE_PREFIX="lwl_detection_scan_debug_page_v1_",PAGINATION_SCAN_CONTENT_LIVE_KEY="lwl_detection_scan_content_live_v1";
let paginationScanAbortRequested=false,paginationScanDebugMeta=null,paginationScanDebugContentLive=null,paginationScanDebugPollTimer=null,paginationScanDebugLastPageTrace=null;
function paginationScanDebugPageKey(pageNo){return `${PAGINATION_SCAN_DEBUG_PAGE_PREFIX}${pageNo}`;}
function scanDebugIso(){return new Date().toISOString();}
function scanDebugIdentity(){const id=paginationScanIdentity();return {...id,extensionVersion:chrome.runtime.getManifest().version};}
function scanDebugLive(meta=paginationScanDebugMeta,pageTrace=paginationScanDebugLastPageTrace,contentLive=paginationScanDebugContentLive){
  const el=$("paginationScanDebugLive");if(!el)return;const parts=[];
  if(meta){parts.push(`Status: ${meta.running?"RUNNING":meta.completed?"COMPLETED":"IDLE"}`);parts.push(`Page: ${meta.currentPage||meta.lastSuccessfulPage||0}/${meta.expectedPages||0}`);if(meta.currentAttempt)parts.push(`Attempt: ${meta.currentAttempt}`);if(meta.currentStep)parts.push(`Outer step: ${meta.currentStep}`);if(meta.scanTabGeneration)parts.push(`Scan tab generation: ${meta.scanTabGeneration}`);if(meta.lastTabRotationReason)parts.push(`Last tab rotation: ${meta.lastTabRotationReason}`);if(meta.lastSuccessfulPage!=null)parts.push(`Last successful page: ${meta.lastSuccessfulPage}`);if(meta.uniqueItems!=null)parts.push(`Unique items: ${meta.uniqueItems}`);if(meta.lastError)parts.push(`Last error: ${meta.lastError}`);}
  const a=pageTrace?.attempts?.[pageTrace.attempts.length-1];if(a){if(a.requestedUrl)parts.push(`Requested: ${safeDebugUrl(a.requestedUrl)}`);if(a.actualUrl)parts.push(`Actual: ${safeDebugUrl(a.actualUrl)}`);if(a.tabComplete!==undefined)parts.push(`tabComplete: ${a.tabComplete}`);if(a.itemCount!=null)parts.push(`Page items: ${a.itemCount}`);if(a.totalMs!=null)parts.push(`Attempt ms: ${a.totalMs}`);}
  if(contentLive&&(!meta?.activeSessionId||contentLive.sessionId===meta.activeSessionId)){parts.push(`Content step: ${contentLive.stage||"?"}`);if(contentLive.updatedAt)parts.push(`Content updated: ${contentLive.updatedAt}`);if(contentLive.itemCount!=null)parts.push(`Content items: ${contentLive.itemCount}`);if(contentLive.discoveryMs!=null)parts.push(`Content discovery ms: ${contentLive.discoveryMs}`);if(contentLive.pageStats?.elementCount!=null)parts.push(`DOM elements: ${contentLive.pageStats.elementCount}`);if(contentLive.pageStats?.memory?.usedJSHeapSize)parts.push(`Tab JS heap: ${Math.round(contentLive.pageStats.memory.usedJSHeapSize/1048576)} MiB`);}
  el.textContent=parts.join("\n");
}
async function scanDebugPollContentOnce(){try{const st=await chrome.storage.local.get(PAGINATION_SCAN_CONTENT_LIVE_KEY);paginationScanDebugContentLive=st[PAGINATION_SCAN_CONTENT_LIVE_KEY]||null;scanDebugLive();}catch{}}
function scanDebugStartPolling(){if(paginationScanDebugPollTimer)return;scanDebugPollContentOnce();paginationScanDebugPollTimer=setInterval(scanDebugPollContentOnce,1000);}
function scanDebugStopPolling(){if(paginationScanDebugPollTimer){clearInterval(paginationScanDebugPollTimer);paginationScanDebugPollTimer=null;}scanDebugPollContentOnce();}
async function scanDebugReadMeta(){if(paginationScanDebugMeta)return paginationScanDebugMeta;const st=await chrome.storage.local.get(PAGINATION_SCAN_DEBUG_META_KEY);paginationScanDebugMeta=st[PAGINATION_SCAN_DEBUG_META_KEY]||null;return paginationScanDebugMeta;}
async function scanDebugPersistMeta(patch={}){const prev=(await scanDebugReadMeta())||{},id=scanDebugIdentity();paginationScanDebugMeta={...prev,...id,...patch,updatedAt:scanDebugIso()};await chrome.storage.local.set({[PAGINATION_SCAN_DEBUG_META_KEY]:paginationScanDebugMeta});scanDebugLive(paginationScanDebugMeta);return paginationScanDebugMeta;}
async function scanDebugLoadPage(pageNo){const key=paginationScanDebugPageKey(pageNo),st=await chrome.storage.local.get(key);return st[key]||{pageNo:Number(pageNo),attempts:[]};}
async function scanDebugPersistPage(pageTrace,metaPatch={}){paginationScanDebugLastPageTrace=pageTrace;await chrome.storage.local.set({[paginationScanDebugPageKey(pageTrace.pageNo)]:pageTrace});const meta=await scanDebugPersistMeta(metaPatch);scanDebugLive(meta,pageTrace);}
async function scanDebugBegin(lastPage,startPage){const id=scanDebugIdentity(),old=await scanDebugReadMeta();if(old&&(old.pageUrl!==id.pageUrl||old.candidateId!==id.candidateId||Number(old.expectedPages||0)!==Number(lastPage||0))){const n=Math.max(Number(old.expectedPages||0),Number(old.currentPage||0),Number(old.lastSuccessfulPage||0));const keys=[PAGINATION_SCAN_DEBUG_META_KEY];for(let i=1;i<=n;i++)keys.push(paginationScanDebugPageKey(i));await chrome.storage.local.remove(keys);paginationScanDebugMeta=null;}const prev=(await scanDebugReadMeta())||{},sessions=[...(prev.sessions||[])],sessionId=`scan-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;sessions.push({sessionId,startedAt:scanDebugIso(),startPage:Number(startPage||1)});await chrome.storage.local.remove(PAGINATION_SCAN_CONTENT_LIVE_KEY).catch(()=>{});paginationScanDebugContentLive=null;await scanDebugPersistMeta({expectedPages:Number(lastPage||0),running:true,completed:false,currentPage:Number(startPage||1),currentAttempt:0,currentStep:"scan:start",lastError:null,sessions,activeSessionId:sessionId});scanDebugStartPolling();return sessionId;}
async function scanDebugStep(pageNo,pageTrace,attemptTrace,step,extra={}){const at=scanDebugIso();attemptTrace.step=step;attemptTrace.stepUpdatedAt=at;attemptTrace.events=attemptTrace.events||[];attemptTrace.events.push({stage:step,at,...(extra||{})});Object.assign(attemptTrace,extra||{});await scanDebugPersistPage(pageTrace,{running:true,currentPage:Number(pageNo),currentAttempt:Number(attemptTrace.attempt||0),currentStep:step,lastError:null});}
async function scanDebugFinish(completed,lastSuccessfulPage,uniqueItems,lastError=null){scanDebugStopPolling();const meta=await scanDebugPersistMeta({running:false,completed:Boolean(completed),currentStep:completed?"scan:complete":"scan:stopped",lastSuccessfulPage:Number(lastSuccessfulPage||0),uniqueItems:Number(uniqueItems||0),lastError:lastError||null,finishedAt:scanDebugIso()});scanDebugLive(meta);}
async function collectPaginationScanDebug(){const meta=await scanDebugReadMeta();if(!meta)return null;const maxPage=Math.max(Number(meta.expectedPages||0),Number(meta.currentPage||0),Number(meta.lastSuccessfulPage||0));const keys=[];for(let i=1;i<=maxPage;i++)keys.push(paginationScanDebugPageKey(i));const st=keys.length?await chrome.storage.local.get(keys):{},pages=[];for(let i=1;i<=maxPage;i++){const x=st[paginationScanDebugPageKey(i)];if(x)pages.push(x);}const liveSt=await chrome.storage.local.get(PAGINATION_SCAN_CONTENT_LIVE_KEY);const contentLive=liveSt[PAGINATION_SCAN_CONTENT_LIVE_KEY]||null;return {format:"local-web-library-pagination-scan-debug",formatVersion:2,...scanDebugIdentity(),generatedAt:scanDebugIso(),meta,contentLive,pages};}
function sanitizePaginationScanDebug(d){if(!d)return null;const clone=JSON.parse(JSON.stringify(d));const clean=u=>safeDebugUrl(u);if(clone.pageUrl)clone.pageUrl=clean(clone.pageUrl);if(clone.contentLive?.url)clone.contentLive.url=clean(clone.contentLive.url);if(clone.contentLive?.pageStats?.url)clone.contentLive.pageStats.url=clean(clone.contentLive.pageStats.url);for(const p of clone.pages||[])for(const a of p.attempts||[]){if(a.requestedUrl)a.requestedUrl=clean(a.requestedUrl);if(a.actualUrl)a.actualUrl=clean(a.actualUrl);if(a.returnedUrl)a.returnedUrl=clean(a.returnedUrl);if(a.nextUrl)a.nextUrl=clean(a.nextUrl);if(a.contentDebug?.pageBefore?.url)a.contentDebug.pageBefore.url=clean(a.contentDebug.pageBefore.url);if(a.contentDebug?.pageAfterFilters?.url)a.contentDebug.pageAfterFilters.url=clean(a.contentDebug.pageAfterFilters.url);}return clone;}
async function exportPaginationScanDebugReport(){const raw=await collectPaginationScanDebug();if(!raw)throw new Error("No pagination scan debug data available yet");const report=sanitizePaginationScanDebug(raw);const blob=new Blob([JSON.stringify(report,null,2)],{type:"application/json;charset=utf-8"});const url=URL.createObjectURL(blob),a=document.createElement("a");let host="site";try{host=new URL(report.pageUrl).hostname.replace(/[^a-z0-9.-]+/gi,"-");}catch{}a.href=url;a.download=`lwl-pagination-scan-debug-${host}-${new Date().toISOString().replace(/[:.]/g,"-")}.json`;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function paginationScanIdentity(){return {pageUrl:String(pendingDetection?.page?.url||""),candidateId:String(selectedCandidate?.id||"")};}
function paginationScanPageKey(pageNo){return `${PAGINATION_SCAN_PAGE_PREFIX}${pageNo}`;}
function compactPaginationScanItem(x){return {title:String(x?.title||""),secondaryTitle:x?.secondaryTitle||null,url:x?.url||null,sameOrigin:x?.sameOrigin!==false,structuralOutlier:Boolean(x?.structuralOutlier)};}
async function clearPaginationScanDebug(meta=null){
  if(!meta){const st=await chrome.storage.local.get(PAGINATION_SCAN_DEBUG_META_KEY);meta=st[PAGINATION_SCAN_DEBUG_META_KEY]||null;}
  const n=Math.max(0,Number(meta?.expectedPages||0),Number(meta?.currentPage||0),Number(meta?.lastSuccessfulPage||0));const keys=[PAGINATION_SCAN_DEBUG_META_KEY,PAGINATION_SCAN_CONTENT_LIVE_KEY];for(let i=1;i<=n;i++)keys.push(paginationScanDebugPageKey(i));await chrome.storage.local.remove(keys);paginationScanDebugMeta=null;paginationScanDebugContentLive=null;paginationScanDebugLastPageTrace=null;scanDebugStopPolling();scanDebugLive(null,null,null);
}
async function clearPaginationCheckpoint(meta=null){
  if(!meta){const st=await chrome.storage.local.get(PAGINATION_SCAN_META_KEY);meta=st[PAGINATION_SCAN_META_KEY]||null;}
  const n=Math.max(0,Number(meta?.expectedPages||0),Number(meta?.scannedPages||0));
  const keys=[PAGINATION_SCAN_META_KEY];for(let i=1;i<=n;i++)keys.push(paginationScanPageKey(i));
  await chrome.storage.local.remove(keys);await clearPaginationScanDebug().catch(()=>{});
}
async function ensurePaginationCheckpointIdentity(lastPage){
  const st=await chrome.storage.local.get(PAGINATION_SCAN_META_KEY),meta=st[PAGINATION_SCAN_META_KEY]||null,id=paginationScanIdentity();
  if(meta&&(meta.pageUrl!==id.pageUrl||meta.candidateId!==id.candidateId)){await clearPaginationCheckpoint(meta);return null;}
  if(meta&&Number(meta.expectedPages||0)!==Number(lastPage||0)){await clearPaginationCheckpoint(meta);return null;}
  return meta;
}
async function persistPaginationScanMeta(scanned,lastPage,uniqueItems,completed=false,lastError=null){
  const prev=pendingDetection?.fullPaginationScan||{},id=paginationScanIdentity();
  const meta={...id,scannedPages:Number(scanned||0),expectedPages:Number(lastPage||0),uniqueItems:Number(uniqueItems||0),previewItemCount:Number(prev.previewItemCount||selectedCandidate?.previewItemCount||0),completed:Boolean(completed),lastError:lastError||null,updatedAt:new Date().toISOString(),...(completed?{completedAt:new Date().toISOString()}:{})};
  await chrome.storage.local.set({[PAGINATION_SCAN_META_KEY]:meta});return meta;
}
async function persistPaginationScanPage(pageNo,lastPage,rows,map,completed=false,lastError=null){
  const payload=(rows||[]).filter(x=>x?.url).map(compactPaginationScanItem);
  await chrome.storage.local.set({[paginationScanPageKey(pageNo)]:payload});
  await persistPaginationScanMeta(pageNo,lastPage,map.size,completed,lastError);
}
async function restorePaginationCheckpoint(){
  if(!pendingDetection||!selectedCandidate)return false;
  const st=await chrome.storage.local.get(PAGINATION_SCAN_META_KEY),meta=st[PAGINATION_SCAN_META_KEY]||null,id=paginationScanIdentity();
  if(!meta||meta.pageUrl!==id.pageUrl||meta.candidateId!==id.candidateId)return false;
  const scanned=Math.max(0,Number(meta.scannedPages||0)),lastPage=Math.max(scanned,Number(meta.expectedPages||0));if(!scanned)return false;
  const keys=[];for(let i=1;i<=scanned;i++)keys.push(paginationScanPageKey(i));
  const pages=await chrome.storage.local.get(keys),map=new Map();
  for(let i=1;i<=scanned;i++)for(const x of (pages[paginationScanPageKey(i)]||[]))if(x?.url)map.set(x.url,{...x});
  if(!map.size)return false;
  pendingDetection.fullPaginationScan={completed:Boolean(meta.completed),scannedPages:scanned,expectedPages:lastPage,uniqueItems:map.size,previewItemCount:Number(meta.previewItemCount||0),lastError:meta.lastError||null,updatedAt:meta.updatedAt||null,...(meta.completedAt?{completedAt:meta.completedAt}:{})};
  commitPaginationScan(map,scanned,lastPage,Boolean(meta.completed),meta.lastError||null);renderChildTargets(selectedCandidate);updatePaginationScanUi(selectedCandidate);return true;
}
function appendChildTargets(items){
  const area=$("childArea"),host=$("childLinks");if(!area||!host||!items?.length)return;
  const all=selectedCandidate?.detectedTargets||selectedCandidate?.targets||[],start=Math.max(0,all.length-items.length),q=String($("childSearch")?.value||"").trim().toLocaleLowerCase();
  area.hidden=false;
  items.forEach((x,j)=>{const i=start+j,lab=document.createElement("label");lab.className="child-link";const cb=document.createElement("input");cb.type="checkbox";cb.dataset.idx=String(i);const usable=Boolean(x?.url)&&x.sameOrigin!==false;cb.checked=usable;cb.disabled=!usable;cb.addEventListener("change",updateChildSelectionCount);const span=document.createElement("span");const base=x.title||x.url||"Detected item without a direct link";span.textContent=base+(x.secondaryTitle?` — ${x.secondaryTitle}`:"");lab.dataset.search=`${base} ${x.secondaryTitle||""} ${x.url||""}`.toLocaleLowerCase();const sm=document.createElement("small");sm.textContent=x.url?`${inferSourceTypeFromLink(x)} · ${x.url}${x.structuralOutlier?" · structural outlier":""}`:"structural item · no direct URL detected";span.append(sm);lab.append(cb,span);lab.hidden=Boolean(q)&&!lab.dataset.search.includes(q);host.append(lab);});
  updateChildSelectionCount();
}
function commitPaginationScan(map,scanned,lastPage,completed=false,lastError=null){
  const all=[...map.values()],prev=pendingDetection.fullPaginationScan||{};
  const previewItemCount=Number(prev.previewItemCount||selectedCandidate.previewItemCount||0);
  selectedCandidate.detectedTargets=all;selectedCandidate.targets=all;selectedCandidate.itemCount=all.length;selectedCandidate.usableItemCount=all.length;selectedCandidate.uniqueTargetCount=all.length;
  pendingDetection.fullPaginationScan={completed,scannedPages:scanned,expectedPages:lastPage,uniqueItems:all.length,previewItemCount,lastError:lastError||null,updatedAt:new Date().toISOString(),...(completed?{completedAt:new Date().toISOString()}:{})};
  return all;
}
/* One list page, loaded through the background worker's crawl window.

   This used to create, rotate and remove its own tabs in the user's window.
   The worker owns a reused tab pool in a separate window now, so the whole
   rotation machinery is gone; what stays here is the retry loop and the trace,
   because both are read by the debug report this page exports. */
function scanOrigin(source){try{return new URL(source.startUrl).origin;}catch{return null;}}
async function discoverDetectionPage(url,source,pageNo,pageParam,sessionId){
  let lastError=null,pageTrace=await scanDebugLoadPage(pageNo);
  const attemptBase=Array.isArray(pageTrace.attempts)?pageTrace.attempts.length:0;
  for(let localAttempt=1;localAttempt<=3;localAttempt++){
    const attempt=attemptBase+localAttempt;
    const attemptTrace={sessionId,attempt,startedAt:scanDebugIso(),requestedUrl:url};
    pageTrace.attempts=pageTrace.attempts||[];pageTrace.attempts.push(attemptTrace);
    const attemptStart=performance.now();
    try{
      await scanDebugStep(pageNo,pageTrace,attemptTrace,"pagetask:start");
      const taskStart=performance.now();
      const res=await chrome.runtime.sendMessage({target:"background",type:"PAGE_TASK",task:{
        url,
        message:{type:"DISCOVER_SOURCE",source,scanDebug:{sessionId,pageNo,attempt}},
        origin:scanOrigin(source),
        timeoutMs:localAttempt===1?45000:60000
      }});
      attemptTrace.pageTaskMs=Math.round(performance.now()-taskStart);
      if(!res?.ok)throw new Error(res?.error||`Could not load page ${pageNo}`);
      attemptTrace.actualUrl=res.finalUrl||null;attemptTrace.tabStatus=res.tabStatus||null;attemptTrace.tabTitle=res.tabTitle||null;
      if(pageParam&&pageNo>1){
        try{const actual=Number(new URL(res.finalUrl).searchParams.get(pageParam)||1);attemptTrace.actualPage=actual;if(actual!==pageNo)throw new Error(`page changed to ${actual}`);}catch(e){if(String(e?.message||e).startsWith("page changed"))throw e;}
      }
      const out=res.result;
      attemptTrace.returnedUrl=out?.url||null;attemptTrace.nextUrl=out?.nextUrl||null;attemptTrace.itemCount=Array.isArray(out?.items)?out.items.length:null;attemptTrace.contentDebug=out?._debug||null;
      if(!out?.ok)throw new Error(out?.error||`Discovery failed on page ${pageNo}`);
      attemptTrace.totalMs=Math.round(performance.now()-attemptStart);attemptTrace.finishedAt=scanDebugIso();attemptTrace.ok=true;
      await scanDebugStep(pageNo,pageTrace,attemptTrace,"discovery:success",{totalMs:attemptTrace.totalMs});
      return {out,pageTrace,attemptTrace};
    }catch(e){
      const err=e instanceof Error?e:new Error(String(e));
      lastError=err;attemptTrace.ok=false;attemptTrace.error=String(err.message||err);attemptTrace.totalMs=Math.round(performance.now()-attemptStart);attemptTrace.finishedAt=scanDebugIso();attemptTrace.events=attemptTrace.events||[];attemptTrace.events.push({stage:"attempt:error",at:scanDebugIso(),error:attemptTrace.error});
      await scanDebugPersistPage(pageTrace,{running:true,currentPage:Number(pageNo),currentAttempt:Number(attempt),currentStep:"attempt:error",lastError:attemptTrace.error});
      if(localAttempt<3){await scanDebugPersistMeta({currentStep:"retry:backoff",lastError:attemptTrace.error});await new Promise(r=>setTimeout(r,800*localAttempt));}
    }
  }
  throw lastError||new Error(`Discovery failed on page ${pageNo}`);
}
async function scanDetectionAllPages(){
  if(!pendingDetection||!selectedCandidate)return;
  const pg=pendingDetection.pagination||{},lastPage=Number(pg.lastPage||0),pageParam=pg.pageParam||null;
  if(!pg.detected||lastPage<2)throw new Error("No multi-page pagination was detected");
  const source=candidateToSource(selectedCandidate);
  await ensurePaginationCheckpointIdentity(lastPage);
  const existingFs=pendingDetection.fullPaginationScan||{};
  if(!existingFs.previewItemCount)pendingDetection.fullPaginationScan={...existingFs,previewItemCount:Number(selectedCandidate.usableItemCount||selectedCandidate.itemCount||selectedCandidate.familyMatchCount||0)};
  const map=new Map();
  for(const x of (selectedCandidate.detectedTargets||selectedCandidate.targets||[])){if(x?.url)map.set(x.url,{...x});}
  const prev=pendingDetection.fullPaginationScan||{};
  let scanned=prev.completed?0:Math.max(0,Number(prev.scannedPages||0));
  let startPage=Math.max(1,scanned+1),nextUrl=source.startUrl;
  if(!pageParam&&startPage>1){scanned=0;startPage=1;}
  paginationScanAbortRequested=false;
  const sessionId=await scanDebugBegin(lastPage,startPage);
   let completed=false,lastError=null;
  try{
    for(let pageNo=startPage;pageNo<=lastPage;pageNo++){
      if(paginationScanAbortRequested){lastError="Scan cancelled by user";await scanDebugPersistMeta({currentPage:pageNo,currentStep:"scan:cancel-requested",lastError});break;}
      const status=$("paginationScanStatus");if(status)status.textContent=LWLI18n.t("paginationScanRunning",[String(pageNo),String(lastPage)]);
      const url=pageParam?detectionPageUrl(source.startUrl,pageParam,pageNo):nextUrl;
      if(!url)break;
      let result;
      try{
        result=await discoverDetectionPage(url,source,pageNo,pageParam,sessionId);
      }catch(e){
          const msg=`Page ${pageNo}: ${String(e.message||e)}`;lastError=msg;commitPaginationScan(map,scanned,lastPage,false,msg);await persistPaginationScanMeta(scanned,lastPage,map.size,false,msg);renderChildTargets(selectedCandidate);await scanDebugFinish(false,scanned,map.size,msg);
        throw new Error(`${msg}. ${scanned} page(s) saved; click scan again to resume.`);
      }
      const {out,pageTrace,attemptTrace}=result;
      await scanDebugStep(pageNo,pageTrace,attemptTrace,"merge:start",{uniqueBefore:map.size});
      const mergeStart=performance.now(),rows=out.items||[],added=[];for(const x of rows){if(!x?.url)continue;const item={...x,sameOrigin:x.sameOrigin!==false};if(!map.has(x.url))added.push(item);map.set(x.url,item);}attemptTrace.mergeMs=Math.round(performance.now()-mergeStart);attemptTrace.newItems=added.length;attemptTrace.uniqueAfter=map.size;
      scanned=pageNo;commitPaginationScan(map,scanned,lastPage,false,null);
      await scanDebugStep(pageNo,pageTrace,attemptTrace,"checkpoint:start",{newItems:added.length,uniqueAfter:map.size});
      const checkpointStart=performance.now();await persistPaginationScanPage(pageNo,lastPage,rows,map,false,null);attemptTrace.checkpointMs=Math.round(performance.now()-checkpointStart);
      await scanDebugStep(pageNo,pageTrace,attemptTrace,"ui:append:start");
      const uiStart=performance.now();appendChildTargets(added);attemptTrace.uiAppendMs=Math.round(performance.now()-uiStart);
      const usedHeap=Number(attemptTrace.contentDebug?.pageAfterFilters?.memory?.usedJSHeapSize||0);attemptTrace.usedJSHeapSize=usedHeap||null;
      attemptTrace.pageTotalMs=Number(attemptTrace.totalMs||0)+Number(attemptTrace.mergeMs||0)+Number(attemptTrace.checkpointMs||0)+Number(attemptTrace.uiAppendMs||0);attemptTrace.events=attemptTrace.events||[];attemptTrace.events.push({stage:"page:done",at:scanDebugIso(),pageTotalMs:attemptTrace.pageTotalMs,newItems:attemptTrace.newItems,uniqueItems:map.size,usedJSHeapSize:usedHeap||null});
      await scanDebugPersistPage(pageTrace,{running:true,currentPage:pageNo,currentAttempt:attemptTrace.attempt,currentStep:"page:done",lastSuccessfulPage:pageNo,uniqueItems:map.size,lastError:null});
      const statusNow=$("paginationScanStatus");if(statusNow)statusNow.textContent=LWLI18n.t("paginationScanRunningDetailed",[String(pageNo),String(lastPage),String(map.size)]);
      if(!pageParam){nextUrl=out.nextUrl||null;if(!nextUrl)break;}
      if(pageNo%10===0)await new Promise(r=>setTimeout(r,50));
    }
    completed=!paginationScanAbortRequested&&(scanned>=lastPage||(!pageParam&&!nextUrl));
  } finally {
    await scanDebugPersistMeta({currentStep:"scan:closing",lastSuccessfulPage:scanned,uniqueItems:map.size,lastError:lastError});
    await chrome.runtime.sendMessage({target:"background",type:"CRAWL_WINDOW_CLOSE"}).catch(()=>{});
  }
  const all=commitPaginationScan(map,scanned,lastPage,completed,lastError);await persistPaginationScanMeta(scanned,lastPage,map.size,completed,lastError);renderChildTargets(selectedCandidate);await scanDebugFinish(completed,scanned,map.size,lastError);
  const status=$("paginationScanStatus");if(status)status.textContent=completed?LWLI18n.t("paginationScanComplete",[String(all.length),String(scanned)]):LWLI18n.t("paginationScanPartial",[String(all.length),String(scanned),String(lastPage)]);
  const btn=$("scanAllPages");if(btn)btn.disabled=false;
}
function updatePaginationScanUi(c){
  const area=$("paginationScanArea"),summary=$("paginationScanSummary"),status=$("paginationScanStatus"),btn=$("scanAllPages");if(!area)return;
  const pg=pendingDetection?.pagination||{},pages=Number(pg.lastPage||0),isCatalog=(c?.kind==="catalog"||$("detectedSourceType")?.value==="catalog");
  area.hidden=!(isCatalog&&pg.detected&&pages>1);if(area.hidden)return;
  const fs=pendingDetection?.fullPaginationScan;const pageItems=Number(fs?.previewItemCount||c?.previewItemCount||c?.usableItemCount||c?.itemCount||0);
  /* Show the estimate and put the page count on the button: the scan is a
     verification aid, not a step towards a sync, and its cost has to be
     visible before it is clicked. */
  summary.textContent=LWLI18n.t("paginationPreview",[String(pageItems),String(pages)]);
  const estimate=$("paginationEstimate");
  if(estimate)estimate.textContent=LWLI18n.t("paginationEstimate",[String(pageItems*pages),String(pages)]);
  if(btn)btn.textContent=LWLI18n.t("scanAllPagesCount",[String(pages)]);
  if(fs?.completed)status.textContent=LWLI18n.t("paginationScanComplete",[String(fs.uniqueItems||0),String(fs.scannedPages||0)]);else if(Number(fs?.scannedPages)>0)status.textContent=LWLI18n.t("paginationScanPartial",[String(fs.uniqueItems||0),String(fs.scannedPages||0),String(fs.expectedPages||pages)]);else status.textContent=LWLI18n.t("paginationScanReady");
  if(btn)btn.disabled=false;
  scanDebugReadMeta().then(meta=>{if(meta&&meta.pageUrl===paginationScanIdentity().pageUrl&&meta.candidateId===paginationScanIdentity().candidateId)scanDebugLive(meta);}).catch(()=>{});
}
function renderChildTargets(c){
  const area=$("childArea"),host=$("childLinks");host.textContent="";if($("childSearch"))$("childSearch").value="";
  const raw=(c?.detectedTargets||c?.targets||[]).map(x=>({...x}));
  const structuralOnly=Math.max(0,Number(c?.structuralOnlyCount||0));
  for(let i=0;i<structuralOnly;i++)raw.push({title:`Detected structural item ${raw.length+1}`,url:null,sameOrigin:false,structuralOnly:true});
  area.hidden=raw.length<2;if(area.hidden){updateChildSelectionCount();return;}
  const titleCounts=new Map();for(const x of raw){const k=String(x.title||"").trim().toLocaleLowerCase();if(k)titleCounts.set(k,(titleCounts.get(k)||0)+1);}
  raw.forEach((x,i)=>{
    const lab=document.createElement("label");lab.className="child-link";
    const cb=document.createElement("input");cb.type="checkbox";cb.dataset.idx=String(i);
    const usable=Boolean(x?.url)&&x.sameOrigin!==false;
    cb.checked=usable;cb.disabled=!usable;cb.addEventListener("change",updateChildSelectionCount);
    const span=document.createElement("span");
    const base=x.title||x.url||"Detected item without a direct link";
    const dup=(titleCounts.get(String(x.title||"").trim().toLocaleLowerCase())||0)>1;
    let suffix="";
    if(dup&&x.secondaryTitle)suffix=` — ${x.secondaryTitle}`;
    else if(dup&&x.url){try{suffix=` — ${new URL(x.url).pathname.split('/').filter(Boolean).pop()||''}`;}catch{}}
    span.textContent=base+suffix;
    lab.dataset.search=`${base} ${x.secondaryTitle||""} ${x.url||""}`.toLocaleLowerCase();
    const sm=document.createElement("small");
    sm.textContent=x.url?`${inferSourceTypeFromLink(x)} · ${x.url}${x.structuralOutlier?" · structural outlier":""}`:"structural item · no direct URL detected";
    span.append(sm);lab.append(cb,span);host.append(lab);
  });
  updateChildSelectionCount();
}
function chooseCandidate(c){selectedCandidate=c;$("detectedSourceType").value=c.kind||"section";$("detectedSourceName").value=(pendingDetection?.page?.title||c.label||"Detected source").replace(/\s+[|–—-]\s+.*$/,"").trim();renderChildTargets(c);updatePaginationScanUi(c);document.querySelectorAll(".candidate").forEach(x=>x.classList.toggle("selected",x.dataset.id===c.id));}
function detectedControlDisplay(c){
  if(c.type==="select"){const labels=selectedOptionLabels(c);return `select${c.multiple?"[]":""} = ${labels.length?labels.join(", "):(Array.isArray(c.value)?c.value.join(", "):c.value||"—")}`;}
  if(["checkbox","radio","pressed","aria-check"].includes(c.type))return `${c.type} = ${c.checked}`;
  if(c.type==="interactive")return `${c.type}${c.stateText?` = ${c.stateText}`:""}`;
  return `${c.type}${c.value?` = ${c.value}`:""}`;
}
function renderDetection(d){
  pendingDetection=d;const panel=$("detectPanel");if(!d?.page){panel.hidden=true;return;}panel.hidden=false;$("detectPage").textContent=`${d.page.title} — ${d.page.url}`;const host=$("candidateList");host.textContent="";
  (d.suggestions||[]).forEach((c,i)=>{const lab=document.createElement("label");lab.className="candidate";lab.dataset.id=c.id;const radio=document.createElement("input");radio.type="radio";radio.name="candidate";radio.checked=i===0;const body=document.createElement("div");const pct=Math.round((c.confidence||0)*100);const samples=(c.samples||[]).map(x=>typeof x==="string"?x:(x.title||x.url)).slice(0,5).join(" · ");const uniqueInfo=(c.uniqueTargetCount!=null&&c.uniqueTargetCount!==c.itemCount)?` · ${c.uniqueTargetCount} unique target(s)`:"";body.innerHTML=`<strong>${c.label||c.kind}<span class="confidence">${pct}%</span></strong><div>${c.itemCount||0} ${LWLI18n.t("detectedItems")}${uniqueInfo}</div><div class="samples"></div>`;body.querySelector(".samples").textContent=samples||c.rationale||"";radio.onchange=()=>chooseCandidate(c);lab.onclick=()=>{radio.checked=true;chooseCandidate(c);};lab.append(radio,body);host.append(lab);});
  renderExactFacets();
  const filters=$("detectedFilters");filters.textContent="";(d.controls||[]).forEach((c,i)=>{const lab=document.createElement("label");lab.className="filter-chip";const cb=document.createElement("input");cb.type="checkbox";cb.dataset.idx=String(i);cb.checked=Boolean(c.suggested);const span=document.createElement("span");span.textContent=c.label||c.selector;const sm=document.createElement("small");sm.textContent=detectedControlDisplay(c);if(c.type==="interactive"||c.type==="aria-check"){cb.checked=false;cb.disabled=true;lab.title="Detected for diagnostics; teaching an exact interaction is not available yet.";}span.append(sm);lab.append(cb,span);filters.append(lab);});
  if((d.suggestions||[]).length)chooseCandidate(d.suggestions[0]);
}
async function loadPendingDetection(){const st=await chrome.storage.local.get("lwl_pending_detection");const d=st.lwl_pending_detection;if(!d)return;renderDetection(d);await restorePaginationCheckpoint().catch(()=>{});}
async function ensureProfileForDetection(forceNew=false){
  const origin=pendingDetection.page.origin;let p=!forceNew&&profiles.find(x=>x.origin===origin);
  if(!p)p={schemaVersion:1,profileVersion:"1.0.0",name:new URL(origin).hostname,origin,description:"Created with page detection",sources:[]};
  current=p;return p;
}

function blank(){return {schemaVersion:1,profileVersion:"1.0.0",name:"New profile",origin:"https://example.org",description:"",sources:[{id:"main",name:"Main section",type:"section",startUrl:"/",followDepth:1,maxItems:100}]};}
function sourceRow(s={}){const row=document.createElement("div");row.className="source-row";row._source=s;row.innerHTML=`<label>${LWLI18n.t("sourceName")}<input class="s-name"></label><label>${LWLI18n.t("sourceType")}<select class="s-type"><option value="collection">collection</option><option value="catalog">catalog</option><option value="glossary">glossary</option><option value="section">section</option></select></label><label>${LWLI18n.t("startUrl")}<input class="s-url"></label><button class="s-remove">${LWLI18n.t("remove")}</button><label class="s-capture-label">${LWLI18n.t("captureMode")}<select class="s-capture"><option value="page">${LWLI18n.t("captureFullPage")}</option><option value="article">${LWLI18n.t("captureArticle")}</option></select></label>`;row.querySelector(".s-name").value=s.name||"Source";row.querySelector(".s-type").value=s.type||"section";row.querySelector(".s-url").value=s.startUrl||"/";row.querySelector(".s-capture").value=s.captureMode||"article";row.querySelector(".s-remove").onclick=()=>row.remove();return row;}
function formFromProfile(p){current=p;$("name").value=p?.name||"";$("origin").value=p?.origin||"";$("description").value=p?.description||"";const host=$("sourceRows");host.textContent="";(p?.sources||[]).forEach(s=>host.append(sourceRow(s)));$("json").value=JSON.stringify(p||blank(),null,2);}
function basicProfile(){const origin=$("origin").value.trim();const old=current||{};const sources=[...document.querySelectorAll(".source-row")].map((row,i)=>{const oldS=row._source||{};return {...oldS,name:row.querySelector(".s-name").value.trim()||`Source ${i+1}`,type:row.querySelector(".s-type").value,startUrl:row.querySelector(".s-url").value.trim()||"/",captureMode:row.querySelector(".s-capture").value};});return {...old,name:$("name").value.trim()||"Profile",origin,description:$("description").value.trim(),sources};}
async function refresh(){profiles=await LWLProfiles.list();const host=$("list");host.textContent="";for(const p of profiles){const b=document.createElement("button");b.textContent=`${p.name}\n${new URL(p.origin).hostname}`;b.className=current?.id===p.id?"active":"";b.onclick=()=>{formFromProfile(p);refresh();};host.append(b);}if(!current&&profiles.length)formFromProfile(profiles[0]);}
async function testOne(profile,source){
  /* Same crawl window as the sync and the scan, so testing a source never
     opens a tab in the window the user is working in. */
  const msg=source.type==="section"?{type:"DISCOVER_SECTION_LINKS",source}:{type:"DISCOVER_SOURCE",source};
  const res=await chrome.runtime.sendMessage({target:"background",type:"PAGE_TASK",task:{url:source.startUrl,message:msg,origin:scanOrigin(source),timeoutMs:30000}});
  if(!res?.ok)return {source:source.name,type:source.type,url:source.startUrl,count:0,nextUrl:null,ok:false,error:res?.error||"Could not load the page"};
  const out=res.result||{};
  return {source:source.name,type:source.type,url:res.finalUrl,count:(out.items||out.links||[]).length,nextUrl:out.nextUrl||null,ok:out.ok,error:out.error||null};
}
$("addSource").onclick=()=>$("sourceRows").append(sourceRow());
$("addCurrent").onclick=async()=>{const [tab]=await chrome.tabs.query({active:true,currentWindow:true});if(!tab?.url||!/^https?:/.test(tab.url))return;try{const u=new URL(tab.url);if(!$("origin").value.trim()||$("origin").value==="https://example.org")$("origin").value=u.origin;$("sourceRows").append(sourceRow({name:tab.title||u.pathname||u.hostname,type:"section",startUrl:tab.url}));}catch{}};
$("new").onclick=()=>formFromProfile(blank());
$("save").onclick=async()=>{try{let p=basicProfile();const advanced=JSON.parse($("json").value||"{}");p={...advanced,...p,sources:p.sources.map((s,i)=>({...advanced.sources?.[i],...s}))};p=await LWLProfiles.save(p);current=p;setStatus(LWLI18n.t("profileSaved"));await refresh();formFromProfile(p);}catch(e){setStatus(String(e.message||e),true);}};
$("applyJson").onclick=()=>{try{formFromProfile(LWLProfiles.normalizeProfile(JSON.parse($("json").value)));setStatus("JSON applied / JSON übernommen");}catch(e){setStatus(String(e.message||e),true);}};
$("import").onclick=()=>$("file").click();
$("file").onchange=async()=>{try{const f=$("file").files[0];if(!f)return;const text=(await f.text()).replace(/^\uFEFF/,"");const raw=JSON.parse(text);const p=LWLProfiles.normalizeProfile(raw);const ok=await LWLProfiles.ensurePermission(p);if(!ok)throw new Error(LWLI18n.t("permissionDenied"));current=await LWLProfiles.save(p);setStatus(LWLI18n.t("profileImported"));await refresh();formFromProfile(current);}catch(e){setStatus(String(e.message||e),true);}finally{$("file").value="";}};
$("export").onclick=async()=>{if(!current)return;const p=LWLProfiles.normalizeProfile(basicProfile());const blob=LWLProfiles.exportBlob(p);
  /* showSaveFilePicker instead of chrome.downloads: the extension no longer
     asks for the downloads permission, and the user picks the location. */
  try{
    const handle=await showSaveFilePicker({suggestedName:`${p.id}.lwl-profile.json`,types:[{description:"DiceFox profile",accept:{"application/json":[".json"]}}]});
    const stream=await handle.createWritable();
    try{await stream.write(blob);}finally{await stream.close();}
  }catch(e){ if(e?.name!=="AbortError") alert(String(e.message||e)); }
};
$("delete").onclick=async()=>{if(!current)return;const question=LWLI18n.isGerman?`Profil „${current.name}“ und seine erfassten Browserdaten, Ressourcen und Schreibaufträge löschen? Dateien im Bibliotheksordner bleiben erhalten.`:`Delete profile '${current.name}' and its captured browser data, resources and pending writes? Files in the library folder remain.`;if(!confirm(question))return;try{await LWLProfiles.remove(current.id);current=null;await refresh();}catch(error){setStatus(error.message,true);}};
$("test").onclick=async()=>{try{const p=LWLProfiles.normalizeProfile(basicProfile());if(!await LWLProfiles.ensurePermission(p))throw new Error(LWLI18n.t("permissionDenied"));const out=$("testOutput");out.hidden=false;out.textContent="Testing…";const results=[];for(const s of p.sources)results.push(await testOne(p,s).catch(e=>({source:s.name,ok:false,error:String(e.message||e)})));out.textContent=JSON.stringify(results,null,2);}catch(e){setStatus(String(e.message||e),true);}};


$("childSelectAll").onclick=()=>setAllChildTargets(true);
$("childSelectNone").onclick=()=>setAllChildTargets(false);
$("childSelectVisible").onclick=()=>setVisibleChildTargets(true);
$("childSelectNoneVisible").onclick=()=>setVisibleChildTargets(false);
$("childSearch").addEventListener("input",filterChildTargets);
$("detectedSourceType").addEventListener("change",()=>updatePaginationScanUi(selectedCandidate));
$("scanAllPages").onclick=async()=>{const btn=$("scanAllPages"),cancel=$("cancelScan");try{btn.disabled=true;if(cancel)cancel.disabled=false;await scanDetectionAllPages();}catch(e){const st=$("paginationScanStatus");if(st)st.textContent=LWLI18n.t("paginationScanFailed",[String(e.message||e)]);setStatus(String(e.message||e),true);}finally{btn.disabled=false;if(cancel)cancel.disabled=true;}};
$("cancelScan").onclick=async()=>{paginationScanAbortRequested=true;const st=$("paginationScanStatus");if(st)st.textContent=LWLI18n.t("paginationScanCancelling");await scanDebugPersistMeta({currentStep:"scan:cancel-requested",lastError:"Scan cancelled by user"}).catch(()=>{});};
$("exportScanDebug").onclick=async()=>{try{await exportPaginationScanDebugReport();setStatus(LWLI18n.t("scanDebugExported"));}catch(e){setStatus(String(e.message||e),true);}};

$("addChildren").onclick=async()=>{try{
  if(!pendingDetection||!selectedCandidate)return;
  const raw=(selectedCandidate.detectedTargets||selectedCandidate.targets||[]);
  const chosen=[...document.querySelectorAll("#childLinks input:checked:not(:disabled)")].map(cb=>raw[Number(cb.dataset.idx)]).filter(x=>x?.url&&x.sameOrigin!==false);
  if(!chosen.length)return;
  const p=await ensureProfileForDetection(false);const existing=new Set((p.sources||[]).map(x=>x.startUrl));
  let added=0;for(const x of chosen){if(existing.has(x.url))continue;{const inferred=inferSourceTypeFromLink(x);p.sources.push(LWLProfiles.normalizeSource({name:x.title||new URL(x.url).pathname,type:inferred,startUrl:x.url,discoveryMode:"auto",contentSelector:"main, article, [role='main'], body",followDepth:2,maxItems:5000,catalogMode:inferred==="catalog"?"content":undefined,detailPages:inferred!=="catalog"},p.sources.length,pendingDetection.page.origin));}existing.add(x.url);added++;}
  current=await LWLProfiles.save(p);await refresh();formFromProfile(current);setStatus(`${added} ${LWLI18n.t("detectedChildrenAdded")}`);
}catch(e){setStatus(String(e.message||e),true);}};


$("exportDetectionDebug").onclick=async()=>{try{await exportDetectionDebugReport();setStatus(LWLI18n.t("debugReportExported"));}catch(e){setStatus(String(e.message||e),true);}};
$("dismissDetect").onclick=async()=>{$("detectPanel").hidden=true;await clearPaginationCheckpoint().catch(()=>{});pendingDetection=null;await chrome.storage.local.remove("lwl_pending_detection");};
$("addDetected").onclick=async()=>{try{if(!pendingDetection||!selectedCandidate)return;const p=await ensureProfileForDetection(false);p.sources=[...(p.sources||[]),candidateToSource(selectedCandidate)];current=await LWLProfiles.save(p);await clearPaginationCheckpoint().catch(()=>{});await chrome.storage.local.remove("lwl_pending_detection");pendingDetection=null;$("detectPanel").hidden=true;await refresh();formFromProfile(current);setStatus(LWLI18n.t("detectedSourceAdded"));}catch(e){setStatus(String(e.message||e),true);}};
$("createDetectedProfile").onclick=async()=>{try{if(!pendingDetection||!selectedCandidate)return;const p=await ensureProfileForDetection(true);p.sources=[candidateToSource(selectedCandidate)];current=await LWLProfiles.save(p);await clearPaginationCheckpoint().catch(()=>{});await chrome.storage.local.remove("lwl_pending_detection");pendingDetection=null;$("detectPanel").hidden=true;await refresh();formFromProfile(current);setStatus(LWLI18n.t("detectedProfileCreated"));}catch(e){setStatus(String(e.message||e),true);}};

(async()=>{await refresh();if(!current)formFromProfile(blank());await loadPendingDetection();})();
