'use strict';
const $=id=>document.getElementById(id);
const ask=async msg=>{const result=await chrome.runtime.sendMessage({target:'background',...msg});if(!result?.ok)throw Error(result?.error||'DiceFox did not respond. Reload the extension.');return result;};
const names={'my-library':'Books',monsters:'Monsters',spells:'Spells','magic-items':'Magic items',equipment:'Equipment',classes:'Classes',species:'Species',backgrounds:'Backgrounds',feats:'Feats'};
const normal=value=>{const u=new URL(value);u.hash='';u.search='';return u.href.replace(/\/+$/,'').replace('/sources/dnd/free-rules','/sources/dnd/br-2024');};
let profile=null,sources=[],models=new Map(),activeDraft=null,submitting=false,permissionGranted=false;
let automaticQueue=[],automaticTask=null,automaticPaused=false,closed=false,refreshPending=false;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const title=source=>names[source.kind]||source.name;
function message(text,error=false){$('status').textContent=text;$('status').className='status'+(error?' error':'');}
function errorMessage(error){const text=String(error.message||error);message(/Unknown command|Receiving end|Extension context|not respond/i.test(text)?'Reload DiceFox at chrome://extensions and reopen the selection.':text,true);}
$('version').textContent=chrome.runtime.getManifest().version;
document.documentElement.lang='en';$('exportFrame').title='Export to AnotherWorldbuilder';
$('tagline').textContent='D&D Beyond → AnotherWorldbuilder';
$('intro').textContent='Choose categories, books or entries.';
$('start').textContent='Export…';$('exportTitle').textContent='Export to AnotherWorldbuilder';$('closeExport').textContent='Close';
function model(source){
 if(!models.has(source.id))models.set(source.id,{all:false,include:new Set(),exclude:new Set(),items:[],complete:false,loading:false,jobId:null,error:null,search:'',shown:150,refreshed:false});
 return models.get(source.id);
}
function selected(m,url){return m.all?!m.exclude.has(url):m.include.has(url);}
function updateSelection(){
 let areas=0,entries=0;
 for(const source of sources){const m=model(source);if(m.all&&(!m.exclude.size||!m.complete))areas++;else if(m.all)entries+=m.items.filter(item=>selected(m,item.url)).length;else entries+=m.include.size;}
 $('selectedCount').textContent=`${areas} categories · ${entries} individual entries`;
 $('selectionHint').textContent='Next: choose a world and check templates.';
 $('start').disabled=submitting||!profile||!(areas||entries);
 if(profile)chrome.storage.local.set({['dicefox:selection-ui:'+profile.id]:sources.map(source=>{const m=model(source);return {sourceId:source.id,all:m.all,include:[...m.include],exclude:[...m.exclude]};})}).catch(errorMessage);
}
function renderCategory(source){
 const m=model(source),card=document.getElementById('category-'+source.id);if(!card)return;
 if(m.all&&m.complete&&m.items.length&&m.items.every(item=>m.exclude.has(item.url))){m.all=false;m.exclude.clear();m.include.clear();}
 const whole=card.querySelector('.category-whole');whole.checked=m.all&&!m.exclude.size;whole.indeterminate=m.all?m.exclude.size>0:m.include.size>0;
 card.querySelector('.category-count').textContent=m.loading?`${m.items.length} entries · reading…`:m.items.length?`${m.items.length}${m.complete?'':'+'}`:'';
 card.querySelector('.catalog-note').textContent=m.error|| (m.loading?'Reading…':m.complete?'':automaticQueue.includes(source)?'Waiting…':m.items.length?'Incomplete — continues by itself.':'Waiting for D&D Beyond…');
 // Drawn anew while a list is read: where one has scrolled to stays.
 const host=card.querySelector('.catalog-list'),scrolled=host.scrollTop;host.textContent='';
 const search=m.search.toLocaleLowerCase('en'),items=m.items.filter(item=>item.title.toLocaleLowerCase('en').includes(search));
 for(const item of items.slice(0,m.shown)){
  const label=document.createElement('label');label.className='catalog-row';const cb=document.createElement('input');cb.type='checkbox';cb.checked=selected(m,item.url);cb.dataset.url=item.url;
  cb.onchange=()=>{if(m.all){if(cb.checked)m.exclude.delete(item.url);else m.exclude.add(item.url);}else{if(cb.checked)m.include.add(item.url);else m.include.delete(item.url);}renderCategory(source);updateSelection();};
  const span=document.createElement('span');span.textContent=item.title;label.append(cb,span);host.append(label);
 }
 if(m.items.length&&!items.length){const empty=document.createElement('p');empty.className='muted';empty.textContent='No matches for this search.';host.append(empty);}
 host.scrollTop=scrolled;
 const more=card.querySelector('.catalog-more');more.hidden=items.length<=m.shown;more.textContent=`Show ${Math.min(150,items.length-m.shown)} more`;
}
function buildCategories(){
 $('categories').textContent='';
 for(const source of sources){
  const m=model(source),details=document.createElement('details');details.className='category';details.id='category-'+source.id;
  const summary=document.createElement('summary'),cb=document.createElement('input'),name=document.createElement('span'),count=document.createElement('small');
  cb.type='checkbox';cb.className='category-whole';cb.setAttribute('aria-label','Entire category: '+title(source));cb.onclick=event=>event.stopPropagation();
  cb.onchange=()=>{m.all=cb.checked;m.include.clear();m.exclude.clear();renderCategory(source);updateSelection();};name.textContent=title(source);name.className='category-name';count.className='category-count';
  const chevron=document.createElement('span');chevron.className='category-chevron';chevron.setAttribute('aria-hidden','true');summary.append(cb,name,count,chevron);
  // Only the name, the count and the arrow fold it: a click that misses the
  // box beside them, or lands while a list above grows, changes nothing.
  summary.onclick=event=>{if(!event.target.closest('.category-name,.category-count,.category-chevron'))event.preventDefault();};
  const content=document.createElement('div');content.className='category-content';const tools=document.createElement('div');tools.className='category-tools';
  const search=document.createElement('input');search.type='search';search.placeholder='Search this category…';search.setAttribute('aria-label',search.placeholder);search.oninput=()=>{m.search=search.value;m.shown=150;renderCategory(source);};tools.append(search);
  const note=document.createElement('p');note.className='catalog-note';note.setAttribute('aria-live','polite');const list=document.createElement('div');list.className='catalog-list';
  const more=document.createElement('button');more.type='button';more.className='catalog-more';more.onclick=()=>{m.shown+=150;renderCategory(source);};content.append(tools,note,list,more);details.append(summary,content);$('categories').append(details);renderCategory(source);
 }
}
async function readList(source){
 const result=await ask({type:'AW_CATALOG_GET',profileId:profile.id,sourceId:source.id}),m=model(source);
 m.items=result.items;m.complete=result.complete;m.loading=result.loading;m.jobId=result.jobId;m.error=result.error;
 renderCategory(source);updateSelection();
}
function permission(){
 if(permissionGranted)return Promise.resolve();
 return chrome.permissions.request({origins:[profile.origin+'/*']}).then(granted=>{if(!granted)throw Error('Allow D&D Beyond site access in Chrome to read and export your content.');permissionGranted=true;});
}
chrome.permissions.onRemoved?.addListener(()=>{permissionGranted=false;});
async function startList(source,refresh){
 const result=await ask({type:'AW_CATALOG_START',profileId:profile.id,sourceId:source.id,refresh});
 const m=model(source);m.loading=true;m.jobId=result.jobId;m.error=null;m.complete=false;m.refreshed=true;renderCategory(source);
}
async function waitList(source,finish=false){
 const m=model(source);
 while(m.loading&&!closed&&(finish||!automaticPaused)){
  await delay(700);if(!finish&&automaticPaused)break;await readList(source);
 }
}
function startAutomaticReading(reset=false){
 if(closed||submitting)return;
 if(reset){for(const source of sources)model(source).refreshed=false;automaticQueue=[...sources];}
 if(automaticTask)return;
 if(!permissionGranted){message('Allow D&D Beyond site access in Chrome, then reopen DiceFox.',true);return;}
 automaticPaused=false;
 automaticTask=(async()=>{
  while(automaticQueue.length&&!automaticPaused&&!closed){
   const source=automaticQueue.shift(),m=model(source);
   if(m.refreshed&&m.complete)continue;
   message('Reading D&D Beyond lists…');
   if(!m.loading){
    try{await startList(source,!m.refreshed);}
    catch(error){
     if(/another task|running task|current task/i.test(String(error.message))){automaticQueue.unshift(source);message('Waiting for the current browser task…');await delay(1500);continue;}
     m.error=String(error.message||error);renderCategory(source);continue;
    }
   }else m.refreshed=true;
   await waitList(source);
   if(automaticPaused&&!m.complete){automaticQueue.unshift(source);break;}
  }
  if(!automaticPaused&&!closed){const failed=sources.some(source=>model(source).error);message(failed?'Some lists could not be read. Check your D&D Beyond login and reopen DiceFox.':'Overview ready.',failed);}
 })().catch(errorMessage).finally(()=>{automaticTask=null;});
}
async function pauseAutomaticReading(){automaticPaused=true;if(automaticTask)await automaticTask;}
async function stopList(source){const m=model(source);if(m.jobId)await ask({type:'AW_CATALOG_STOP',jobId:m.jobId});await waitList(source,true);}
async function finishLists(){
 // Explicit entry selections can use the names already read. A whole category
 // with exclusions needs its complete list to determine exactly what remains.
 for(const source of sources)if(model(source).loading)await stopList(source);
 for(const source of sources){
  const m=model(source);if(!m.all||!m.exclude.size||m.complete)continue;
  message('Completing the selected '+title(source)+' list before export…');
  await startList(source,false);await waitList(source,true);
  if(!m.complete)throw Error(m.error||'The selected list could not be completed. Check your D&D Beyond login and reopen DiceFox.');
 }
}
function openDialog(){$('exportDialog').showModal();}
async function closeDialog(){
 const frame=$('exportFrame');if(activeDraft)frame.contentWindow.postMessage({type:'DICEFOX_CANCEL',draftId:activeDraft},location.origin);
 const draft=activeDraft;frame.removeAttribute('src');$('exportDialog').close();activeDraft=null;submitting=false;updateSelection();
 if(draft)try{await ask({type:'AW_EXPORT_CANCEL',exportId:draft});}catch(error){errorMessage(error);}
 automaticPaused=false;
 startAutomaticReading(refreshPending);refreshPending=false;
}
$('closeExport').onclick=closeDialog;$('exportDialog').addEventListener('cancel',event=>{event.preventDefault();closeDialog();});
$('start').onclick=async()=>{
 if(submitting||!profile)return;submitting=true;updateSelection();message('Preparing export…');
 try{
  await permission();await pauseAutomaticReading();await finishLists();
  const selection=sources.map(source=>{const m=model(source);return {sourceId:source.id,all:m.all,include:[...m.include],exclude:[...m.exclude]};}).filter(row=>row.all||row.include.length);
  const result=await ask({type:'AW_EXPORT_DRAFT',profileId:profile.id,selection});activeDraft=result.id;
  $('exportFrame').src=chrome.runtime.getURL('stream.html')+'?embedded=1&draft='+encodeURIComponent(result.id);openDialog();message('');
 }catch(error){submitting=false;updateSelection();errorMessage(error);}
};
async function appStatus(){
 try{const connected=await DiceFoxAW.status();$('appStatus').textContent=connected==='connected'?'AnotherWorldbuilder found on this device.':connected==='outdated'?'Update AnotherWorldbuilder to 0.2.9 or later.':'Open AnotherWorldbuilder and enable Options → Browser to export.';}
 catch{$('appStatus').textContent='Open AnotherWorldbuilder and enable Options → Browser to export.';}
}
chrome.runtime.onMessage?.addListener(msg=>{
 if(msg?.target!=='selection'||msg.type!=='REFRESH')return;
 void appStatus();if(!profile)return;
 if(submitting){refreshPending=true;return;}
 void chrome.permissions.contains({origins:[profile.origin+'/*']}).then(allowed=>{permissionGranted=allowed;if(!automaticTask)startAutomaticReading(true);}).catch(errorMessage);
});
window.addEventListener('message',event=>{if(event.origin!==location.origin||event.source!==$('exportFrame').contentWindow||event.data?.type!=='DICEFOX_EXPORT_STATE'||event.data.draftId!==activeDraft)return;$('closeExport').textContent=event.data.active?'Pause and close':'Close';});
const appPoll=setInterval(()=>{if(!closed)void appStatus();},5000);
window.addEventListener('pagehide',()=>{clearInterval(appPoll);closed=true;automaticPaused=true;});
(async()=>{
 const result=await ask({type:'AW_SELECTION_PROFILE'});profile=result.profile;sources=result.sources;
 permissionGranted=await chrome.permissions.contains({origins:[profile.origin+'/*']});
 sources.sort((a,b)=>(a.kind==='my-library'?-1:b.kind==='my-library'?1:0));
 const key='dicefox:selection-ui:'+profile.id,saved=(await chrome.storage.local.get(key))[key]||[];
 for(const row of saved){const source=sources.find(s=>s.id===row.sourceId);if(!source)continue;const m=model(source);m.all=!!row.all;m.include=new Set(row.include||[]);m.exclude=new Set(row.exclude||[]);}
 buildCategories();await Promise.all(sources.map(readList));
 const tabId=Number(new URLSearchParams(location.search).get('tab'));let tab=null;
 if(tabId)tab=await chrome.tabs.get(tabId).catch(()=>null);else [tab]=await chrome.tabs.query({active:true,currentWindow:true});
 const kind=tab?.url?LWLProviders.get('dndbeyond').classify(tab.url):null,source=sources.find(s=>s.kind===kind)||sources[0];
 if(source){
  document.getElementById('category-'+source.id).open=true;
  if(kind&&tab?.url){
   const u=new URL(tab.url),isCategory=/^\/(?:en\/library|classes|backgrounds|species|feats|spells|equipment|magic-items|monsters)\/?$/.test(u.pathname);
   if(!isCategory&&!u.pathname.startsWith('/subclasses/')){
    if(kind==='my-library')u.pathname=u.pathname.match(/^\/sources\/(?:dnd\/)?[^/]+/)?.[0]||u.pathname;
    const url=normal(u.href),m=model(source);if(!m.items.some(item=>item.url===url))m.items.unshift({url,title:kind==='my-library'?LWLUrl.slugFromUrl(url):tab.title||LWLUrl.slugFromUrl(url)});
    if(!saved.length)m.include.add(url);renderCategory(source);
   }
  }
  sources=[source,...sources.filter(s=>s!==source)];
 }
 updateSelection();void appStatus();
 const savedExport=await ask({type:'AW_STREAM_GET'});
 if(savedExport.job&&savedExport.progress?.status!=='complete'&&savedExport.job.profileId===profile.id){activeDraft=savedExport.job.id;submitting=true;automaticPaused=true;updateSelection();$('exportFrame').src=chrome.runtime.getURL('stream.html')+'?embedded=1&draft='+encodeURIComponent(activeDraft);openDialog();return;}
 if(/^https:\/\/(?:[^/]+\.)?dndbeyond\.com(?:\/|$)/i.test(tab?.url||''))startAutomaticReading(true);
})().catch(errorMessage);
