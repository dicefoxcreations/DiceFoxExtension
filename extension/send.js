"use strict";
// One explicit selection, one GM world, a checked schema, then app-only import.
const $ = id => document.getElementById(id);
const tr = (_de,en) => en;
const q = new URLSearchParams(location.search);
let WORLD = q.get('world') || '';
const SCOPE = q.get('scope') === 'page' ? 'page' : 'library';
const PAGE = q.get('url') || '';
const BATCH = 25;
let fresh = q.get('capture') === '1';
const embedded=q.get('embedded')==='1';
if(embedded)document.body.classList.add('embedded');
const sourceIds = q.getAll('source');
const targets = q.getAll('pick');
const wholeSourceIds=q.getAll('whole');
const exportId = q.get('draft') || globalThis.crypto?.randomUUID?.() || 'export-'+Date.now()+'-'+Math.random();
const ask = msg => chrome.runtime.sendMessage({target:'background',...msg}).then(r => {if(!r?.ok)throw Error(r?.error || 'failed');return r;});
const parser = new DOMParser();
const parse = html => parser.parseFromString(`<!doctype html><body>${html}`,'text/html');
const sameUrl = u => String(u || '').split(/[?#]/)[0].toLowerCase().replace(/\/+$/,'').replace('/sources/dnd/free-rules','/sources/dnd/br-2024');
const kindName=kind=>{
 const names={classes:['Klassen','Classes'],backgrounds:['Hintergründe','Backgrounds'],species:['Spezies','Species'],feats:['Talente','Feats'],spells:['Zauber','Spells'],equipment:['Ausrüstung','Equipment'],'magic-items':['Magische Gegenstände','Magic items'],monsters:['Monster','Monsters'],'book-chapter':['Kapitel','Chapters']};
 return names[kind]?tr(...names[kind]):kind;
};
let profileId = q.get('profile') || '';
let conv=null,bookConv=null,lib=null,chosen=[],extraTypes=[],overviewDocs=[],stopped=false;
let contract=null,template=null,pages=null,plan=null,worlds=[],generation=0,busySending=false,didCapture=!fresh,capturePartial=false;
let selected=new Set(),selectionReady=false,selectionRows=[],connectionReady=false,connecting=false;
function log(line){$('log').textContent+=line+'\n';}
function state(text,kind=''){$('state').textContent=text;$('state').className='state'+(kind?' '+kind:'');}
function progress(done,total,text){$('bar').style.width=total?`${Math.round(done/total*100)}%`:'0';$('progress').textContent=text || '';}
function fail(err){state(tr('Fehler','error'));$('note').textContent=String(err.message || err);log('! '+(err.message || err));}
$('whatTitle').textContent=tr('Auswahl und Import','Selection and import');
$('go').textContent=fresh?tr('Erfassen und importieren','Capture and import'):tr('Importieren','Import');
$('stop').textContent=tr('Anhalten','Stop');
$('logTitle').textContent=tr('Protokoll','Log');
$('unofficial').textContent=tr('Inoffiziell · mit keinem Verlag verbunden','Unofficial · not affiliated with any publisher');
$('refreshWorlds').textContent=tr('Verbindung und Welten neu laden','Refresh connection and worlds');
$('worldLabel').textContent=tr('In welche Welt?','Which world?');
$('worldHelp').textContent=tr('Hier erscheinen nur Welten, in denen du GM bist. Die App prüft die Rechte bei jeder Übertragung erneut.','Only worlds you lead appear here. The app checks permissions again on each transfer.');
$('selectionTitle').textContent=tr('Einzelne Inhalte auswählen','Select individual content');
$('selectionHelp').textContent=tr('Ein Buch wählt seine erfassten Kapitel. Du kannst auch einzelne Kapitel und Einträge wählen. Das Regelglossar kommt als Abhängigkeit mit.','A book selects its captured chapters. You can also select individual chapters and entries. The rules glossary is included as a dependency.');
$('selectionSearch').placeholder=tr('Bücher und Einträge suchen …','Search books and entries …');
$('selectAll').textContent=tr('Alle','All');$('selectNone').textContent=tr('Keine','None');
$('typeTitle').textContent=tr('Vorlagenprüfung','Template check');
$('typeDetailsLabel').textContent=tr('Typen und Prüfergebnis anzeigen','Show types and check results');
$('partialLabel').textContent=tr('Ich möchte die verfügbaren Inhalte trotz der angezeigten Erfassungslücken importieren.','Import available content despite the reported capture gaps.');
$('captureStatusLink').textContent=tr('Erfassungsfortschritt / Pause / Fortsetzen','Capture progress / pause / resume');
$('retryCapture').textContent=tr('Erfassung erneut versuchen','Retry capture');

function permitted(){
 const hasContent=!didCapture || chosen.length || (SCOPE==='library'&&conv?.rules.length);
 return WORLD && contract?.ok && hasContent && (!$('partialField').hidden?$('allowPartial').checked:true);
}
function updateGo(){
 $('go').disabled=busySending || !permitted();
 $('captureTools').hidden=!fresh||(embedded&&(!didCapture||$('partialField').hidden));
 $('retryCapture').hidden=!didCapture || $('partialField').hidden;
 $('retryCapture').disabled=busySending;
}
function showContract(){
 $('typeCard').hidden=false;$('typeRows').textContent='';
 $('typeDetails').open=!contract.ok;
 $('typeSummary').textContent=contract.ok?
  tr(`${contract.compatible.length} vorhandene Typen passen. ${extraTypes.length} fehlende Typen werden angelegt. Bestehende Vorlagen und ihre Rechte bleiben erhalten.`,`${contract.compatible.length} existing types match. ${extraTypes.length} missing types will be created. Existing templates and permissions are retained.`):
  tr('Die Vorlagen passen noch nicht. Es wurde nichts importiert.','The templates do not match yet. Nothing has been imported.');
 const names=new Map(template.map(t=>[t.id,t.name]));
 const reasons={'Missing field':'Feld fehlt','Incompatible field':'Feldformat passt nicht','Missing text section':'Textabschnitt fehlt','Article type / property group mismatch':'Dokumenttyp und Eigenschaftsgruppe verwechselt','A type with this name has a different identity; map it before importing':'Gleichnamiger Typ hat eine andere ID; Zuordnung vor dem Import nötig'};
 for(const error of contract.errors){const li=document.createElement('li');li.textContent=`${names.get(error.type)||error.type}${error.field?' · '+error.field:''}: ${error.reason}`;$('typeRows').append(li);}
 for(const t of extraTypes){const li=document.createElement('li');li.textContent=tr('Neu: ','New: ')+t.name;$('typeRows').append(li);}
}
async function checkTypes(expectedGeneration=generation){
 const live=await DiceFoxAW.types(WORLD);
 if(expectedGeneration!==generation)return false;
 const kinds=plan&&!didCapture?plan.sources.map(s=>s.kind):[...new Set((lib?.index || []).map(e=>e.book?'my-library':e.s))];
 if(lib?.glossary?.length)kinds.push('rules-glossary');
 contract=AWTemplates.prepare(live,template,AWTemplates.required(kinds),AWTemplates.visible(kinds));
 extraTypes=[...contract.missing,...contract.updates];overviewDocs=[];
 for(const t of extraTypes){
  const page=pages.find(p=>p.type===t.id);if(!page)continue;
  t.page=AWIds.articleId('dicefox-overview',t.id);
  overviewDocs.push({id:t.page,type:'',_overviewFor:t.id,slug:t.id+'-page',name:page.name,view:'all',edit:'gm',fields:{},parts:[{section:'list',title:'',text:contract.overview(page.text),fields:{},view:'all',edit:'gm'}]});
 }
 showContract();return contract.ok;
}
function filterLibrary(data){
 if(!targets.length)return data;
 const selectedIndex=data.index.filter(e=>e.s==='rules-glossary'||wholeSourceIds.includes(e.sourceId)||targets.some(url=>sameUrl(e.u)===sameUrl(url)||(e.book&&sameUrl(e.u).startsWith(sameUrl(url)+'/'))));
 const books=new Set(selectedIndex.map(e=>e.book));
 return {...data,index:selectedIndex,books:data.books.filter(b=>books.has(b.id))};
}
async function readLibrary(){
 const data=await ask({type:'AW_LIBRARY',profileId,...(sourceIds.length?{sourceIds}: {})});
 if(!data.token || data.books.some(b=>!b || typeof b!=='object'))throw Error(tr('Lade die Extension neu und öffne Exportieren erneut.','Reload the extension and reopen Export.'));
 lib=filterLibrary(data);
}
function refreshSelection(){
 const steps=[...conv.steps,...bookConv.steps];
 if(!selectionReady){
  let initial=steps;
  if(SCOPE==='page'){
   const want=sameUrl(PAGE),book=lib.books.find(b=>sameUrl(b.url)===want);
   initial=steps.filter(s=>book?s.e.book===book.id:[s.e.u,...(s.e.a || [])].some(u=>sameUrl(u)===want));
   if(!initial.length)throw Error(tr('Die aktuelle Seite wurde noch nicht erfasst.','The current page has not been captured.'));
  }
  selected=new Set(initial.map(s=>String(s.e.i)));selectionReady=true;
 }
 chosen=steps.filter(s=>selected.has(String(s.e.i)));
 selectionRows=[...lib.books.map(b=>({key:'book:'+b.id,name:b.name,children:bookConv.steps.filter(s=>s.e.book===b.id).map(s=>String(s.e.i)),kind:tr('Buch','Book')})),...steps.map(s=>({key:String(s.e.i),name:s.name,kind:s.kind}))];
 $('selectionCard').hidden=embedded;renderSelection();renderCounts();
}
function renderSelection(){
 const host=$('selectionList');host.textContent='';const search=$('selectionSearch').value.toLowerCase();
 const shown=selectionRows.filter(row=>(row.name+' '+row.kind).toLowerCase().includes(search));
 for(const row of shown.slice(0,250)){
  const label=document.createElement('label'),input=document.createElement('input'),text=document.createElement('span');input.type='checkbox';
  input.checked=row.children?row.children.length>0&&row.children.every(k=>selected.has(k)):selected.has(row.key);
  input.indeterminate=!!row.children?.some(k=>selected.has(k))&&!input.checked;
  input.disabled=busySending||!!row.children&&!row.children.length;
  input.onchange=()=>{if(busySending)return;for(const key of row.children||[row.key]){if(input.checked)selected.add(key);else selected.delete(key);}refreshSelection();};
  text.textContent=row.name;const small=document.createElement('small');small.textContent=' · '+kindName(row.kind);text.append(small);label.append(input,text);host.append(label);
 }
 if(shown.length>250){const note=document.createElement('p');note.textContent=tr(`${shown.length} Treffer. Suche eingrenzen; Alle/Keine bezieht sich auf die gesamte Auswahl.`,`${shown.length} matches. Refine the search; All/None applies to the entire selection.`);host.append(note);}
 updateGo();
}
function renderCounts(){
 $('counts').textContent='';
 const counts=new Map();for(const s of chosen)counts.set(s.kind,(counts.get(s.kind)||0)+1);
 if(SCOPE==='library'&&conv.rules.length)counts.set(tr('Regelbegriffe','Rules'),conv.rules.length);
 for(const [name,n]of counts){const box=document.createElement('div'),b=document.createElement('b'),span=document.createElement('span');b.textContent=n.toLocaleString('en');span.textContent=kindName(name);box.append(b,span);$('counts').append(box);}
 const allSelected=chosen.length===conv.steps.length+bookConv.steps.length;
 const wholeBooks=new Set(lib.books.filter(b=>bookConv.steps.some(s=>s.e.book===b.id)&&bookConv.steps.filter(s=>s.e.book===b.id).every(s=>selected.has(String(s.e.i)))).map(b=>b.id));
 const relevant=lib.index.filter(e=>e.book?wholeBooks.has(e.book):allSelected);
 const missing=relevant.filter(e=>!e.has&&e.s!=='rules-glossary').length;
 const incomplete=relevant.filter(e=>e.has&&['incomplete','error','empty','unavailable'].includes(e.captureStatus)).length;
 const gaps=capturePartial||missing||incomplete;
 $('partialField').hidden=!gaps;
 $('note').textContent=tr(`${chosen.length} Einträge/Kapitel ausgewählt. ${missing} bekannte Seiten fehlen, ${incomplete} sind unvollständig erfasst. Neue Dokumente werden ergänzt; vorhandene IDs werden übersprungen und nicht aktualisiert.`,`${chosen.length} entries/chapters selected. ${missing} known pages are missing; ${incomplete} are incomplete. New documents are added; existing IDs are skipped and are not updated.`);
 if(capturePartial)$('note').textContent+=' '+tr('Mindestens eine ausgewählte Quelle konnte nicht vollständig erfasst werden.','At least one selected source could not be captured completely.');
 updateGo();
}
function makeConverters(){
 valueDocs.clear();
 bookConv=AWBooks.create({entries:lib.index,books:lib.books,types:contract.conversionTypes,parse,resolveRule:(href,text)=>conv?.resolve(href,text)});
 conv=AWDndBeyond.create({entries:lib.index,glossary:lib.glossary,types:contract.conversionTypes,owned:lib.ownedBooks || lib.books.map(b=>b.name),selectedUrls:lib.index.filter(e=>e.has).map(e=>e.u),parse,resolveExtra:bookConv.resolve});
 refreshSelection();
}
async function prepare(){
 const ticket=++generation;contract=null;chosen=[];$('go').disabled=true;
 $('typeCard').hidden=true;$('target').textContent='';$('shared').hidden=true;
 if(!WORLD)return;
 state(tr('prüft …','checking …'),'wait');
 const world=worlds.find(w=>(w.key||w.id)===WORLD);if(!world)throw Error(tr('Die Welt ist nicht da oder du bist dort kein GM.','The world is unavailable or you are not its GM.'));
 $('target').textContent=`→ ${world.name}`;
 $('shared').hidden=!(world.members>1);
 $('shared').textContent=tr(`Diese Welt hat ${world.members} Mitglieder. Die Sichtbarkeit der importierten Inhalte richtet sich nach den Vorlagen dieser Welt.`, `This world has ${world.members} members. Imported content follows this world's template permissions.`);
 if(didCapture)await readLibrary();
 if(ticket!==generation)return;
 if(!await checkTypes(ticket)){state(tr('Vorlagen anpassen','Adjust templates'));return;}
 if(didCapture)makeConverters();else $('note').textContent=tr('Nach der Vorlagenprüfung werden nur die ausgewählten Bereiche oder Links erfasst. Bei vollständiger Erfassung folgt der Import. Bei Lücken kannst du die verfügbare Auswahl zuerst prüfen.','After the template check, only selected categories or links are captured. A complete capture is imported. If there are gaps, you can review available content first.');
 state(tr('bereit','ready'),'on');updateGo();
}
async function connect(){
 if(connecting)return;connecting=true;
 try{
 ++generation;
 $('go').disabled=true;contract=null;$('worldField').hidden=true;
 const connected=await DiceFoxAW.status();
 if(connected!=='connected'){
  $('connectionMessage').textContent=connected==='outdated'?'Update AnotherWorldbuilder to 0.2.9 or later, then restart the app.':'Open AnotherWorldbuilder and enable Options → Browser. DiceFox connects automatically.';
  return;
 }
 worlds=await DiceFoxAW.worlds();
 $('connectionMessage').textContent=worlds.length?tr('Verbunden. Wähle eine Welt.','Connected. Choose a world.'):tr('Keine Welt mit GM-Rechten verfügbar. Öffne eine passende Welt in der App oder melde dich dort als GM an.','No worlds with GM permissions are available. Open a suitable world in the app or sign in as GM.');
 const select=$('worldSelect');select.textContent='';const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent=tr('Welt wählen …','Choose a world …');select.append(placeholder);
 for(const world of worlds){const option=document.createElement('option');option.value=world.key||world.id;option.textContent=world.name+(DiceFoxAW.instances?.().length>1?' · '+world.appName+' · '+world.appPort:'');select.append(option);}
 if(!worlds.some(w=>(w.key||w.id)===WORLD))WORLD='';select.value=WORLD;$('worldField').hidden=false;
 if(WORLD)await prepare();
 }finally{connecting=false;}
}
async function capture(){
 await contract.assertCurrent(await DiceFoxAW.types(WORLD));
 const started=await ask({type:'CONFIGURE_SYNC',config:{profileId,sourceIds:plan.sourceIds,targets:plan.targets,wholeSourceIds:plan.wholeSourceIds||[],exportId,assets:q.get('assets')!=='0',delayMs:Number(q.get('delay'))||2000,syncMode:q.get('mode')||'new_only',offline:false}});
 if(started.alreadyRunning)log(tr('Die ausgewählte Erfassung läuft bereits.','The selected capture is already running.'));
 while(!stopped){
  const {state:s}=await ask({type:'GET_STATE'});
  if(s.exportId!==exportId||s.profileId!==profileId||JSON.stringify([...(s.sourceIds||[])].sort())!==JSON.stringify([...plan.sourceIds].sort()))throw Error(tr('Die Erfassung gehört zu einem anderen Export. Es wird nichts importiert.','The capture belongs to another export. Nothing will be imported.'));
  progress(s.progress,s.progressMax,`${s.source || ''} · ${s.page || ''}`);
  state(s.paused?tr('pausiert – im Fortschrittsfenster fortsetzen','paused — continue in the progress window'):tr('erfasst …','capturing …'),'wait');
  if(!s.running&&['complete','partial','stopped','interrupted','error'].includes(s.status)){
   if(!['complete','partial'].includes(s.status))throw Error(tr('Erfassung angehalten oder fehlgeschlagen. Es wurde nichts importiert. Erneut starten, um fortzusetzen.','Capture stopped or failed. Nothing was imported. Start again to continue.'));
   didCapture=true;capturePartial=s.status==='partial';
   await readLibrary();await contract.assertCurrent(await DiceFoxAW.types(WORLD));
   await checkTypes();if(!contract.ok)throw Error(tr('Die erfassten Inhalte brauchen weitere passende Vorlagen.','Captured content requires additional compatible templates.'));
   makeConverters();$('go').textContent=tr('Importieren','Import');
   return !capturePartial && permitted();
  }
  await new Promise(resolve=>setTimeout(resolve,750));
 }
 return false;
}

// --- Pictures ---------------------------------------------------------------------

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg', 'image/avif': 'avif' };
const valueDocs = new Map();
const pictures = new Map(); // url → { id, file, data } or null
let pictureBytes = 0;
function rememberPicture(url, made) {
  pictures.set(url, made);
  pictureBytes += made?.data.length || 0;
  while (pictures.size > 128 || pictureBytes > 64 * 1024 * 1024) {
    const first = pictures.keys().next().value;
    pictureBytes -= pictures.get(first)?.data.length || 0;
    pictures.delete(first);
  }
}
async function picture(url) {
  if(stopped)throw Error(tr('Übertragung angehalten.','Transfer stopped.'));
  if (pictures.has(url)) return pictures.get(url);
  let blob = await LWLIdb.getResource(profileId, url).catch(() => null);
  if (!blob) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      try {
        const r = await fetch(url, { credentials:'omit', signal:controller.signal });
        if (r.ok) blob = await r.blob();
      } finally { clearTimeout(timeout); }
    } catch { /* not cached, not reachable: the document goes without */ }
  }
  let made = null;
  if (blob?.size) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const id = AWIds.imageId(bytes);
    const ext = EXT[(blob.type || '').split(';')[0]] || (/\.([a-z0-9]{2,4})(?:$|\?)/i.exec(url)?.[1] || 'img').toLowerCase();
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    made = { id, file: `images/${id.slice(4)}.${ext}`, data: btoa(s) };
  }
  rememberPicture(url, made);
  return made;
}

