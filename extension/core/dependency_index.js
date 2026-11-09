/* Shared worker module; loaded by background.js. */
async function buildIndexes(storage=null){
 // Dependency analysis needs article links and anchors, never stylesheet bodies.
 storage ||= await readerData({captureStyles:false});
 const {pages,details}=scopedLibraryData(storage);
 const manifest={format:"local-web-library-manifest",version:2,profileId:profile.id,profileName:profile.name,generatedAt:new Date().toISOString(),targets:{}};
 const {records}=await collectReaderModel(storage);
 for(const rec of records)for(const url of [rec.url,...(rec.aliases||[])]){
  const key=canonical(url);
  if(manifest.targets[key]?.available&&!rec.html)continue;
  manifest.targets[key]={title:rec.title,sourceId:rec.sourceId,readerRelativePath:`index.html#/e/${rec.id}`,available:Boolean(rec.html),anchors:[...String(rec.html||"").matchAll(/\b(?:id|name)="([^"]+)"/g)].map(m=>m[1].replace(/&amp;/g,"&").replace(/&quot;/g,'"'))};
 }
 const glossary={byTerm:{},byUrl:{},byAnchor:{}};
 const normTerm=s=>String(s||"").toLocaleLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g,"").trim();
 const addGlossaryItem=(entry,page)=>{
  const term=String(entry?.term||"").trim(),key=normTerm(term); if(!key)return null;
  const definition=String(entry?.definition||"").trim();
  const fullUrl=canonicalWithHash(entry?.url||page.url),pageUrl=canonical(page.url);
  const variant={term,definition,url:fullUrl||pageUrl};
  let item=glossary.byTerm[key];
  if(!item){
   item={term,definition,url:variant.url,pageUrl,variants:[variant]};
   glossary.byTerm[key]=item;
  }else{
   if(!Array.isArray(item.variants))item.variants=[{term:item.term,definition:item.definition||"",url:item.url||pageUrl}];
   const duplicate=item.variants.some(v=>v.url===variant.url&&String(v.definition||"")===definition);
   if(!duplicate)item.variants.push(variant);
  }
  if(fullUrl&&fullUrl.includes("#")&&!glossary.byAnchor[fullUrl])glossary.byAnchor[fullUrl]={term,definition,url:variant.url,pageUrl,variants:[variant]};
  return item;
 };
 const glossarySourceIds=new Set(profile.sources.filter(s=>s.type==='glossary').map(s=>s.id));
 for(const p of pages.filter(x=>glossarySourceIds.has(x.sourceId)||x.sourceIds?.some(id=>glossarySourceIds.has(id))||(!profile.provider&&x.sourceType==='glossary'))){
  let entries=(p.glossaryEntries||[]).map(e=>({term:e.term,definition:e.definition,url:e.url||p.url}));
  if(!entries.length&&p.markdown)entries=(p.headings||[]).filter(h=>String(h.text||"").trim().length>2).map(h=>({term:h.text,definition:"",url:h.url||p.url}));
  const pageKeys=new Set();
  for(const e of entries){const item=addGlossaryItem(e,p);if(item)pageKeys.add(normTerm(e.term));}
  const pageUrl=canonical(p.url);
  if(pageUrl&&pageKeys.size===1){const only=[...pageKeys][0];if(glossary.byTerm[only])glossary.byUrl[pageUrl]=glossary.byTerm[only];}
 }
 const linkSources=[...pages,...details].map(p=>({url:p.url,title:p.title,links:p.links}));
 const deps=[];let total=0,resolved=0;
 for(const p of linkSources)for(const l of p.links||[]){
  if(!l.url||!LWLUrl.sameOrigin(l.url,profile))continue;
  total++;const target=manifest.targets[canonical(l.url)];
  const fragment=LWLReaderModel.decode((l.url.match(/#(.*)$/)||[])[1]||"");
  const available=Boolean(target?.available),hasAnchor=!fragment||target?.anchors?.includes(fragment);
  const found=available&&hasAnchor;if(found)resolved++;
  deps.push({from:p.url,fromTitle:p.title,to:l.url,label:l.title||"",resolved:found,known:Boolean(target),reason:found?null:available?"missing-anchor":"missing-page"});
 }

 const report={format:"local-web-library-dependencies",version:1,generatedAt:new Date().toISOString(),stats:{total,resolved,unresolved:total-resolved,uniqueUnresolved:new Set(deps.filter(d=>!d.resolved).map(d=>d.to)).size},dependencies:deps};
 await chrome.storage.local.set({[manifestKey()]:manifest,[dependencyKey()]:report,[glossaryKey()]:glossary});
 return{manifest,glossary,report};}
