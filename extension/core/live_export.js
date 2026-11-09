/* App-only streaming coordinator. Durable data contains names, URLs and
   receipts. No captured HTML, image blobs, packages or Reader resources:
   pages read are kept by the offscreen document's page store alone. */
const LIVE_JOB='dicefox:live-export',LIVE_PROGRESS='dicefox:live-progress';
let liveActive=false,liveJob=null,liveProgress=null,liveStartingId=null;
const liveAck=(id,index)=>`dicefox:live-ack:${id}:${index}`;
async function liveSave(fields){
  Object.assign(liveProgress,fields,{updatedAt:Date.now()});
  await chrome.storage.local.set({[LIVE_PROGRESS]:liveProgress});
  state.status=liveProgress.status;state.page=liveProgress.current||'';
  state.progress=liveProgress.done;state.progressMax=liveJob?.entries.length||1;broadcast();
}
async function liveSnapshot(){
  const data=await chrome.storage.local.get([LIVE_JOB,LIVE_PROGRESS]);
  const job=liveJob||data[LIVE_JOB],progress=liveProgress||data[LIVE_PROGRESS];
  return {ok:true,active:liveActive,job:job?{id:job.id,profileId:job.profileId,world:job.world,sourceIds:job.sourceIds,kinds:job.kinds,total:job.entries.length}:null,
    progress:progress?{...progress,...(!liveActive&&progress.status==='running'?{status:'paused',error:'Chrome stopped. Choose the same world and resume.'}:{})}:null};
}
// The app's server out of reach for a moment — a dropped link, a new way
// there, a busy server — is waited out a few times before the export pauses.
const APP_TRIES=6,APP_WAIT=15000,PASSING=/\[online\]|did not answer in time/;
async function liveCall(type,payload={}){
  for(let attempt=1;;attempt++){
    const result=await askOffscreen({type,...payload});
    if(result?.ok)return result;
    const error=result?.error||'The export processor did not respond.';
    if(!PASSING.test(error)||attempt>=APP_TRIES||stopRequested)throw Error(error);
    await liveSave({error:`${error.includes('[online]')?'The app does not reach its server':'The app is slow to answer'} — trying again (${attempt} of ${APP_TRIES-1}) …`});
    await sleep(APP_WAIT);
  }
}
async function liveOverview(selected,source){
  const key=selectionCatalogKey(selected.id,source.id),saved=(await chrome.storage.local.get(key))[key];
  const current=saved?.format===SELECTION_FORMAT;
  if(current&&saved.complete)return selectionItems(saved.items,selected,source);
  const resume=current&&!saved.complete&&saved.nextUrl&&Array.isArray(saved.pages)&&Array.isArray(saved.items);
  const items=new Map((resume?saved.items:[]).map(item=>[item.url,item])),pages=new Set(resume?saved.pages:[]);let url=resume?saved.nextUrl:source.startUrl;
  // The list shows how far it is: page, last page, entries found so far.
  let last=0;
  const told=()=>`List · page ${pages.size+1}${last>pages.size+1?' of '+last:''} · ${items.size} found`;
  while(url&&!stopRequested){
    const requested=canonical(url);
    if(pages.has(requested)||pages.size>=10000)throw Error('Overview pagination is incomplete: '+source.name);
    await liveSave({current:told(),kind:source.providerSource||source.id});
    const result=await openTask(url,{type:'DISCOVER_SOURCE',source:{...source,detailPages:false,expandCards:false,captureCatalogLayout:false,appExport:true}});
    if(!result?.ok||result.itemsLimited)throw Error(result?.error||'The overview is incomplete: '+source.name);
    for(const item of selectionItems(result.items,selected,source))items.set(item.url,item);
    if(items.size>100000)throw Error('The overview exceeds the supported entry limit.');
    pages.add(requested);url=result.nextUrl?new URL(result.nextUrl,requested).href:null;
    last=Math.max(last,Number(result.pagination?.lastPage)||0);
    if(url&&!LWLProviders.allows(selected,source,url))throw Error('Overview left D&D Beyond.');
    await chrome.storage.local.set({[key]:{format:SELECTION_FORMAT,items:[...items.values()],pages:[...pages],complete:!url,nextUrl:url,updatedAt:Date.now()}});
  }
  if(stopRequested)throw Error('Export paused.');
  if(!items.size)throw Error('No entries found in '+source.name+'. Check your D&D Beyond login.');
  await chrome.storage.local.set({[key]:{format:SELECTION_FORMAT,items:[...items.values()],pages:[...pages],complete:true,nextUrl:null,updatedAt:Date.now()}});
  return [...items.values()];
}
/* The lists in the order they are read and imported. Classes come first:
   spells take their class associations from them. Books next, so that
   other entries' links into chapters find them. */