/* Image fields name a picture by its URL until here: now by its id, and the
   picture goes along in the package. */
async function withPictures(docs) {
  // Work on copies: retrying a send must retain the original image requests.
  docs = docs.map(d => ({...d, parts:d.parts.map(p => ({...p, fields:{...(p.fields || {})}}))}));
  const images = new Map(), files = {};
  let missing = 0;
  for (const d of docs) for (const p of d.parts) for (const [k, v] of Object.entries(p.fields || {})) {
    if (!v || typeof v !== 'object' || Array.isArray(v) || !v.image) continue;
    const pic = await picture(v.image);
    if (!pic) { delete p.fields[k]; missing++; continue; }
    p.fields[k] = pic.id;
    images.set(pic.id, { id: pic.id, name: v.name, file: pic.file });
    files[pic.file] = pic.data;
  }
  for (const d of docs) {
    for (const request of d._images || []) {
      const pic = await picture(request.url);
      const replacement = pic ? `<image src=${pic.id}>` : tr('*Bild nicht verfügbar.*', '*Image unavailable.*');
      for (const p of d.parts) p.text = p.text.replaceAll(`<image src=${request.token}>`, replacement).replaceAll(`<image src="${request.token}">`, replacement);
      if (pic) { images.set(pic.id, {id:pic.id, name:request.name, file:pic.file}); files[pic.file] = pic.data; }
      else missing++;
    }
    delete d._images;
  }
  return { docs, images: [...images.values()], files, missing };
}

