'use strict';
const $=id=>document.getElementById(id),de=LWLI18n.isGerman,t=(en,dt)=>de?dt:en;
const params=new URLSearchParams(location.search),session=params.get('session')||crypto.randomUUID();
params.set('session',session);history.replaceState(null,'','?'+params);
const draftKey='lwl_guided_draft_'+session;
let profiles=[],tabs=[],picks={},origin='',ownTab=null;
const steps=[
 ['itemContainerSelector','An item card','Eine Buch- oder Inhaltskarte','Choose the complete repeated card containing its link, title and cover.','Wähle die vollständige Karte mit Link, Titel und Cover.'],
 ['itemLinkSelector','Book or item link','Link zum Buch oder Inhalt','On the collection page, click a link that opens a book or item.','Klicke auf der Übersichtsseite auf einen Link, der ein Buch oder einen Inhalt öffnet.'],
 ['itemTitleSelector','Title in the card','Titel auf der Karte','Click a readable title on the collection page.','Klicke auf einen lesbaren Titel auf der Übersichtsseite.'],
 ['itemCoverSelector','Cover image','Coverbild','Click an original cover image on the collection page.','Klicke auf ein Coverbild auf der Übersichtsseite.'],
 ['navigationSelector','Chapter link','Kapitelverzeichnis','Open a book in a website tab, then select a chapter link from its contents.','Öffne ein Buch in einem Website-Tab und wähle einen Kapitellink im Inhaltsverzeichnis.'],
 ['detailSelector','Complete content','Vollständiger Inhalt','Open a chapter and select its full article, including all sections. Use Larger area when needed.','Öffne ein Kapitel und markiere den vollständigen Artikel mit allen Abschnitten. Nutze bei Bedarf „Größerer Bereich“.'],
 ['detailTitleSelector','Page heading','Seitenüberschrift','Select the heading that names this chapter or document.','Wähle die Überschrift dieses Kapitels oder Dokuments.'],
 ['detailExcludeSelectors','An unwanted area','Unerwünschter Bereich','Optionally select a remaining navigation, banner or unrelated area to exclude.','Wähle optional einen störenden Bereich, etwa eine verbliebene Navigation oder einen Banner.']
];
const status=(s,error=false)=>{$('status').textContent=s;$('status').classList.toggle('error',error);};
const currentProfile=()=>profiles.find(p=>p.id===$('profile').value);
const currentSource=()=>currentProfile()?.sources.find(s=>s.id===$('source').value);
async function persist(){await chrome.storage.local.set({[draftKey]:{picks,origin,profileId:$('profile').value,sourceId:$('source').value,name:$('name').value,updatedAt:Date.now()}});}
function proposed(){
 const source=currentSource()||{name:$('name').value||t('Selected content','Ausgewählter Inhalt'),type:$('type').value,startUrl:picks.itemLinkSelector?.url||picks.navigationSelector?.url||tabs.find(x=>String(x.id)===$('page').value)?.url,contentSelector:'body',navigationScope:'itemPrefix',followDepth:2,discoveryMode:'auto'};
 return {...LWLGuidedRules.apply(source,picks),name:$('name').value.trim()||source.name};
}
function render(){
 $('steps').replaceChildren();
 for(const [field,en,dt,helpEn,helpDt] of steps){
  const row=document.createElement('section');row.className='step';const content=document.createElement('div'),heading=document.createElement('h2'),help=document.createElement('p'),note=document.createElement('small');
  heading.textContent=t(en,dt);help.textContent=t(helpEn,helpDt);
  note.textContent=picks[field]?picks[field].count+t(' matching elements selected',' passende Elemente gewählt'):t('Optional — keep automatic detection unless you select this.','Optional – ohne Auswahl bleibt die bisherige Erkennung aktiv.');
  content.append(heading,help,note);const actions=document.createElement('div');actions.className='actions';const button=document.createElement('button');button.textContent=picks[field]?t('Select again','Neu auswählen'):t('Select on website','Auf Website auswählen');button.onclick=()=>pick(field,t(en,dt));actions.append(button);
  if(picks[field]){const clear=document.createElement('button');clear.className='clear';clear.textContent=t('Remove','Entfernen');clear.onclick=()=>{delete picks[field];persist();render();};actions.append(clear);}
  row.append(content,actions);$('steps').append(row);
 }
 $('review').hidden=!Object.keys(picks).length;$('samples').replaceChildren();
 for(const [field,p] of Object.entries(picks)){
  const block=document.createElement('div');block.className='sample';const title=document.createElement('strong');const step=steps.find(s=>s[0]===field);title.textContent=t(step[1],step[2])+' · '+p.count+t(' matches',' Treffer');block.append(title);
  if(field==='detailSelector'){const size=document.createElement('p');size.textContent=p.characters.toLocaleString()+t(' characters in the selected content area',' Zeichen im gewählten Inhaltsbereich');block.append(size);}
  for(const sample of p.samples||[]){const line=document.createElement('p');line.textContent=sample.title;block.append(line);}
  const page=document.createElement('small');page.textContent=t('Selected on: ','Gewählt auf: ')+p.url;block.append(page);$('samples').append(block);
 }
 $('rules').textContent=Object.keys(picks).length?JSON.stringify(proposed(),null,2):'';
}
function sourceOptions(selected){
 $('source').replaceChildren();const blank=document.createElement('option');blank.value='';blank.textContent=t('Create a new source','Neue Quelle anlegen');$('source').append(blank);
 for(const s of currentProfile()?.sources||[]){const o=document.createElement('option');o.value=s.id;o.textContent=s.name;$('source').append(o);}
 $('source').value=selected||'';sourceChanged();
}
function sourceChanged(){const s=currentSource();$('name').value=s?.name||t('Selected content','Ausgewählter Inhalt');$('typeRow').hidden=Boolean(s);render();}
async function refreshPages(){
 tabs=(await chrome.tabs.query({})).filter(tab=>/^https?:/.test(tab.url||'')&&(!origin||new URL(tab.url).origin===origin));
 const previous=$('page').value||params.get('tab');$('page').replaceChildren();
 for(const tab of tabs){const option=document.createElement('option');option.value=tab.id;option.textContent=tab.title||tab.url;$('page').append(option);}
 if(tabs.some(tab=>String(tab.id)===previous))$('page').value=previous;
}
async function pick(field,label){
 try{
  await refreshPages();const tab=tabs.find(tab=>String(tab.id)===$('page').value);if(!tab)throw Error(t('Open the website in a Chrome tab first.','Öffne die Website zuerst in einem Chrome-Tab.'));
  const pattern=new URL(tab.url).origin+'/*';if(!await chrome.permissions.contains({origins:[pattern]})&&!await chrome.permissions.request({origins:[pattern]}))throw Error(t('Website access was not granted.','Der Website-Zugriff wurde nicht erteilt.'));
  origin=new URL(tab.url).origin;await persist();
  await chrome.scripting.executeScript({target:{tabId:tab.id},files:['guided_rules.js','guided_picker.js']});
  const result=await chrome.tabs.sendMessage(tab.id,{type:'LWL_GUIDED_PICK',session,field,label,language:de?'de':'en'});if(!result?.ok)throw Error(result?.error||'Selection could not start');
  await chrome.tabs.update(tab.id,{active:true});status(t('Choose the area on the website, then confirm the highlighted selection.','Wähle den Bereich auf der Website und bestätige die markierte Auswahl.'));
 }catch(e){status(e.message,true);}
}
chrome.storage.onChanged.addListener(async(changes,area)=>{
 const change=changes.lwl_guided_result?.newValue;if(area!=='local'||change?.session!==session)return;
 if(!LWLGuidedRules.fields.includes(change.field)||new URL(change.result.url).origin!==origin)return;
 picks[change.field]=change.result;await persist();render();status(t('Selection received. Review the matches before saving.','Auswahl übernommen. Prüfe die Treffer vor dem Speichern.'));if(ownTab)await chrome.tabs.update(ownTab.id,{active:true});
});
$('save').onclick=async()=>{
 try{
  if(!Object.keys(picks).length)return;
  const selected=currentProfile();const source=proposed();if(!source.startUrl)throw Error(t('Select a website page first.','Wähle zuerst eine Website-Seite.'));
  if(new URL(source.startUrl).origin!==origin)throw Error(t('The source and selected page must belong to the same website.','Quelle und ausgewählte Seite müssen zur gleichen Website gehören.'));
  const p=selected?structuredClone(selected):{name:new URL(source.startUrl).hostname,origin:new URL(source.startUrl).origin,sources:[]};
  const index=p.sources.findIndex(s=>s.id===$('source').value);
  const normalized=LWLProfiles.normalizeSource(source,index<0?p.sources.length:index,p.origin);
  if(index<0&&p.sources.some(s=>s.id===normalized.id))throw Error(t('A source with this name already exists. Select it above or choose a different name.','Eine Quelle mit diesem Namen existiert bereits. Wähle sie oben aus oder verwende einen anderen Namen.'));
  if(index<0)p.sources.push(normalized);else p.sources[index]=normalized;
  const saved=await LWLProfiles.save(p);profiles=await LWLProfiles.list();
  if(![...$('profile').options].some(o=>o.value===saved.id)){const option=document.createElement('option');option.value=saved.id;option.textContent=saved.name;$('profile').append(option);}
  $('profile').value=saved.id;sourceOptions(normalized.id);
  await chrome.storage.local.remove(draftKey);status(t('Rules saved. The next synchronization will use your selected areas.','Regeln gespeichert. Die nächste Synchronisierung verwendet deine ausgewählten Bereiche.'));
  $('save').disabled=true;setTimeout(()=>$('save').disabled=false,1500);
 }catch(e){status(e.message,true);}
};
$('profile').onchange=()=>{picks={};origin=currentProfile()?.origin||origin;sourceOptions();refreshPages();persist();};
$('source').onchange=()=>{picks={};sourceChanged();persist();};$('refresh').onclick=refreshPages;$('name').oninput=()=>{persist();render();};$('type').onchange=render;
(async()=>{
 document.documentElement.lang=de?'de':'en';
 for(const [id,en,dt] of [['heading','Guided detection','Geführte Erkennung'],['intro','Teach the extension where links, titles, covers and complete content are. Select only what automatic detection got wrong.','Zeige der Erweiterung, wo Links, Titel, Cover und vollständige Inhalte stehen. Wähle nur die Bereiche aus, die automatisch falsch erkannt wurden.'],['profileLabel','Profile','Profil'],['sourceLabel','Apply to source','Für welche Quelle?'],['pageLabel','Website tab','Website-Tab'],['refresh','Refresh open tabs','Offene Tabs aktualisieren'],['pageHint','For chapter links or content, first open the relevant book or chapter in the website tab. Each selection is previewed before you save any rules.','Öffne für Kapitellinks oder Inhalte zuerst das entsprechende Buch oder Kapitel im Website-Tab. Jede Auswahl wird vor dem Speichern als Vorschau gezeigt.'],['reviewHeading','Review your selection','Auswahl prüfen'],['rulesLabel','Advanced: learned rules','Erweitert: erkannte Regeln'],['nameLabel','Source name','Name der Quelle'],['typeLabel','Content type','Art des Inhalts'],['save','Save rules to profile','Regeln im Profil speichern']])$(id).textContent=t(en,dt);
 ownTab=await chrome.tabs.getCurrent();profiles=await LWLProfiles.list();
 const original=Number(params.get('tab'));let tab;try{tab=await chrome.tabs.get(original);}catch{}
 const draft=(await chrome.storage.local.get(draftKey))[draftKey];origin=draft?.origin||(tab?.url&&/^https?:/.test(tab.url)?new URL(tab.url).origin:'');
 const available=profiles.filter(p=>!origin||p.origin===origin);const blank=document.createElement('option');blank.value='';blank.textContent=t('New profile for this site','Neues Profil für diese Website');$('profile').append(blank);
 for(const p of available){const o=document.createElement('option');o.value=p.id;o.textContent=p.name;$('profile').append(o);}
 $('profile').value=draft?.profileId||available[0]?.id||'';origin ||= currentProfile()?.origin||'';
 sourceOptions(draft?.sourceId||currentProfile()?.sources.find(s=>s.type==='collection')?.id);picks=draft?.picks||{};if(draft?.name)$('name').value=draft.name;
 await refreshPages();render();
})().catch(e=>status(e.message,true));
