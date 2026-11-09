/* Offscreen DOM conversion and app delivery. One record is in flight; bodies,
   packages and image bytes are never written to extension storage. */
(() => {
  'use strict';
  let session=null;
  const parser=new DOMParser();
  const parse=html=>parser.parseFromString('<!doctype html><body>'+html,'text/html');
  const imageExtensions={'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/svg+xml':'svg','image/avif':'avif'};
  function alive(){if(!session||session.cancelled)throw Error('Export paused.');return session;}
  async function open({world,kinds,refresh=false,site={}}){
    session={world,kinds,refresh,site:{origin:site.origin,aliases:site.aliases||{},layout:site.layout||{}},cancelled:false,abort:new AbortController()};
    const s=session;
    await DiceFoxAW.status();
    const worlds=await DiceFoxAW.worlds();
    if(!worlds.some(w=>w.key===world))throw Error('Choose an available GM world again.');
    const [template,pages,live]=await Promise.all([
      ...['dnd5e-types','dnd5e-pages'].map(name=>fetch(chrome.runtime.getURL('aw/'+name+'.json')).then(r=>{if(!r.ok)throw Error('Cannot load DiceFox templates.');return r.json();})),
      DiceFoxAW.types(world),
    ]);
    s.contract=AWTemplates.prepare(live,template,AWTemplates.required(kinds),AWTemplates.visible(kinds));
    if(!s.contract.ok)throw Error('Template check failed: '+s.contract.errors.map(e=>`${e.type}${e.field?' / '+e.field:''}: ${e.reason}`).join('; '));
    s.overviews=[];
    for(const type of s.contract.missing){
      const page=pages.find(p=>p.type===type.id);if(!page)continue;
      type.page=AWIds.articleId('dicefox-overview',type.id);
      s.overviews.push({id:type.page,type:'',_overviewFor:type.id,slug:type.id+'-page',name:page.name,view:'all',edit:'gm',fields:{},parts:[{section:'list',title:'',text:s.contract.overview(page.text),fields:{},view:'all',edit:'gm'}]});
    }
    alive();return {ok:true,compatible:s.contract.compatible.length,missing:s.contract.missing.map(t=>t.name)};
  }
  /* A document's pictures, fetched one by one. No limit on their size or
     number: where they grow past BATCH, those so far go ahead in a package
     of their own and leave memory — one request to the app stays well within
     what it reads at once, and within what it hands on to a world's server
     in one message (64 MB, the pictures there as base64). The app names a
     picture by its bytes, so the document finds it there. */
  const BATCH=24*1024*1024;
  async function pictures(docs,ahead){
    const s=alive(),images=new Map(),cache=new Map();let files={},bytes=0,missing=0;
    const picture=async url=>{
      if(cache.has(url))return cache.get(url);
      alive();let made=null;
      const controller=new AbortController(),abort=()=>controller.abort(),timer=setTimeout(abort,20000);
      s.abort.signal.addEventListener('abort',abort,{once:true});
      try{
        const response=await fetch(url,{credentials:'omit',signal:controller.signal});
        if(response.ok){
          const blob=await response.blob();
          if(bytes&&bytes+blob.size>BATCH){
            await ahead([...images.values()].filter(i=>files[i.file]),files);
            for(const sent of cache.values())if(sent&&files[sent.file])sent.data=null;
            files={};bytes=0;
          }
          if(blob.size){
            const data=new Uint8Array(await blob.arrayBuffer()),id=AWIds.imageId(data);
            const ext=imageExtensions[blob.type.split(';')[0]]||'img';let binary='';
            for(let i=0;i<data.length;i+=0x8000)binary+=String.fromCharCode.apply(null,data.subarray(i,i+0x8000));
            made={id,file:`images/${id.slice(4)}.${ext}`,data:btoa(binary)};bytes+=blob.size;
          }
        }
      }catch(error){if(/Export paused|^App:/.test(error.message))throw error;}
      finally{clearTimeout(timer);s.abort.signal.removeEventListener('abort',abort);}
      alive();cache.set(url,made);return made;
    };
    const remember=(pic,name)=>{images.set(pic.id,{id:pic.id,file:pic.file,name});if(pic.data)files[pic.file]=pic.data;};
    docs=docs.map(doc=>({...doc,parts:doc.parts.map(p=>({...p,fields:{...p.fields}}))}));
    for(const doc of docs){
      for(const part of doc.parts)for(const [key,value]of Object.entries(part.fields)){
        if(!value?.image||typeof value!=='object')continue;
        const pic=await picture(value.image);
        if(pic){part.fields[key]=pic.id;remember(pic,value.name);}else{delete part.fields[key];missing++;}
      }
      for(const request of doc._images||[]){
        const pic=await picture(request.url),replacement=pic?`<image src=${pic.id}>`:'*Image unavailable.*';
        for(const part of doc.parts)part.text=part.text.replaceAll(`<image src=${request.token}>`,replacement).replaceAll(`<image src="${request.token}">`,replacement);
        if(pic)remember(pic,request.name);else missing++;
      }
      delete doc._images;
    }
    return {docs,images:[...images.values()],files,missing};
  }
  async function send(docs,types=[]){
    const s=alive();
    if(s.conv?.missing.size)throw Error('Unmapped fields: '+[...s.conv.missing].join(', '));
    // Pictures sent ahead: what they added counts with the document.
    const early={images_new:0,images_skipped:[]};
    const ahead=async(images,files)=>{
      const r=await DiceFoxAW.send(s.world,{format:'aw-package',version:1,name:'DiceFox · D&D Beyond',written:true,types:[],documents:[],images},files,{signal:s.abort.signal}).catch(e=>{throw Error('App: '+(e.message||e));});
      early.images_new+=r.images_new||0;early.images_skipped.push(...(r.images_skipped||[]));alive();
    };
    const packed=await pictures(docs.map(d=>s.contract.document(d)),ahead);
    s.contract.assertCurrent(await DiceFoxAW.types(s.world));alive();
    // Imported content: read again, it replaces what the world holds of it.
    const result=await DiceFoxAW.send(s.world,{format:'aw-package',version:1,name:'DiceFox · D&D Beyond',source:'D&D Beyond',update:!!s.refresh,written:true,types,documents:packed.docs,images:packed.images},packed.files,{signal:s.abort.signal});
    result.images_new=(result.images_new||0)+early.images_new;result.images_known=Math.max(0,(result.images_known||0)-early.images_new);
    result.images_skipped=[...(result.images_skipped||[]),...early.images_skipped];
    // An acknowledged transfer stays acknowledged even if Pause was clicked
    // just as its reply arrived. The worker checkpoints it before stopping.
    return {ok:true,result,missingImages:packed.missing+(result.images_skipped?.length||0)};
  }
  function books(entries,roots){
    const s=alive();
    return AWBooks.create({entries,books:roots,types:s.contract.conversionTypes,parse,streaming:true,inlineRoot:true,site:s.site,tidy:AWDndBeyond.tidy,resolveRule:(href,text)=>s.conv?.resolve(href,text),
      embed:url=>{const id=AWIds.articleId(s.site.layout.creatureKind,url);return s.embeddable?.has(id)?id:null;}});
  }
  const pageUrl=href=>{const u=new URL(href,alive().site.origin);u.hash='';u.search='';return u.href.replace(/\/+$/,'');};
  /* The creatures a chapter's stat blocks name that will be there: sent in
     this export, in a whole list still to be read, or in the world already.
     Only those are drawn in; any other stays the chapter's own text. */
  async function embeddable(html){
    const s=alive(),ids=new Set(),{creature,creatureKind:kind}=s.site.layout;
    if(!creature||!kind){s.embeddable=ids;return;}
    for(const a of parse(html).querySelectorAll(creature)){try{ids.add(AWIds.articleId(kind,pageUrl(a.getAttribute('data-lwl-href')||a.getAttribute('href'))));}catch{/* not an address */}}
    const coming=(s.whole||[]).includes(kind)&&(s.pending||[]).includes(kind);
    const sent=new Set(s.entries.filter(e=>e.s===kind).map(e=>AWIds.articleId(kind,pageUrl(e.u))));
    const ask=[...ids].filter(id=>!coming&&!sent.has(id));
    const held=ask.length?await DiceFoxAW.known(s.world,ask):[];alive();
    s.embeddable=new Set([...ids].filter(id=>coming||sent.has(id)||held.includes(id)));
  }
  /* Called again with each list read: the converter is rebuilt with every
     entry known so far. `pending` are the kinds whose lists are still to
     come; `extend` sends only what the new entries add. */
  async function index({entries,bookRoots,glossary,bindings,pending=[],whole=[],extend=false}){
    const s=alive();s.bookRoots=bookRoots;s.entries=entries;s.pending=pending;s.whole=whole;s.books=books(entries,bookRoots);
    s.conv=entries.some(e=>AWDndBeyond.KINDS.includes(e.s))||glossary.length||pending.length?AWDndBeyond.create({entries,glossary,types:s.contract.conversionTypes,bookNames:bookRoots.map(b=>b.name),selectedUrls:entries.map(e=>e.u),parse,bindings,pending,resolveExtra:(href,text)=>s.books.resolve(href,text),keep:AWBooks.layoutOf(s.site?.layout).keptStatBlock}):null;
    s.steps=new Map([...(s.conv?.steps||[]),...s.books.steps].map(step=>[step.e.i,step]));
    if(extend){const docs=s.conv?.take()||[];return docs.length?send(docs):{ok:true,result:{}};}
    const types=[...s.contract.missing,...s.contract.updates].map(t=>({...t,blocks:(t.blocks||[]).map(b=>({...b,parts:(b.parts||[]).map(p=>({...p,text:s.contract.rewrite(p.text||'',t.id)}))}))}));
    return send([...s.overviews,...(s.conv?.rules||[]),...(s.conv?.take()||[])],types);
  }
  async function record({entry,html,bookEntries}){
    const s=alive();
    let step=s.steps.get(entry.i);
    if(entry.book){
      await embeddable(html);
      s.books=books(bookEntries,s.bookRoots);
      step=s.books.steps.find(item=>item.e.i===entry.i);
    }else if(step){
      if(step.e.titlePending){
        const title=String(entry.t||'').replace(/\s+/g,' ').trim();
        step.name=step.kind==='classes'?title.replace(/\s*(Legacy.*|Class Details)$/,'').replace(' Class Details','').trim()+(/\bLegacy\b/.test(title)?' (Legacy)':''):title.replace(/^[“”"]+|[“”"]+$/g,'');
      }
      Object.assign(step.e,entry);
    }
    if(!step)throw Error('This entry has no converter: '+entry.u);
    if(!html?.trim())throw Error('No readable content: '+entry.t);
    const docs=(entry.book?s.books:s.conv).build(step,html);docs.push(...(s.conv?.take()||[]));
    const result=await send(docs);return {...result,bindings:s.conv?.checkpoint()||{}};
  }
  /* The entries whose document the world holds already: ids are made from
     addresses, so nothing needs to be read to know them. Classes are always
     read — what they bind the subclasses to comes from reading them. */
  async function existing({indexes}){
    const s=alive(),ids=new Map();
    for(const i of indexes){
      const step=s.steps.get(i)||s.books.steps.find(item=>item.e.i===i);
      if(!step||step.kind==='classes')continue;
      ids.set(step.id||AWIds.articleId(step.kind,step.e.u),i);
    }
    if(!ids.size)return {ok:true,indexes:[]};
    const held=await DiceFoxAW.known(s.world,[...ids.keys()]);alive();
    return {ok:true,indexes:held.map(id=>ids.get(id)).filter(i=>i!=null)};
  }
  async function finish({entries,bookRoots}){
    if(!bookRoots.length)return {ok:true,result:{}};
    const docs=books(entries,bookRoots).roots();
    return docs.length?send(docs):{ok:true,result:{}};
  }
  function cancel(){if(session){session.cancelled=true;session.abort.abort(Error('Export paused.'));}}
  function drop(){cancel();session=null;}
  globalThis.AWLive=Object.freeze({open,index,existing,record,finish,cancel,drop});
})();
