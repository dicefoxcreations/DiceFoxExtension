/* Names and URLs for the selection UI. Reading an overview never captures
   article bodies or replaces the capture metadata. Only one browser job owns
   the crawler at a time; its snapshots survive closing the selection window. */
let selectionJob=null;
const selectionCatalogKey=(profileId,sourceId)=>`dicefox:catalog:${profileId}:${sourceId}`;
/* What a saved list holds: since 2 each entry's row details — its book, whether it is an older version. */
const SELECTION_FORMAT=2;
const selectionUrl=value=>{
 const u=new URL(value);u.hash='';u.search='';
 return u.href.replace(/\/+$/,'').replace('/sources/dnd/free-rules','/sources/dnd/br-2024');
};
async function selectionProfile(){
 const adapter=LWLProviders.get('dndbeyond');
 const response=await fetch(chrome.runtime.getURL(adapter.profilePath));
 if(!response.ok)throw Error(ui('The D&D Beyond rules could not be loaded. Reload DiceFox.','Die D&D-Beyond-Regeln konnten nicht geladen werden. Lade DiceFox neu.'));
 const bundled=await response.json();
 const all=await LWLProfiles.list();
 let selected=all.find(p=>p.provider?.id==='dndbeyond')||all.find(p=>p.origin===adapter.origin);
 if(!selected?.provider||selected.profileVersion!==bundled.profileVersion){
  if(running||busy){if(!selected?.provider)throw Error(ui('Finish the running capture first.','Beende zuerst die laufende Erfassung.'));}
  else selected=(await setupProvider('dndbeyond',selected?.id)).profile;
 }
 return {ok:true,profile:{id:selected.id,name:selected.name,origin:selected.origin},sources:selected.sources.filter(s=>['catalog','collection'].includes(s.type)).map(s=>({id:s.id,kind:s.providerSource||s.id,name:s.name,type:s.type}))};
}
async function selectionSource(profileId,sourceId){
 const selected=(await LWLProfiles.list()).find(p=>p.id===profileId&&p.provider?.id==='dndbeyond');
 const source=selected?.sources.find(s=>s.id===sourceId&&['catalog','collection'].includes(s.type));
 if(!source)throw Error(ui('This D&D Beyond category is unavailable. Reload the selection.','Dieser D&D-Beyond-Bereich ist nicht verfügbar. Lade die Auswahl neu.'));
 return {selected,source};
}
function selectionItems(items,selected,source){
 const byUrl=new Map();
 for(const item of items||[]){
  try{
   const url=selectionUrl(item.url);if(!LWLProviders.allows(selected,source,url))continue;
   // A collection names books, not their individual chapter pages.
   if(source.type==='collection'&&!/^\/sources\/(?:dnd\/)?[^/]+\/?$/.test(new URL(url).pathname))continue;
   byUrl.set(url,{url,title:String(item.title||item.name||LWLUrl.slugFromUrl(url)).replace(/\s+/g,' ').trim(),meta:item.meta||{},cover:item.cover||null});
  }catch{/* Ignore malformed old rows, without deleting their stored data. */}
 }
 return [...byUrl.values()];
}
async function selectionCatalogGet(profileId,sourceId){
 const {selected,source}=await selectionSource(profileId,sourceId);
 const key=selectionCatalogKey(profileId,sourceId),legacy=`lwl:${profileId}:source:${sourceId}`;
 const saved=(await chrome.storage.local.get(key))[key];
 const old=saved?null:(await chrome.storage.local.get(legacy))[legacy];
 const data=saved||{items:selectionItems(old?.items,selected,source),complete:old?.complete===true,updatedAt:old?.updatedAt||null};
 const active=selectionJob?.profileId===profileId&&selectionJob?.sourceId===sourceId&&selectionJob.active;
 return {ok:true,sourceId,items:selectionItems(data.complete?data.items:[...(data.previousItems||[]),...(data.items||[])],selected,source),complete:data.complete===true,updatedAt:data.updatedAt||null,error:data.error||null,loading:Boolean(active),jobId:active?selectionJob.id:null,pages:data.pages?.length||0};
}
async function selectionCatalogStart(profileId,sourceId,refresh=false){
 const {selected,source}=await selectionSource(profileId,sourceId);
 if(selectionJob?.active&&selectionJob.profileId===profileId&&selectionJob.sourceId===sourceId)return {ok:true,jobId:selectionJob.id,alreadyRunning:true};
 if(running||busy||pageTasksActive||pageCommandsActive)throw Error(ui('Another task is running. Finish it before loading another overview.','Ein anderer Vorgang läuft. Beende ihn, bevor du eine weitere Übersicht lädst.'));
 busy=true;
 const key=selectionCatalogKey(profileId,sourceId);let saved,previous;
 try{const stored=await chrome.storage.local.get([key,'lwl_run_config']);saved=stored[key];previous=stored.lwl_run_config;if(!saved){const legacy='lwl:'+profileId+':source:'+sourceId;const old=(await chrome.storage.local.get(legacy))[legacy];saved={items:[],previousItems:selectionItems(old?.items,selected,source),complete:false};}}catch(error){busy=false;throw error;}
 const resume=!refresh&&saved?.format===SELECTION_FORMAT&&Array.isArray(saved.items)&&Array.isArray(saved.pages)&&!saved.complete&&saved.nextUrl;
 const job={id:crypto.randomUUID(),profileId,sourceId,status:'loading',active:true};selectionJob=job;
 const data={format:SELECTION_FORMAT,items:resume?saved.items:[],previousItems:selectionItems(saved.complete?saved.items:saved.previousItems,selected,source),pages:resume?saved.pages:[],nextUrl:resume?saved.nextUrl:source.startUrl,complete:false,error:null,updatedAt:Date.now()};
 paused=false;stopRequested=false;browserStopRequested=false;profile=selected;
 config={...previous,assets:false,offline:false,output:'anotherworldbuilder',parallelism:1};
 state.running=true;state.exportId=null;state.profileId=profileId;state.sourceIds=[sourceId];state.source=source.name;state.lastError=null;
 status(ui('Loading overview','Übersicht laden'));
 try{await chrome.storage.local.set({[key]:data});}catch(error){job.active=false;busy=false;state.running=false;throw error;}
 (async()=>{
  try{
   await requireBrowserWindow();await ensureOffscreen();
   const items=new Map(data.items.map(item=>[item.url,item])),seen=new Set(data.pages);
   while(data.nextUrl&&!stopRequested){
    const requested=canonical(data.nextUrl);
    if(seen.has(requested)||seen.size>=10000||items.size>=100000)throw Error(ui('The overview reached a limit. The list is incomplete.','Die Übersicht hat eine Grenze erreicht. Die Liste ist unvollständig.'));
    setField('page',ui(`Overview page ${seen.size+1}`,`Übersichtsseite ${seen.size+1}`));
    const result=await openTask(data.nextUrl,{type:'DISCOVER_SOURCE',source:{...source,detailPages:false,expandCards:false,captureCatalogLayout:false}});
    if(!result?.ok)throw Error(result?.error||ui('Sign in to D&D Beyond and load the overview again.','Melde dich bei D&D Beyond an und lade die Übersicht erneut.'));
    for(const item of selectionItems(result.items,selected,source))items.set(item.url,item);
    seen.add(requested);data.items=[...items.values()];data.pages=[...seen];
    const next=result.nextUrl?new URL(result.nextUrl,requested).href:null;
    if(next&&!LWLProviders.allows(selected,source,next))throw Error(ui('The next overview page is outside D&D Beyond.','Die nächste Übersichtsseite liegt außerhalb von D&D Beyond.'));
    if(!items.size&&!next)throw Error(ui('No entries found. Check the D&D Beyond login and try again.','Keine Einträge gefunden. Prüfe die D&D-Beyond-Anmeldung und versuche es erneut.'));
    data.nextUrl=next;data.updatedAt=Date.now();data.complete=!next;if(data.complete)data.previousItems=[];
    await chrome.storage.local.set({[key]:data});setProgress(items.size,Math.max(1,items.size));
   }
   job.status=stopRequested?'stopped':'complete';
  }catch(error){job.status=stopRequested?'stopped':'error';data.error=stopRequested?null:String(error.message||error);}
  finally{
   if(stopRequested)data.complete=false;
   data.updatedAt=Date.now();
   try{await chrome.storage.local.set({[key]:data});}catch(error){data.error=String(error.message||error);job.status='error';}
   state.running=false;state.lastError=data.error;status(job.status);state.finishedAt=new Date().toISOString();
   try{await closeCrawlWindow();await persist(true);}finally{job.active=false;busy=false;broadcast();await closeOffscreenIfIdle();}
  }
 })().catch(error=>{job.active=false;busy=false;state.running=false;state.lastError=String(error.message||error);status('error');broadcast();});
 return {ok:true,jobId:job.id,started:true};
}
async function selectionCatalogStop(id){
 if(!selectionJob||selectionJob.id!==id||!selectionJob.active)return {ok:true,stopped:false};
 stopRequested=true;paused=false;await closeCrawlWindow();return {ok:true,stopped:true};
}
async function selectionExportDraft(msg){
 if(running||busy)throw Error(ui('Finish the running task before exporting.','Beende den laufenden Vorgang vor dem Export.'));
 const selected=(await LWLProfiles.list()).find(p=>p.id===msg.profileId&&p.provider?.id==='dndbeyond');
 if(!selected)throw Error(ui('Reload the selection first.','Lade zuerst die Auswahl neu.'));
 if(!Array.isArray(msg.selection)||msg.selection.length>selected.sources.length)throw Error('Invalid selection.');
 const whole=[],targets=[],selectedIds=new Set();
 for(const row of msg.selection){
  const source=selected.sources.find(s=>s.id===row.sourceId&&['catalog','collection'].includes(s.type));
  if(!source||selectedIds.has(source.id))throw Error('Invalid or duplicate category.');selectedIds.add(source.id);
  if(!Array.isArray(row.include)||!Array.isArray(row.exclude))throw Error('Invalid entry selection.');
  const excluded=new Set(row.exclude.map(selectionUrl));
  if(row.all&&!excluded.size){whole.push(source.id);continue;}
  let include=row.include;
  if(row.all){
   const snapshot=await selectionCatalogGet(selected.id,source.id);
   if(!snapshot.complete||snapshot.loading)throw Error(ui('Load the complete overview before excluding individual entries from an entire category.','Lade zuerst die vollständige Übersicht, um einzelne Einträge aus einem ganzen Bereich abzuwählen.'));
   include=snapshot.items.map(item=>item.url).filter(url=>!excluded.has(url));
  }
  for(const value of include){const url=selectionUrl(value);if(!LWLProviders.allows(selected,source,url))throw Error('Entry outside the selected category.');targets.push(url);}
 }
 const targetKinds=new Set(targets.map(url=>LWLProviders.get('dndbeyond').classify(url)));
 const ids=[...new Set([...whole,...selected.sources.filter(s=>targetKinds.has(s.providerSource||s.id)).map(s=>s.id)])];
 if(!ids.length)throw Error(ui('Select at least one book, entry or category.','Wähle mindestens ein Buch, einen Eintrag oder einen Bereich.'));
 const sources=LWLProfiles.exportSources(selected,ids),sourceIds=sources.map(s=>s.id);
 const checked=validateExportTargets(selected,targets,sourceIds);
 const id=crypto.randomUUID(),key='dicefox:export-draft:'+id;
 const draft={id,createdAt:Date.now(),profileId:selected.id,sourceIds,wholeSourceIds:whole,targets:[...new Set(checked)],assets:true,delayMs:2000,syncMode:'new_only'};
 await chrome.storage.local.set({[key]:draft});return {ok:true,id};
}
