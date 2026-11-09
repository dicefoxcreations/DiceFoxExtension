/* Shared worker module; loaded by background.js. */
function scopedLibraryData(all){
 const sourceData={},urls=new Set();
 for(const source of profile.sources){
  const raw=all[sourceKey(source.id)];
  if(!raw){sourceData[source.id]=null;continue;}
  const meta={...raw};
  if(source.type==='catalog')meta.mode='content';
  if(Array.isArray(meta.items))meta.items=meta.items.filter(item=>LWLProviders.allows(profile,source,item.url));
  if(Array.isArray(meta.pages))meta.pages=meta.pages.filter(page=>LWLProviders.allows(profile,source,page.url));
  for(const item of meta.items||[])urls.add(canonical(item.url));
  sourceData[source.id]=meta;
 }
 const pages=Object.entries(all).filter(([k])=>k.startsWith(`${prefix()}page:`)).map(([,v])=>v).filter(p=>p&&(!profile.provider||profile.sources.some(s=>(s.id===p.sourceId||p.sourceIds?.includes(s.id))&&LWLProviders.allows(profile,s,p.url))));
 const byUrl=new Map();
 for(const kind of ['preview','detail'])for(const [key,record] of Object.entries(all))if(key.startsWith(`${prefix()}${kind}:`)&&record&&(!profile.provider||urls.has(canonical(record.url)))){
  const url=canonical(record.url),previous=byUrl.get(url);
  byUrl.set(url,{...previous,...record,catalogPreviews:{...previous?.catalogPreviews,...record.catalogPreviews}});
 }
 const details=[...byUrl.values()];
 return {sourceData,pages,details};
}
function readerGroupFor(source){
 if(source.readerGroup)return source.readerGroup;
 if(source.type==="collection")return "library";
 if(source.type==="catalog"||source.type==="glossary")return "compendium";
 return "sections";
}