/* Documents are written with names (`%%Armor class%%`), the app turns them
   into keys; types come as the template stores them, with keys already. */
async function send(docs, types = []) {
  const packed = await withPictures(docs.map(d=>contract.document(d)));
  const bytes = Object.values(packed.files).reduce((n,s) => n+s.length, 0) + JSON.stringify(packed.docs).length + JSON.stringify(types).length;
  const combine = (a,b) => ({...a, ...b,
    ...Object.fromEntries(['documents_new','documents_known','types_new','types_known','images_new','images_known'].map(k => [k,(a[k] || 0)+(b[k] || 0)])),
    images_skipped:[...(a.images_skipped || []),...(b.images_skipped || [])] });
  if (bytes > 96 * 1024 * 1024 && docs.length > 1) {
    if (types.length) {
      // Type pages must arrive with their types. Otherwise the importer makes
      // generic pages before the real overview documents reach it.
      const required = new Set(types.map(t => t.page).filter(Boolean));
      const pages = docs.filter(d => required.has(d.id));
      const rest = docs.filter(d => !required.has(d.id));
      if (rest.length) return combine(await send(pages, types), await send(rest));
    }
    const middle = Math.ceil(docs.length/2);
    const a = await send(docs.slice(0,middle), types), b = await send(docs.slice(middle));
    return combine(a,b);
  }
  if (bytes > 180 * 1024 * 1024) throw new Error(tr('Ein Dokument ist für eine Übertragung zu groß.', 'One document is too large for a transfer.'));
  const pkg = { format:'aw-package', version:1, name:'DiceFox · D&D Beyond', written:true, types, documents:packed.docs, images:packed.images };
  if(stopped)throw Error(tr("Übertragung angehalten.","Transfer stopped."));
  contract.assertCurrent(await DiceFoxAW.types(WORLD));
  const result = await DiceFoxAW.send(WORLD, pkg, packed.files);
  if (packed.missing) log(tr(`${packed.missing} Bilder nicht verfügbar.`, `${packed.missing} images unavailable.`));
  if (result.images_skipped?.length) {
    result.images_new = Math.max(0, (result.images_new || 0)-result.images_skipped.length);
    log(tr('Von der App nicht lesbare Bilder: ', 'Images the app could not read: ') + result.images_skipped.join(', '));
  }
  return result;
}