function liveLists(chosen){
  const lists=chosen.filter(source=>source.type!=='glossary'),rank=source=>(source.providerSource||source.id)==='classes'?0:source.type==='collection'?1:2;
  return lists.map((source,at)=>({source,at})).sort((a,b)=>rank(a.source)-rank(b.source)||a.at-b.at).map(x=>x.source);
}
/* Reads one list and queues its entries behind those already queued. Its
   entries are imported before the next list is read. */
async function liveList(job,selected,source,lists){
  const kind=source.providerSource||source.id;
  let index=job.entries.reduce((n,e)=>Math.max(n,e.i+1),0);
  const snapshot=await selectionCatalogGet(selected.id,source.id);
  const items=job.wholeSourceIds.includes(source.id)?await liveOverview(selected,source):job.targets.filter(url=>LWLProviders.get('dndbeyond').classify(url)===kind).map(url=>snapshot.items.find(item=>item.url===url)||{url,title:LWLUrl.slugFromUrl(url),titlePending:true});
  const entries=[],books=[];
  if(source.type==='collection'){
    for(const item of items){
      const bookSource={...source,collectionRoot:item.url};
      await liveSave({current:'Reading contents: '+item.title,kind});
      const nav=await openTask(item.url,{type:'DISCOVER_NAVIGATION',source:bookSource});
      if(!nav?.ok)throw Error(nav?.error||'Book navigation unavailable: '+item.title);
      const id=safeId(item.url),name=LWLPresentation.chooseTitle(item.titlePending?[nav.title,item.title]:[item.title,nav.title],item.url);
      books.push({id,url:item.url,name,cover:item.cover||null});
      const pages=new Map([[item.url,{url:item.url,title:name}]]);
      for(const page of nav.pages||[]){
        const url=selectionUrl(page.url);
        if(LWLProviders.allows(selected,bookSource,url))pages.set(url,{url,title:page.title||LWLUrl.slugFromUrl(url)});
      }
      if(pages.size>(source.maxItems||5000))throw Error('This book exceeds the chapter limit: '+name);
      let order=0;
      for(const page of pages.values())entries.push({i:index++,sourceId:source.id,s:kind,u:page.url,t:page.title,m:{},a:[],has:true,book:id,order:order++});
    }
  }else{
    for(const item of items){
      // Subclasses belong to their parent class; the parent extractor emits
      // them with the class association rather than as isolated duplicates.
      if(kind==='classes'&&/\/subclasses\//.test(new URL(item.url).pathname))continue;
      entries.push({i:index++,sourceId:source.id,s:kind,u:item.url,t:item.title,titlePending:!!item.titlePending,m:item.meta||{},a:[],has:true,book:null,order:0});
    }
  }
  if(stopRequested)throw Error('Export paused.');
  job.entries.push(...entries);job.books.push(...books);job.listed.push(source.id);
  job.discovered=job.listed.length===lists.length;
  await chrome.storage.local.set({[LIVE_JOB]:job});
}
/* Kinds the tab reads in this run: read without one, a page of theirs lacked
   what the tab found. '*' is all of them: the site did not know the sign-in. */
let liveTabKinds=new Set();
/* A page for the export: as read before unless asked for fresh, else read
   without a tab at a reader's pace. Where that finds nothing, the tab is
   asked too — and reads the rest of that kind if it found more. */
async function liveRead(url,message,{fresh=false}={}){
  while(paused&&!stopRequested)await sleep(250);
  if(stopRequested)throw Error('Export paused.');
  if(!LWLProviders.allows(profile,message.source,url))throw Error('Page outside supported export scope: '+url);
  const type=message.type,rules=message.source.captureRules??null,kind=message.source.id;
  const keep=async result=>{if(result?.ok)await liveCall('AW_PAGE_KEEP',{url,extract:type,rules,result}).catch(error=>log('Not kept: '+url+' — '+(error.message||error)));return result;};
  if(!fresh){const kept=(await liveCall('AW_PAGE_KEPT',{url,extract:type,rules})).result;if(kept)return kept;}
  if(!liveTabKinds.has(kind)&&!liveTabKinds.has('*')){
    await sleep(pace());
    const signedOut=LWLProviders.get(profile.provider?.id)?.signedOutPattern;
    const read=await liveCall('AW_PAGE_READ',{url,message,signedOut}).then(r=>r.result,error=>({ok:false,error:String(error.message||error)}));
    if(read.busy)throw Error('D&D Beyond asks to slow down. Resume later.');
    if(read.signedOut){liveTabKinds.add('*');log('Read in a tab from now on: not signed in without one');}
    const refused=read.finalUrl&&pageRefusal(read.finalUrl,message);
    if(refused)return refused;
    if(read.ok||read.gone)return read.ok?keep(read):read;
  }
  const result=await openTask(url,message);
  if(result?.ok&&!liveTabKinds.has(kind)&&!liveTabKinds.has('*')){liveTabKinds.add(kind);log('Read in a tab from now on: '+kind+' — '+url);}
  return keep(result);
}
/* What the conversion knows of the site: where it is, its addresses that
   name the same page, how its books are set. */
const liveSite=profile=>({origin:profile.origin,aliases:profile.canonicalization?.pathAliases||{},layout:profile.bookLayout||{}});
/** Pages in a row that may fail before the export pauses: then it is the sign-in, not the pages. */
const MISSES=3;
/* Where each list stands, in the order they are read: entries in, of those
   queued. A list not read yet has none queued; `expected` is how many it
   will bring where that is known already — a list read before, or what was
   picked from it. */
function liveStanding(job,lists,receipts,expected={}){
  return lists.map(source=>{
    const kind=source.providerSource||source.id,own=job.entries.filter(e=>e.s===kind),listed=job.listed.includes(source.id);
    return {kind,name:source.name,done:own.filter(e=>receipts.has(String(e.i))).length,total:listed?own.length:expected[source.id]??null,listed};
  });
}
/* How many entries the lists not read yet will bring, where known. Books
   are known by their chapters only once read. */
async function liveExpected(job,selected,lists){
  const out={};
  for(const source of lists){
    if(job.listed.includes(source.id)||source.type==='collection')continue;
    const kind=source.providerSource||source.id;
    if(!job.wholeSourceIds.includes(source.id)){out[source.id]=job.targets.filter(url=>LWLProviders.get('dndbeyond').classify(url)===kind).length;continue;}
    const key=selectionCatalogKey(selected.id,source.id),saved=(await chrome.storage.local.get(key))[key];
    if(saved?.format===SELECTION_FORMAT&&saved.complete)out[source.id]=selectionItems(saved.items,selected,source).length;
  }
  return out;
}
function liveTotals(receipts){
  const totals={new:0,known:0,updated:0,gone:0,images:0,missingImages:0};
  for(const receipt of receipts){if(!receipt)continue;const r=receipt.result||{};if(receipt.gone)totals.gone++;
    totals.new+=r.documents_new||0;totals.known+=r.documents_known||0;totals.updated+=r.documents_updated||0;
    totals.images+=Math.max(0,(r.images_new||0)-(r.images_skipped?.length||0));totals.missingImages+=receipt.missingImages||0;
  }
  return totals;
}
async function liveStart(msg){
  if(liveActive||running||busy||pageTasksActive||pageCommandsActive)throw Error('Another task is running. Wait for it to finish.');
  busy=true;liveStartingId=msg.exportId;stopRequested=false;
  try{
    const data=await chrome.storage.local.get([LIVE_JOB,LIVE_PROGRESS,'dicefox:export-draft:'+msg.exportId]);
    const selected=(await LWLProfiles.list()).find(p=>p.id===msg.profileId&&p.provider?.id==='dndbeyond');
    // A profile saved before it named how books are set: the selection brings the current one.
    if(!selected||!selected.bookLayout?.statBlock)throw Error('Reload the D&D Beyond selection.');
    let job;
    if(msg.resume){
      job=data[LIVE_JOB];
      if(!job||job.id!==msg.exportId||job.profileId!==selected.id)throw Error('This export can no longer be resumed.');
      if(job.world.id!==msg.world?.id||job.world.appName!==msg.world?.appName||job.world.appPort!==msg.world?.appPort)throw Error('Resume in the same world and app instance.');
      if(data[LIVE_PROGRESS]?.status==='complete')throw Error('This export is already complete.');
    }else{
      const draft=data['dicefox:export-draft:'+msg.exportId];
      if(!draft||draft.profileId!==selected.id||Date.now()-draft.createdAt>24*60*60*1000)throw Error('The selection expired. Select the content again.');
      const targets=validateExportTargets(selected,draft.targets,draft.sourceIds),wholeSourceIds=validateWholeSources(selected,draft.wholeSourceIds,draft.sourceIds);
      job={id:draft.id,profileId:selected.id,sourceIds:draft.sourceIds,targets,wholeSourceIds,world:msg.world,entries:[],books:[],listed:[],discovered:false,createdAt:Date.now()};
    }
    if(!msg.world?.key||!msg.world.id)throw Error('Choose an available GM world.');
    const chosen=LWLProfiles.exportSources(selected,job.sourceIds);
    job.kinds=chosen.map(s=>s.providerSource||s.id);job.refresh=!!msg.refresh;job.fresh=!!msg.fresh;job.world=Object.fromEntries(['id','key','name','appName','appPort','members'].filter(k=>msg.world[k]!==undefined).map(k=>[k,msg.world[k]]));
    profile=selected;config={assets:false,offline:false,output:'anotherworldbuilder',parallelism:1,delayMs:2000};
    paused=false;browserStopRequested=false;
    await requireBrowserWindow();await ensureOffscreen();
    // A second schema and GM check belongs to the worker. The dialog's check
    // cannot authorize a later transfer after roles or templates have changed.
    await liveCall('AW_LIVE_OPEN',{world:msg.world.key,kinds:job.kinds,refresh:job.refresh,site:liveSite(profile)});
    if(stopRequested)throw Error('Export paused.');
    const initialProgress={id:job.id,status:'running',done:0,total:job.entries.length,current:'Preparing export…',totals:{new:0,known:0,images:0,missingImages:0},error:null};
    await chrome.alarms.create('lwl-heartbeat',{periodInMinutes:0.5});
    await chrome.storage.local.set({[LIVE_JOB]:job,[LIVE_PROGRESS]:initialProgress});
    liveJob=job;liveProgress=initialProgress;liveActive=true;
    liveStartingId=null;
    state.running=true;state.exportId=job.id;state.profileId=selected.id;state.sourceIds=job.sourceIds;
    void liveRun(job,selected,chosen).catch(error=>log(String(error.message||error)));
    return {ok:true,started:true};
  }catch(error){liveStartingId=null;busy=false;await closeOffscreenIfIdle();throw error;}
}
async function liveRun(job,selected,chosen){
  const receipts=new Map(),lists=liveLists(chosen);let bindings={};liveTabKinds=new Set();
  let expected={};
  const standing=()=>{
    const rows=liveStanding(job,lists,receipts,expected);
    // The whole: what is queued, and what the lists still to be read will bring.
    const coming=rows.filter(l=>!l.listed).reduce((n,l)=>n+(l.total||0),0);
    return {done:job.entries.filter(e=>receipts.has(String(e.i))).length,total:job.entries.length,coming,final:rows.every(l=>l.listed),totals:liveTotals(receipts.values()),lists:rows};
  };
  const checkpoint=async(key,result,entry)=>{
    const receipt={result:result.result,missingImages:result.missingImages||0,...(entry?.s==='classes'?{bindings:result.bindings}:{}),...(result.gone?{gone:true}:{})};
    await chrome.storage.local.set({[liveAck(job.id,key)]:receipt});
    receipts.set(String(key),receipt);if(result.bindings)bindings=result.bindings;
    await liveSave(standing());
  };
  try{
    // A job from before lists were imported one by one has read them all.
    if(!Array.isArray(job.listed))job.listed=job.discovered?lists.map(source=>source.id):[];
    const keys=['basis','books',...job.entries.map(e=>e.i)];
    const saved=await chrome.storage.local.get(keys.map(i=>liveAck(job.id,i)));
    for(const key of keys)if(saved[liveAck(job.id,key)])receipts.set(String(key),saved[liveAck(job.id,key)]);
    for(const entry of job.entries)if(entry.s==='classes'&&receipts.get(String(entry.i))?.bindings)bindings=receipts.get(String(entry.i)).bindings;
    expected=await liveExpected(job,selected,lists);
    await liveSave(standing());
    const glossary=[];
    for(const source of chosen.filter(s=>s.type==='glossary')){
      await liveSave({current:'Reading rules glossary…',kind:null});
      const result=await liveRead(source.startUrl,{type:'EXTRACT_PAGE',source:{...capturedSource(source),appExport:true}},{fresh:job.fresh});
      if(!result?.ok||!result.glossary?.length)throw Error(result?.error||'The rules glossary is unavailable. Check your D&D Beyond login.');
      glossary.push(...result.glossary.map(g=>({term:g.term,url:g.url,definition:g.definition})));
    }
    // The converter is always reconstructed on resume, including its glossary
    // and class bindings. Basis document IDs are safe to send again. Lists
    // not read yet are pending: links to their entries are made by address.
    // Lists selected whole: all their entries will come.
    const whole=chosen.filter(source=>(job.wholeSourceIds||[]).includes(source.id)).map(source=>source.providerSource||source.id);
    const pending=()=>lists.filter(source=>!job.listed.includes(source.id)&&source.type!=='collection').map(source=>source.providerSource||source.id);
    const basis=await liveCall('AW_LIVE_INDEX',{entries:job.entries,bookRoots:job.books,glossary,bindings,pending:pending(),whole:whole});
    if(!receipts.has('basis'))await checkpoint('basis',basis);
    const seen=new Set([...job.entries.map(e=>e.u),...(job.gone||[]).map(g=>g.u||g)]);
    // Imports what is queued and not yet confirmed — what the world holds
    // already is not read again, unless asked to.
    // Pages not read in the current run of failures — left out once one is
    // read again, or when the export ends; tried again if it pauses.
    let missed=[],lastRead=null;
    const leaveOut=async()=>{
      for(const {entry,failure} of missed){
        // Kept with the job, shown in the export dialog: to see afterwards what was left out and why.
        job.gone=[...(job.gone||[]),{u:entry.u,t:entry.t,s:entry.s,why:failure,at:Date.now()}];log('Left out: '+entry.u+' — '+failure);
        await checkpoint(entry.i,{result:{},gone:true},entry);
      }
      if(missed.length)await chrome.storage.local.set({[LIVE_JOB]:job});
      missed=[];
    };
    const liveImport=async()=>{
      const open=job.entries.filter(e=>!receipts.has(String(e.i))).map(e=>e.i);
      const there=job.refresh||!open.length?new Set():new Set((await liveCall('AW_LIVE_EXISTING',{indexes:open})).indexes);
      for(let cursor=0;cursor<job.entries.length;cursor++){
        const entry=job.entries[cursor];if(stopRequested)throw Error('Export paused.');
        if(receipts.has(String(entry.i))||missed.some(m=>m.entry.i===entry.i))continue;
        if(there.has(entry.i)){await checkpoint(entry.i,{result:{documents_known:1}},entry);continue;}
        const source=chosen.find(s=>s.id===entry.sourceId),book=job.books.find(b=>b.id===entry.book);
        const captureSource={...capturedSource(source),appExport:true,...(book?{collectionRoot:book.url}:{})};
        await liveSave({current:entry.t,kind:entry.s,error:null});
        const result=await liveRead(entry.u,{type:entry.book?'EXTRACT_PAGE':'EXTRACT_DETAIL',source:captureSource},{fresh:job.fresh});
        const record=result?.ok?(entry.book?result.page:result.detail):null;
        const landed=record?.url?selectionUrl(record.url):selectionUrl(entry.u);
        // A small book opens straight on its one chapter: that page is the book's own.
        const ownChapter=!!book&&entry.u===book.url&&landed.startsWith(book.url+'/');
        const failure=!result?.ok?(result?.error||'not readable'):!record?.html?.trim()?'no readable content':landed!==selectionUrl(entry.u)&&!ownChapter?'led to '+landed:null;
        if(failure){
          // A page that cannot be read — gone, not this account's, led
          // elsewhere — is left out. Several in a row may be the sign-in:
          // the last page read is read again to see. Read, it was those pages;
          // not read, the export pauses and they are tried again later.
          missed.push({entry,failure});
          if(missed.length>=MISSES){
            const check=lastRead?await liveRead(lastRead.u,lastRead.message,{fresh:true}).catch(()=>null):null;
            const read=check?.ok&&(check.page||check.detail)?.html?.trim();
            if(!read)throw Error(`${missed.length} pages in a row could not be read, nor one read before. Check your D&D Beyond login. Last: ${entry.t} — ${failure}`);
            await leaveOut();
          }
          continue;
        }
        await leaveOut();
        lastRead={u:entry.u,message:{type:entry.book?'EXTRACT_PAGE':'EXTRACT_DETAIL',source:captureSource}};
        if(ownChapter){
          entry.a=[...new Set([...(entry.a||[]),landed])];
          const twin=job.entries.findIndex(e=>e.book===book.id&&e.u===landed&&!receipts.has(String(e.i)));
          if(twin>=0){job.entries.splice(twin,1);if(twin<cursor)cursor--;}
          seen.add(landed);
          await chrome.storage.local.set({[LIVE_JOB]:job});
        }
        const current={...entry,t:entry.titlePending?(record.title||entry.t):entry.t,m:{...entry.m,...record.meta}};
        // Additional in-book links extend the metadata queue, never the body
        // cache. Persist additions before acknowledging the referring chapter.
        if(book){
          let changed=false;
          for(const link of record.links||[]){
            let url;try{url=selectionUrl(link.url);}catch{continue;}
            if(seen.has(url)||!url.startsWith(book.url+'/')||!LWLProviders.allows(selected,captureSource,url))continue;
            const own=job.entries.filter(e=>e.book===book.id);
            if(own.length>=(source.maxItems||5000))throw Error('This book reached its chapter limit.');
            seen.add(url);job.entries.push({i:Math.max(...job.entries.map(e=>e.i))+1,sourceId:source.id,s:entry.s,u:url,t:link.title||LWLUrl.slugFromUrl(url),m:{},a:[],has:true,book:book.id,order:own.length});changed=true;
          }
          if(changed)await chrome.storage.local.set({[LIVE_JOB]:job});
        }
        const sent=await liveCall('AW_LIVE_RECORD',{entry:current,html:record.html,...(book?{bookEntries:job.entries.filter(e=>e.book)}:{})});
        await checkpoint(entry.i,sent,entry);
        // No next capture until the app acknowledges this entry. The extracted
        // HTML and image package now become unreachable and can be collected.
      }
    };
    await liveImport();
    for(const source of lists){
      if(job.listed.includes(source.id))continue;
      await liveList(job,selected,source,lists);
      for(const entry of job.entries)seen.add(entry.u);
      await liveCall('AW_LIVE_INDEX',{entries:job.entries,bookRoots:job.books,glossary,bindings,pending:pending(),whole:whole,extend:true});
      await liveSave(standing());
      await liveImport();
    }
    // Fewer than MISSES at the end: those pages, not the sign-in.
    await leaveOut();
    if(!job.entries.length)throw Error('The selection contains no accessible entries.');
    if(stopRequested)throw Error('Export paused.');
    if(!receipts.has('books'))await checkpoint('books',await liveCall('AW_LIVE_FINISH',{entries:job.entries,bookRoots:job.books}));
    await liveSave({status:'complete',current:'Export complete.',kind:null,error:null});
  }catch(error){await liveSave({status:'paused',error:stopRequested?'Export paused. Confirmed entries are retained.':String(error.message||error)});}
  finally{
    try{await liveCall('AW_LIVE_DROP');}catch{/* offscreen disconnected */}
    state.running=false;liveActive=false;busy=false;
    try{await closeCrawlWindow();}finally{await closeOffscreenIfIdle();}
  }
}
/* The pages kept in this browser: how many, or forgotten — not while an export reads them. */
async function livePages(forget){
  if(forget&&(liveActive||busy))throw Error('Pause the export first.');
  await ensureOffscreen();
  if(forget)await liveCall('AW_PAGES_FORGET');
  const count=(await liveCall('AW_PAGES_COUNT')).count;
  await closeOffscreenIfIdle();
  return {ok:true,count};
}
async function liveStop(id){
  if(id&&liveStartingId===id){stopRequested=true;return {ok:true,stopped:true};}
  if(!liveActive||liveJob?.id!==id)return {ok:true,stopped:false};
  const cancel=liveCall('AW_LIVE_CANCEL').catch(()=>{});
  stopRequested=true;paused=false;await cancel;await closeCrawlWindow();
  return {ok:true,stopped:true};
}