function readerId(sourceId,url){return safeId(`${sourceId}\u0000${canonical(url)}`);}
function pageToRecord(p,sourceId,order){
 return {
  id:readerId(sourceId,p.url),url:p.url,sourceId,aliases:[p.requestedUrl].filter(Boolean),
  styleId:p.styleId,presentation:p.presentation,theme:p.theme,captureWarnings:p.captureWarnings||[],glossaryEntries:p.glossaryEntries||[],
  title:LWLPresentation.chooseTitle([p.title],"Untitled document"),
  html:p.html||"",
  captureStatus:p.sourceType==='collection'&&p.contentBoundaryVersion!==2?'incomplete':null,
  text:String(p.markdown||"").replace(/[#*_`>|-]/g," "),
  meta:p.detailMeta||{},links:p.links||[],
  order
 };
}

/* Collects everything the reader needs: one reader-source per catalog and one
   per work inside a collection, so each work appears individually. */
async function collectReaderModel(all=null,{lazyStyles=false}={}){
 all ||= await readerData({captureStyles:!lazyStyles});
 const {pages,sourceData}=scopedLibraryData(all);
 const records=[],readerSources=[];
 for(const s of (profile.sources||[])){
  const meta=sourceData[s.id];
  const group=readerGroupFor(s);
  if(meta?.mode==="content" || (s.type==="catalog" && Array.isArray(meta?.items))){
   readerSources.push({id:s.id,name:s.name,url:s.startUrl,type:s.type,layout:"list",group,filterDefinitions:meta.filters||[],exactFilters:meta.exactFilters||[],complete:meta.complete,catalog:meta.catalog||null,articleLayout:all[stylesKey(s.id)]?.articleLayout||null,siteCss:all[stylesKey(s.id)]?.css||null,siteTheme:all[stylesKey(s.id)]?.theme||null});
   // Old profiles may have stored list rows and page records separately.
   // Keep both usable locally while a new sync fills in any missing details.
   const savedPages=new Map(pages.filter(p=>p.sourceId===s.id||p.sourceIds?.includes(s.id)).flatMap(p=>[p.url,p.requestedUrl].filter(Boolean).map(url=>[canonical(url),p])));
   for(const [itemIndex,item] of (meta.items||[]).entries()){
    const url=canonical(item.url);
    const savedPage=savedPages.get(url);
    const captured=all[detailKey(url)] || (savedPage ? pageToRecord(savedPage,s.id,itemIndex) : null);
    // Older captures may have followed a redirect outside the provider scope.
    // Keep their raw backup, but never present that unrelated page as this item.
    const rec=captured&&LWLProviders.allows(profile,s,captured.url)?captured:null;
    const captureStatus=captured&&!rec?'unavailable':item.captureStatus||null;
    /* Both sides carry metadata and neither is redundant: the item row holds
       what the site's own filters answered, the detail record what its page
       printed. Merging keeps the exact filters, which the record does not have. */
    const preview=rec?.catalogPreviews?.[s.id]||all[previewKey(url)]?.catalogPreviews?.[s.id];
    const merged={...(item.meta||{}),...(rec?.meta||{}),...(preview?.meta||{}),...(item.filterNumbers||{})};
    records.push(rec
     ? {id:readerId(s.id,url),url,aliases:[rec.url,rec.requestedUrl,...(rec.aliases||[])].filter(Boolean),sourceId:s.id,title:rec.title||item.title,html:rec.html||'',text:rec.text,meta:merged,links:rec.links||[],captureStatus,rowGroup:item.rowGroup||0,rowHtml:item.rowHtml,panelHtml:preview?.html||item.panelHtml,order:itemIndex,filterValues:item.filterValues||{},styleId:rec.styleId,presentation:rec.presentation,theme:rec.theme,captureWarnings:rec.captureWarnings||[]}
     : {id:readerId(s.id,url),url,sourceId:s.id,title:item.title||url,html:"",text:item.summaryText||"",meta:merged,captureStatus,rowGroup:item.rowGroup||0,rowHtml:item.rowHtml,panelHtml:preview?.html||item.panelHtml,order:itemIndex,filterValues:item.filterValues||{}});
   }
   continue;
  }
  const own=pages.filter(p=>p.sourceId===s.id||p.sourceIds?.includes(s.id)).map(p=>({...p,...(p.contexts?.[s.id]||{}),title:p.title||p.contexts?.[s.id]?.title}));
  if(s.type==="collection"){
   const books=new Map();
   for(const p of own){
    const bid=p.collectionId||s.id;
    if(!books.has(bid))books.set(bid,{id:`${s.id}--${bid}`,name:p.collectionTitle||s.name,pages:[]});
    books.get(bid).pages.push(p);
   }
   for(const b of books.values()){
    b.pages.sort((x,y)=>(x.navIndex??9999)-(y.navIndex??9999));
    const first=b.pages[0],bid=first.collectionId||s.id;
    const matched=(meta?.items||[]).filter(item=>item.targetId===bid||canonical(item.url)===canonical(first.requestedUrl||first.url));
    b.name=LWLPresentation.chooseTitle([b.name,...matched.map(item=>item.title),first.title],s.name);
    b.cover=matched.find(item=>item.cover)?.cover||b.pages.find(p=>p.collectionCover)?.collectionCover||null;
    b.url=matched[0]?.url||first.requestedUrl||first.url;
   }
   for(const b of [...books.values()].sort((x,y)=>String(x.name).localeCompare(String(y.name)))){
    readerSources.push({id:b.id,name:b.name,url:b.url,cover:b.cover,type:"book",layout:"book",group,captureSourceId:s.id});
    b.pages.forEach((p,i)=>records.push(pageToRecord(p,b.id,p.navIndex??i)));
   }
   continue;
  }
  if(!own.length&&!meta)continue;
  const layout=(s.type==="section")?"book":"list";
  readerSources.push({id:s.id,name:s.name,url:s.startUrl,type:s.type,layout,group});
  own.sort((x,y)=>(x.navIndex??9999)-(y.navIndex??9999));
  own.forEach((p,i)=>records.push(pageToRecord(p,s.id,p.navIndex??i)));
 }
 const used=new Set(records.map(r=>r.sourceId));
 for(const r of records)r.siteCss=r.styleId?all[stylesKey(`capture-${r.styleId}`)]?.css||null:null;
 return {records,readerSources:readerSources.filter(s=>used.has(s.id))};
}