async function run(){
 if(busySending||!permitted())return;
 busySending=true;stopped=false;$('go').disabled=true;$('stop').hidden=false;$('stop').disabled=false;$('worldSelect').disabled=true;$('refreshWorlds').disabled=true;
 renderSelection();
 const totals={new:0,known:0,images:0,failed:0};
 const count=s=>{totals.new+=s.documents_new||0;totals.known+=s.documents_known||0;totals.images+=s.images_new||0;};
 try{
  contract.assertCurrent(await DiceFoxAW.types(WORLD));
  if(!didCapture && !await capture()){
   if(!stopped){state(tr('Auswahl prüfen','Review selection'),'wait');$('progress').textContent=tr('Die Erfassung ist unvollständig. Prüfe die Auswahl und entscheide ausdrücklich, ob die verfügbaren Inhalte importiert werden sollen.','Capture is incomplete. Review the selection and explicitly decide whether to import available content.');}
   return;
  }
  if(stopped)return;
  // Recreate converters for the selection, so links do not point to deselected
  // entries. Rules remain explicit dependencies. Repeated sends retain IDs.
  const pickedIndex=lib.index.filter(e=>selected.has(String(e.i))||e.s==='rules-glossary');
  const bookIds=new Set(chosen.filter(s=>s.kind==='book-chapter').map(s=>s.e.book));
  const pickedBooks=lib.books.filter(b=>bookIds.has(b.id));
  bookConv=AWBooks.create({entries:pickedIndex,books:pickedBooks,types:contract.conversionTypes,parse,resolveRule:(href,text)=>conv?.resolve(href,text)});
  conv=AWDndBeyond.create({entries:pickedIndex,glossary:SCOPE==='library'?lib.glossary:[],types:contract.conversionTypes,owned:lib.ownedBooks||lib.books.map(b=>b.name),selectedUrls:pickedIndex.filter(e=>e.has).map(e=>e.u),parse,resolveExtra:bookConv.resolve});
  const steps=[...conv.steps,...bookConv.steps];
  valueDocs.clear();for(const[url,pic]of pictures)if(!pic)pictures.delete(url);
  state(tr('importiert …','importing …'),'wait');
  const icons=steps.filter(s=>['spells','feats','backgrounds','equipment'].includes(s.kind)).map(s=>s.e.i),htmlById=new Map();
  for(let i=0;i<icons.length&&!stopped;i+=400){const ids=icons.slice(i,i+400);(await ask({type:'AW_HTML',profileId,token:lib.token,indexes:ids})).html.forEach((h,k)=>htmlById.set(ids[k],h));}
  conv.countIcons(e=>htmlById.get(e.i)||'');
  if(stopped)return;
  for(const d of conv.take())valueDocs.set(d.id,d);
  const first=[...new Map([...valueDocs.values(),...bookConv.roots(),...conv.rules,...overviewDocs].map(d=>[d.id,d])).values()];
  const newTypes=extraTypes.map(t=>({...t,blocks:(t.blocks||[]).map(b=>({...b,parts:(b.parts||[]).map(p=>({...p,text:contract.rewrite(p.text||'',t.id)}))}))}));
  if(conv.missing.size)throw Error(tr('Nicht zugeordnete Felder: ','Unmapped fields: ')+[...conv.missing].join(', '));
  count(await send(first,newTypes));
  log(tr(`Grundlagen: ${first.length} Dokumente, ${extraTypes.length} neue Typen.`,`Basics: ${first.length} documents, ${extraTypes.length} new types.`));
  for(let i=0;i<steps.length&&!stopped;i+=BATCH){
   const batch=steps.slice(i,i+BATCH);progress(i,steps.length,`${i.toLocaleString('en')} / ${steps.length.toLocaleString('en')}`);
   const html=(await ask({type:'AW_HTML',profileId,token:lib.token,indexes:batch.map(s=>s.e.i)})).html;
   const docs=[];
   for(let k=0;k<batch.length;k++){
    const step=batch[k];try{docs.push(...(step.kind==='book-chapter'?bookConv:conv).build(step,html[k]));}
    catch(err){totals.failed++;throw Error(`${step.name}: ${err.message||err}`);}
   }
   if(conv.missing.size)throw Error(tr('Nicht zugeordnete Felder: ','Unmapped fields: ')+[...conv.missing].join(', '));
   docs.push(...conv.take());count(await send(docs));
  }
  progress(steps.length,steps.length,'');
  const summary=tr(`${totals.new.toLocaleString('en')} neu, ${totals.known.toLocaleString('en')} bereits vorhanden, ${totals.images.toLocaleString('en')} Bilder.`,`${totals.new.toLocaleString('en')} new, ${totals.known.toLocaleString('en')} already present, ${totals.images.toLocaleString('en')} pictures.`);
  $('progress').textContent=(stopped?tr('Angehalten. ','Stopped. '):'')+summary;log(summary);
  state(stopped?tr('angehalten','stopped'):tr('fertig','done'),stopped?'':'on');
 }catch(err){
  if(!stopped){fail(err);contract=null;}
  $('progress').textContent=tr(`${totals.new} neue und ${totals.known} bekannte Dokumente bestätigt. Erneutes Senden verwendet dieselben IDs.`,`${totals.new} new and ${totals.known} known documents confirmed. Resending uses the same IDs.`);
 }finally{
  busySending=false;$('stop').hidden=true;$('worldSelect').disabled=false;$('refreshWorlds').disabled=false;
  if(stopped){state(tr('angehalten','stopped'));$('progress').textContent=tr(`Angehalten. ${totals.new} neue und ${totals.known} bekannte Dokumente bestätigt.`,`Stopped. ${totals.new} new and ${totals.known} known documents confirmed.`);}
  if(lib&&contract?.ok)makeConverters();
  renderSelection();updateGo();
 }
}
$('go').onclick=run;
$('stop').onclick=async()=>{
 stopped=true;$('stop').disabled=true;
 if(!didCapture){try{const{state:s}=await ask({type:'GET_STATE'});if(s.exportId===exportId&&s.running)await ask({type:'STOP'});}catch(err){log(err.message);}}
};
$('worldSelect').onchange=()=>{WORLD=$('worldSelect').value;$('allowPartial').checked=false;prepare().catch(fail);};
$('refreshWorlds').onclick=()=>connect().catch(fail);
$('selectionSearch').oninput=renderSelection;
$('selectAll').onclick=()=>{if(busySending)return;selected=new Set(selectionRows.filter(r=>!r.children).map(r=>r.key));refreshSelection();};
$('selectNone').onclick=()=>{if(busySending)return;selected.clear();refreshSelection();};
$('allowPartial').onchange=updateGo;
$('retryCapture').onclick=()=>{if(busySending)return;didCapture=false;capturePartial=false;selectionReady=false;$('allowPartial').checked=false;$('go').textContent=tr('Erfassen und importieren','Capture and import');prepare().catch(fail);};
window.addEventListener('message',event=>{if(embedded&&event.origin===location.origin&&event.source===window.parent&&event.data?.type==='DICEFOX_CANCEL'&&event.data.draftId===q.get('draft'))$('stop').onclick();});
const heartbeat=setInterval(()=>ask({type:'GET_STATE'}).catch(()=>{}),15000);
const connectionPoll=setInterval(()=>{if(connectionReady&&!busySending&&($('worldField').hidden||!worlds.length))connect().catch(fail);},2500);
window.addEventListener('pagehide',()=>{clearInterval(heartbeat);clearInterval(connectionPoll);});
(async()=>{
 if(q.get('draft')){
  const key='dicefox:export-draft:'+q.get('draft'),draft=(await chrome.storage.local.get(key))[key];
  if(!draft||Date.now()-draft.createdAt>24*60*60*1000)throw Error(tr('Die Auswahl ist abgelaufen. Schließe den Dialog und wähle erneut Exportieren.','The selection expired. Close this dialog and choose Export again.'));
  profileId=draft.profileId;sourceIds.splice(0,sourceIds.length,...draft.sourceIds);targets.splice(0,targets.length,...draft.targets);wholeSourceIds.splice(0,wholeSourceIds.length,...draft.wholeSourceIds);
  fresh=true;didCapture=false;$('go').textContent=tr('Jetzt exportieren','Export now');
 }
 if(!profileId)profileId=(await chrome.storage.local.get('lwl_active_profile_v2')).lwl_active_profile_v2||'';
 [template,pages]=await Promise.all(['aw/dnd5e-types.json','aw/dnd5e-pages.json'].map(async path=>(await fetch(chrome.runtime.getURL(path))).json()));
 if(fresh)plan=await ask({type:'AW_EXPORT_PLAN',profileId,sourceIds,targets,wholeSourceIds});
 await connect();connectionReady=true;
})().catch(fail);
