'use strict';
const $=id=>document.getElementById(id),id=new URLSearchParams(location.search).get('draft');
const ask=async msg=>{const r=await chrome.runtime.sendMessage({target:'background',...msg});if(!r?.ok)throw Error(r?.error||'DiceFox did not respond.');return r;};
let profileId='',kinds=[],worlds=[],template=[],pages=[],world='',valid=false,active=false,progress=null,job=null,ticket=0,starting=false,closed=false,checking=false,reason='';
function error(e){$('error').textContent=String(e.message||e);}
function buttons(){
 const complete=progress?.status==='complete';
 $('go').hidden=active||complete;$('go').disabled=starting||!world||!valid;
 $('go').textContent=job?'Resume export':'Export now';$('stop').hidden=!active;
 $('world').disabled=active||starting;if(active)$('kept').hidden=true;
 // The switches count when an export starts, not while it runs.
 for(const name of ['refresh','fresh'])$(name).closest('label').hidden=active;
 window.parent.postMessage({type:'DICEFOX_EXPORT_STATE',draftId:id,active},location.origin);
}
// The check keeps its place while it runs: what comes in later moves nothing below it.
async function check(){
 const revision=++ticket;valid=false;buttons();
 $('templateSummary').textContent=!world?'Choose a world.':active?'Checked at the start.':'Checking…';$('typeDetails').style.visibility='hidden';
 if(!world||active)return;
 try{
  const live=await DiceFoxAW.types(world);if(revision!==ticket)return;
  const contract=AWTemplates.prepare(live,template,AWTemplates.required(kinds),AWTemplates.visible(kinds));
  valid=contract.ok;$('typeDetails').style.visibility='';
  $('templateSummary').textContent=valid?`${contract.compatible.length} types match · ${contract.missing.length} new · ${contract.updates.length} updated`:'Templates differ — see below.';
  $('typeRows').textContent='';
  for(const line of [...contract.errors.map(e=>`${e.type}${e.field?' / '+e.field:''}: ${e.reason}`),...contract.missing.map(t=>'New: '+t.name),...contract.updates.map(t=>'Icon from the template: '+t.name)]){const li=document.createElement('li');li.textContent=line;$('typeRows').append(li);}
  const selected=worlds.find(w=>w.key===world);$('shared').hidden=!(selected?.members>1);
  $('shared').textContent=selected?.members>1?`${selected.members} members see what their types allow.`:'';
 }catch(e){if(revision===ticket)error(e);}finally{buttons();}
}
async function connect(){
 if(checking||active||starting||closed)return;checking=true;
 try{
  const status=await DiceFoxAW.status();
  if(status!=='connected'){
   world='';valid=false;$('world').textContent='';buttons();
   $('connection').textContent=status==='outdated'?'Update AnotherWorldbuilder to 0.2.4 or later.':'Open AnotherWorldbuilder and enable Options → Browser.';return;
  }
  const available=await DiceFoxAW.worlds(),signature=list=>JSON.stringify(list.map(w=>[w.key,w.name,w.members]));
  if(signature(worlds)===signature(available)&&$('world').options.length>0){if(!valid&&world)await check();return;}
  worlds=available;const select=$('world');select.textContent='';
  const empty=document.createElement('option');empty.value='';empty.textContent='Choose a world…';select.append(empty);
  for(const w of worlds){const o=document.createElement('option');o.value=w.key;o.textContent=w.name+(DiceFoxAW.instances().length>1?' · '+w.appName+' · '+w.appPort:'');select.append(o);}
  if(!worlds.some(w=>w.key===world))world='';
  if(!world&&job){world=worlds.find(w=>w.id===job.world.id&&w.appName===job.world.appName&&w.appPort===job.world.appPort)?.key||'';}
  select.value=world;$('connection').textContent=worlds.length?'Connected.':'No GM worlds in the app.';
  await check();
 }catch(e){error(e);}finally{checking=false;}
}
async function snapshot(){
 const data=await ask({type:'AW_STREAM_GET'});if(closed)return;
 if(data.job?.id!==id){buttons();return;}
 const was=active;job=data.job;progress=data.progress;active=!!data.active;
 if(was&&!active)void kept();
 if(!progress)return;
 $('state').textContent=progress.status==='complete'?'Export complete':active?'Exporting…':'Export paused';
 // Before the entries are known, the lists are read: only where that stands.
 const total=progress.total||job.total;
 // While lists are still to be read, the whole counts what they will bring, and says it grows.
 const whole=(progress.total||0)+(progress.coming||0),open=progress.final===false;
 $('progress').textContent=whole||total?`${progress.done} / ${whole||total}${open?'+':''}${progress.current?' · '+progress.current:''}`:progress.current||'';
 $('bar').style.width=whole?Math.round(progress.done/whole*100)+'%':'0';
 const n=progress.totals||{};$('totals').textContent=`${n.new||0} new · ${n.known||0} present${n.updated?' · '+n.updated+' updated':''}${n.gone?' · '+n.gone+' left out':''} · ${n.images||0} images${n.missingImages?' · '+n.missingImages+' images missing':''}`;
 // Why the export stopped says nothing once it runs again; what this page said itself stays.
 const why=active?'':progress.error||'';
 if(why!==reason){if(why||$('error').textContent===reason)$('error').textContent=why;reason=why;}
 showLists(progress.lists,progress.kind);showGone(job.gone||[]);
 buttons();
}
// Each list with how far it is; the one being read stands out.
function showLists(lists,kind){
 $('lists').hidden=!lists?.length;$('selection').hidden=!!lists?.length;
 $('lists').replaceChildren(...(lists||[]).map(l=>{
  const li=document.createElement('li'),name=document.createElement('span'),count=document.createElement('span');
  li.className=active&&l.kind===kind?'current':l.listed&&l.total&&l.done===l.total?'done':'';
  name.textContent=l.name;
  count.textContent=!l.listed&&active&&l.kind===kind?'reading…':l.listed||l.total?`${l.done} / ${l.total}`:'—';
  li.append(name,count);return li;
 }));
}
// What was left out and why — to check afterwards whether the reading lacks something.
let goneShown=-1;
function showGone(gone){
 if(gone.length===goneShown)return;goneShown=gone.length;
 $('gone').hidden=!gone.length;$('goneTitle').textContent=`Left out (${gone.length})`;
 $('goneList').replaceChildren(...gone.map(g=>{
  const li=document.createElement('li'),a=document.createElement('a');
  a.href=g.u||g;a.target='_blank';a.rel='noopener';a.textContent=g.t||g.u||g;
  li.append(a,document.createTextNode(g.why?' — '+g.why:''));return li;
 }));
 $('copyGone').onclick=()=>navigator.clipboard.writeText(gone.map(g=>[g.t,g.s,g.u||g,g.why].filter(Boolean).join(' | ')).join('\n'));
}
$('world').onchange=()=>{world=$('world').value;$('error').textContent='';check();};
$('go').onclick=async()=>{
 if(starting||!valid||!world)return;starting=true;$('error').textContent='';buttons();
 try{
  await ask({type:'AW_STREAM_START',exportId:id,profileId,world:worlds.find(w=>w.key===world),resume:!!job,refresh:$('refresh').checked,fresh:$('fresh').checked});
  await snapshot();
 }catch(e){error(e);}finally{starting=false;buttons();}
};
// Pages read before are kept in this browser; the next export takes them from there.
async function kept(forget=false){
 try{const {count}=await ask({type:'AW_PAGES',forget});$('kept').hidden=!count||active;$('keptCount').textContent=`${count} pages kept in this browser`;}
 catch(e){if(forget)error(e);}
}
$('forget').onclick=()=>kept(true);
$('stop').onclick=async()=>{ $('stop').disabled=true;try{await ask({type:'AW_STREAM_STOP',exportId:id});await snapshot();}catch(e){error(e);}finally{$('stop').disabled=false;} };
window.addEventListener('message',event=>{if(event.origin===location.origin&&event.source===window.parent&&event.data?.type==='DICEFOX_CANCEL'&&event.data.draftId===id)void $('stop').onclick();});
const poll=setInterval(()=>{if(!closed)void snapshot().catch(error);},1000);
const connectionPoll=setInterval(()=>{if(!active)void connect();},3000);
window.addEventListener('pagehide',()=>{closed=true;clearInterval(poll);clearInterval(connectionPoll);});
(async()=>{
 if(!id)throw Error('Select content in DiceFox before exporting.');
 const data=await ask({type:'AW_STREAM_GET'});
 if(data.job?.id===id){
  job=data.job;profileId=job.profileId;kinds=job.kinds;active=!!data.active;world=job.world.key;
  const option=document.createElement('option');option.value=world;option.textContent=job.world.name;$('world').append(option);$('world').value=world;
  $('connection').textContent=active?'Exporting to '+job.world.appName+'.':'Reconnecting to the selected world…';
 }
 else{
  const key='dicefox:export-draft:'+id,draft=(await chrome.storage.local.get(key))[key];
  if(!draft||Date.now()-draft.createdAt>24*60*60*1000)throw Error('The selection expired. Select the content again.');
  profileId=draft.profileId;const plan=await ask({type:'AW_EXPORT_PLAN',...draft});kinds=plan.sources.map(s=>s.kind);
 }
 [template,pages]=await Promise.all(['dnd5e-types','dnd5e-pages'].map(name=>fetch(chrome.runtime.getURL('aw/'+name+'.json')).then(r=>r.json())));
 $('selection').textContent=kinds.filter(k=>k!=='rules-glossary').join(', ');
 await snapshot();if(!job)$('state').textContent='Ready to export';void kept();await connect();
})().catch(error);
