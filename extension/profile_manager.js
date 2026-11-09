(() => {
  "use strict";
  const PROFILE_LIST_KEY = "lwl_profiles_v2";
  const ACTIVE_KEY = "lwl_active_profile_v2";
  const SOURCE_TYPES = new Set(["collection","catalog","glossary","section"]);
  function clone(x){ return JSON.parse(JSON.stringify(x)); }
  function sourceId(src, i=0){
    return String(src?.id || src?.name || `source-${i+1}`).toLowerCase().normalize("NFKD").replace(/[^a-z0-9_-]+/g,"-").replace(/^-+|-+$/g,"") || `source-${i+1}`;
  }
  const READER_GROUPS = new Set(["library","compendium","sections"]);
  const str = (v,max=400) => { const s=String(v==null?"":v).trim(); return s?s.slice(0,max):null; };
  const strList = (v,max=400,cap=40) => (Array.isArray(v)?v:[]).map(x=>str(x,max)).filter(Boolean).slice(0,cap);
  /* Field extractors stay declarative: a key, a CSS selector and at most an
     attribute name. No code, no expressions. */
  function metaFieldList(v){
    return (Array.isArray(v)?v:[]).map(f=>{
      const key=str(f?.key,32), selector=str(f?.selector,400);
      if(!key||!selector)return null;
      return {key:key.toLowerCase().replace(/[^a-z0-9_-]+/g,"-"),selector,attr:str(f?.attr,64),multiple:Boolean(f?.multiple),...(f?.presence?{presence:true}:{}),...(f?.defaultValue!=null?{defaultValue:String(f.defaultValue)}:{})};
    }).filter(Boolean).slice(0,24);
  }
  function normalizeSource(src, i=0, origin="") {
    const type = SOURCE_TYPES.has(src?.type) ? src.type : "section";
    let startUrl = src?.startUrl || "/";
    try { startUrl = new URL(startUrl, origin).href; } catch {}
    return {
      id: sourceId(src,i),
      name: String(src?.name || `Source ${i+1}`),
      type,
      startUrl,
      providerId: str(src?.providerId,80),
      providerSource: str(src?.providerSource,80),
      enabledByDefault: src?.enabledByDefault !== false,
      dependencies: Array.isArray(src?.dependencies) ? [...new Set(src.dependencies.map(String))] : [],
      contentSelector: src?.contentSelector || "main, article, [role='main'], body",
      excludeSelectors: Array.isArray(src?.excludeSelectors) ? src.excludeSelectors : ["script","noscript","template"],
      discoveryMode: src?.discoveryMode === "auto" ? "auto" : "configured",
      itemLinkSelector: src?.itemLinkSelector || null,
      itemContainerSelector: src?.itemContainerSelector || null,
      itemTitleSelector: str(src?.itemTitleSelector,8000),
      itemCoverSelector: str(src?.itemCoverSelector,8000),
      itemUrlPatterns: Array.isArray(src?.itemUrlPatterns) ? src.itemUrlPatterns : [],
      itemExcludePatterns: Array.isArray(src?.itemExcludePatterns) ? src.itemExcludePatterns : [],
      navigationSelector: src?.navigationSelector || null,
      navigationScope: src?.navigationScope || (type === "collection" ? "itemPrefix" : null),
      pageUrlPatterns: Array.isArray(src?.pageUrlPatterns) ? src.pageUrlPatterns : [],
      pageExcludePatterns: Array.isArray(src?.pageExcludePatterns) ? src.pageExcludePatterns : [],
      pagination: src?.pagination || { mode: "auto" },
      filters: Array.isArray(src?.filters) ? src.filters : [],
      /* form names of the site's own filter controls to resolve exactly */
      facetFilters: Array.isArray(src?.facetFilters) ? src.facetFilters.map(String) : [],
      ...(Array.isArray(src?.numericFilters)?{numericFilters:src.numericFilters.slice(0,10).map(f=>({field:str(f.field),minName:str(f.minName),maxName:str(f.maxName),minSelector:str(f.minSelector),maxSelector:str(f.maxSelector),min:Number.isSafeInteger(f.min)?f.min:0,initialMax:Number.isSafeInteger(f.initialMax)?f.initialMax:128})).filter(f=>f.field&&f.minName&&f.maxName&&f.minSelector&&f.maxSelector&&f.initialMax>=f.min)}:{}),
      followDepth: Number.isFinite(src?.followDepth) ? Math.max(0, Math.min(8, src.followDepth)) : (type === "section" ? 2 : 1),
      maxItems: Number.isFinite(src?.maxItems) ? Math.max(1, src.maxItems) : 5000,
      catalogMode: "content",
      expandCards: src?.expandCards !== false,
      expandSelector: str(src?.expandSelector),
      expandLimit: Number.isFinite(src?.expandLimit) ? Math.max(1, Math.min(2000, src.expandLimit)) : null,
      detailSelector: str(src?.detailSelector,8000),
      detailTitleSelector: str(src?.detailTitleSelector,8000),
      previewSelector: str(src?.previewSelector,8000),
      relatedLinkSelector: str(src?.relatedLinkSelector,8000),
      relatedUrlPatterns: strList(src?.relatedUrlPatterns,8000),
      contentBoundaryVersion: Number(src?.contentBoundaryVersion)||null,
      captureMode: src?.captureMode === "page" ? "page" : "article",
      pageSelector: str(src?.pageSelector),
      detailPageSelector: str(src?.detailPageSelector),
      catalogView: normalizeCatalogView(src?.catalogView),
      navigationToggles: (Array.isArray(src?.navigationToggles)?src.navigationToggles:[]).slice(0,20).map(x=>({selector:str(x?.selector),container:str(x?.container),className:str(x?.className,100),expandedClassName:str(x?.expandedClassName,100)})).filter(x=>x.selector&&x.container&&x.className&&/^[a-zA-Z_][\w-]*$/.test(x.className)),
      detailExcludeSelectors: strList(src?.detailExcludeSelectors,8000),
      detailExpandSelector: str(src?.detailExpandSelector),
      detailFilters: Array.isArray(src?.detailFilters) ? src.detailFilters : [],
      keepPattern: str(src?.keepPattern, 200),
      cardMetaFields: metaFieldList(src?.cardMetaFields),
      metaFields: metaFieldList(src?.metaFields),
      readerGroup: READER_GROUPS.has(src?.readerGroup) ? src.readerGroup : null,
      detailPages: type === "catalog" ? false : src?.detailPages !== false,
      glossary: src?.glossary || null,
      availability: src?.availability || null,
      notes: src?.notes || null
    };
  }
  function normalizeCatalogView(raw){
    if(!raw||typeof raw!=="object")return null;
    const out={};
    for(const key of ['previewUrlTemplate','filterTransport','rowsTransport','emptySelector','listSelector','rowSelector','rowStateSelector','panelPlacement','groupSelector','groupTriggerSelector','groupContentSelector','groupClosedClass','groupHeaderClosedClass','searchMode','resetHiddenClass','controlsSelector','searchSelector','resetSelector','submitSelector','paginationSelector','rowToggleSelector','expandedRowSelector','rowExpandedClass','indicatorOpenClass','indicatorClosedClass','advancedToggleSelector','advancedPanelSelector','advancedHiddenClass','advancedOpenClass','advancedOpenLabel','advancedClosedLabel','sortSelector'])if(str(raw[key]))out[key]=str(raw[key],8000);
    out.styleKeepPatterns=strList(raw.styleKeepPatterns);
    out.sortFields=raw.sortFields&&typeof raw.sortFields==="object"?Object.fromEntries(Object.entries(raw.sortFields).slice(0,30).map(([k,v])=>[k,String(v)])):{};
    out.filterBindings=(Array.isArray(raw.filterBindings)?raw.filterBindings:[]).slice(0,30).map(b=>({name:str(b.name),field:str(b.field),...(b.capture===false?{capture:false}:{}),fallbackFields:strList(b.fallbackFields),operator:['gte','lte'].includes(b.operator)?b.operator:'eq',emptyValues:strList(b.emptyValues),selectedClass:str(b.selectedClass),choiceSelector:str(b.choiceSelector),values:b.values&&typeof b.values==='object'?Object.fromEntries(Object.entries(b.values).slice(0,200).map(([k,v])=>[k,String(v)])):null})).filter(b=>b.name&&b.field);
    if(Array.isArray(raw.cycleControls))out.cycleControls=raw.cycleControls.slice(0,30).map(c=>({selector:str(c.selector,8000),name:str(c.name),values:Array.isArray(c.values)?c.values.slice(0,20).map(String):[],classes:c.classes&&typeof c.classes==='object'?Object.fromEntries(Object.entries(c.classes).filter(([,v])=>/^[a-zA-Z_][\w-]*$/.test(v)).map(([k,v])=>[k,String(v)])): {}})).filter(c=>c.selector&&c.name&&c.values.length>1);
    return out;
  }
  function importedProfileOrigin(raw) {
    const candidates=[raw?.origin];
    for(const s of (Array.isArray(raw?.sources)?raw.sources:[]))if(s?.startUrl)candidates.push(s.startUrl);
    for(const candidate of candidates){
      try {
        const u=new URL(String(candidate||"").trim());
        if (/^https?:$/.test(u.protocol)) return u.origin;
      } catch {}
    }
    return null;
  }
  function normalizeProfile(raw) {
    if (!raw || typeof raw !== "object") throw new Error("Profile must be a JSON object");
    if (raw.format === "local-web-library-detection-debug") throw new Error("This file is a detection debug report, not an importable LWL profile");
    const origin = importedProfileOrigin(raw);
    if (!origin) throw new Error(`Profile origin must be an http(s) origin (received: ${String(raw?.origin ?? "<missing>")})`);
    const p = {
      schemaVersion: 1,
      profileVersion: String(raw.profileVersion || "1.0.0"),
      id: String(raw.id || "").trim() || undefined,
      name: String(raw.name || new URL(origin).hostname),
      description: String(raw.description || ""),
      origin,
      provider: raw.provider?.id ? {id:str(raw.provider.id,80),version:str(raw.provider.version,80)} : null,
      referencePolicy: {previewSelector:str(raw.referencePolicy?.previewSelector,8000)},
      // How the site sets its books: the selectors the conversion reads them by.
      bookLayout: Object.fromEntries(Object.entries(raw.bookLayout && typeof raw.bookLayout === "object" ? raw.bookLayout : {}).filter(([,v])=>typeof v==="string"&&v.trim()).map(([k,v])=>[str(k,80),str(v,8000)])),
      presentationPolicy: {excludeSelectors:Array.isArray(raw.presentationPolicy?.excludeSelectors)?raw.presentationPolicy.excludeSelectors.filter(s=>typeof s==='string'&&s.trim()):[]},
      canonicalization: raw.canonicalization || {},
      skipUrlPatterns: Array.isArray(raw.skipUrlPatterns) ? raw.skipUrlPatterns : [],
      unavailableUrlPatterns: Array.isArray(raw.unavailableUrlPatterns) ? raw.unavailableUrlPatterns : [],
      sources: (Array.isArray(raw.sources) ? raw.sources : []).map((s,i)=>normalizeSource(s,i,origin)),
      metadata: raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {}
    };
    p.id = LWLUrl.profileId(p);
    if (!p.sources.length) throw new Error("Profile needs at least one source");
    const ids = new Set();
    for (const s of p.sources) {
      if (ids.has(s.id)) throw new Error(`Duplicate source id: ${s.id}`);
      ids.add(s.id);
      if (!LWLUrl.sameOrigin(s.startUrl,p)) throw new Error(`Source outside profile origin: ${s.startUrl}`);
    }
    if(p.provider)globalThis.LWLProviders?.validate(p);
    return p;
  }
  /* All catalogs now capture item content. Migrate only the retired mode flags;
     preserve the user's selectors, limits, filters and captured library. */
  async function list() {
    const all = (await chrome.storage.local.get(PROFILE_LIST_KEY))[PROFILE_LIST_KEY] || [];
    let migrated = false;
    for (const p of all) for (const s of (p?.sources || [])) {
      if (s.type === "catalog" && s.catalogMode !== "content") {
        s.catalogMode = "content";
        s.detailPages = false;
        migrated = true;
      }
    }
    if (migrated) await chrome.storage.local.set({[PROFILE_LIST_KEY]: all});
    return all;
  }
  async function save(profile) {
    const p = normalizeProfile(profile);
    const all = await list();
    const idx = all.findIndex(x=>x.id===p.id);
    if (idx >= 0) all[idx]=p; else all.push(p);
    await chrome.storage.local.set({[PROFILE_LIST_KEY]:all,[ACTIVE_KEY]:p.id});
    return p;
  }
  // Called by the worker only, after resources, records and pending writes have
  // been removed under the maintenance lock.
  async function removeDefinition(id) {
    const all=(await list()).filter(p=>p.id!==id);
    const state=await chrome.storage.local.get(ACTIVE_KEY);
    await chrome.storage.local.set({[PROFILE_LIST_KEY]:all,[ACTIVE_KEY]:state[ACTIVE_KEY]===id?(all[0]?.id||null):state[ACTIVE_KEY]});
  }
  async function remove(id) {
    const result=await chrome.runtime.sendMessage({target:"background",type:"DELETE_PROFILE",profileId:id});
    if(!result?.ok)throw new Error(result?.error||"Profile deletion failed");
    return result;
  }
  async function active() {
    const state=await chrome.storage.local.get(ACTIVE_KEY);
    const all=await list();
    return all.find(p=>p.id===state[ACTIVE_KEY]) || all[0] || null;
  }
  async function setActive(id){ await chrome.storage.local.set({[ACTIVE_KEY]:id}); }
  function hostPattern(profile){ return `${new URL(profile.origin).origin}/*`; }
  async function ensurePermission(profile) {
    const origins=[hostPattern(profile)];
    if (await chrome.permissions.contains({origins})) return true;
    return await chrome.permissions.request({origins});
  }
  function exportBlob(profile){ return new Blob([JSON.stringify(normalizeProfile(profile),null,2)],{type:"application/json;charset=utf-8"}); }
  function resolveSources(profile,ids) {
    const byId=new Map((profile.sources||[]).map(s=>[s.id,s])),wanted=new Set(),visiting=new Set(),ordered=[];
    const visit=id=>{
      if(wanted.has(id))return;
      if(visiting.has(id))throw new Error(`Cyclic source dependency: ${id}`);
      const source=byId.get(id);if(!source)throw new Error(`Missing required source: ${id}`);
      visiting.add(id);for(const dep of source.dependencies||[])visit(dep);
      visiting.delete(id);wanted.add(id);ordered.push(source);
    };
    for(const id of ids||[])if(byId.has(id))visit(id);
    return ordered;
  }
  function exportSources(profile,ids){
    const resolved=resolveSources(profile,ids);
    const content=resolved.filter(s=>s.type!=='glossary');
    return content.length&&content.every(s=>s.type==='collection')?content:resolved;
  }
  globalThis.LWLProfiles=Object.freeze({PROFILE_LIST_KEY,ACTIVE_KEY,SOURCE_TYPES,normalizeProfile,normalizeSource,importedProfileOrigin,list,save,remove,removeDefinition,active,setActive,ensurePermission,hostPattern,exportBlob,clone,resolveSources,exportSources});
})();
