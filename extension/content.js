(() => {
  "use strict";
  if (globalThis.__LWL_CONTENT_V2__) return;
  globalThis.__LWL_CONTENT_V2__ = true;

  const sleep = ms => new Promise(r=>setTimeout(r,ms));
  const text = el => String(el?.textContent || "").replace(/\s+/g," ").trim();
  /* The page being read: the tab's own, or one fetched and parsed without a tab. */
  let reading=null;
  const pageDoc=()=>reading?.doc||document;
  const pageHref=()=>reading?.url||location.href;
  function pageTitle(root,source){
    let heading=selectorFirst(source?.detailTitleSelector)||root?.querySelector('h1');
    if(!heading){
      // Some documents place their title above the article region. Read that
      // heading from a cleaned page outline, so a global brand heading cannot
      // displace the document's title.
      const outline=pageDoc().body.cloneNode(true);
      for(const selector of [...(source?.excludeSelectors||[]),...(source?.detailExcludeSelectors||[])])try{outline.querySelectorAll(selector).forEach(el=>el.remove());}catch{}
      LWLPresentation.clean(outline);
      heading=outline.querySelector('h1');
    }
    return LWLPresentation.chooseTitle([text(heading),pageDoc().title],pageHref());
  }
  function preferredLinkTitle(el){
    if(!el) return "";
    const direct=[el.getAttribute?.("aria-label"),el.getAttribute?.("title")].map(x=>String(x||"").replace(/\s+/g," ").trim()).filter(Boolean);
    if(direct.length) return direct[0].slice(0,500);
    const semantic=el.querySelector?.('h1,h2,h3,h4,h5,h6,[class*="title" i],[class*="name" i]');
    const sem=text(semantic);
    if(sem && sem.length<=180) return sem;
    if(!text(el)){
      const card=el.closest?.('li,article,[class*="card" i],[class*="tile" i]');
      const heading=card?.querySelector('h1,h2,h3,h4,[class*="title" i],[class*="name" i]');
      if(text(heading))return text(heading);
      const sibling=[...(card?.querySelectorAll('a[href]')||[])].find(a=>a!==el&&a.href===el.href&&text(a));
      if(sibling)return text(sibling);
    }
    const imageTitle=String(el.querySelector?.('img[alt]')?.getAttribute('alt')||'').trim();
    if(imageTitle&&!/^(?:book\s*)?(?:cover|image|thumbnail)$/i.test(imageTitle))return imageTitle;
    const full=text(el);
    if(full.length<=260) return full;
    // Keep the link valid even when the anchor wraps an entire card. For display,
    // prefer the first sentence-like chunk instead of rejecting long labels.
    const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
    let fragment;
    while((fragment=walker.nextNode())){
      const value=String(fragment.nodeValue||"").trim();
      if(value&&value.length<=180)return value;
    }
    const cut=full.match(/^(.{1,180}?)(?:[.!?](?:\s|$))/);
    return String(cut?.[1]||full.slice(0,180)).trim();
  }
  function secondaryLinkContext(el,primary=""){
    if(!el)return "";
    const p=String(primary||"").replace(/\s+/g," ").trim();
    const selectors=[
      '[class*="source" i]','[class*="subtitle" i]','[class*="secondary" i]',
      '[class*="meta" i]','[class*="edition" i]','[class*="version" i]',
      '[class*="book" i]','[class*="category" i]','[class*="rules" i]','small'
    ];
    const itemish='li,article,tr,[role="row"],[class*="card" i],[class*="entry" i],[class*="result" i],[class*="list-row" i],[class*="list-item" i]';
    const boundary=el.parentElement?.closest?.(itemish)||el.parentElement;
    const cleanCandidate=(raw)=>{
      const t=String(raw||"").replace(/\s+/g," ").trim();
      if(!t||t===p||t.length<2||t.length>140)return "";
      if(p&&(p.includes(t)||t.toLowerCase().startsWith(`${p.toLowerCase()} `)))return "";
      if(/^(?:view(?: .*?)? details?|details?|learn more|read more|open|select|expand|collapse)$/i.test(t))return "";
      if(/^[^:：]{1,40}[:：]\s*\S/.test(t))return ""; // field/value pairs are not secondary titles
      // Secondary labels should be compact metadata, not prose from a tooltip, warning
      // or description. Keep short version/status markers (Legacy, Beta, Archived, …)
      // available as a fallback, but reject sentence-like boilerplate.
      const words=t.split(/\s+/).filter(Boolean);
      if(words.length>=7 && /[.!?]$/.test(t))return "";
      return t;
    };

    // Never search beyond the current repeated card/row. The old implementation could
    // climb into the whole result list and accidentally borrow the first source label
    // from a neighbouring item.
    let box=el.parentElement,depth=0;
    while(box&&box!==document.body&&depth++<8){
      if(!box.closest?.('header,footer')){
        for(const sel of selectors){
          for(const x of box.querySelectorAll?.(sel)||[]){
            if(x===el||x.contains?.(el)||el.contains?.(x))continue;
            const t=cleanCandidate(text(x));
            if(t)return t;
          }
        }
      }
      if(box===boundary)break;
      box=box.parentElement;
    }

    // Generic fallback for cards whose source/edition element has no semantic class.
    // Prefer short leaf/text fragments that occur immediately after the primary title
    // in the card text. This works for sources, editions and similar secondary labels
    // without knowing a site's DOM vocabulary.
    const scope=boundary||el;
    const full=text(scope);
    let remainder=full;
    if(p){
      const idx=full.indexOf(p);
      if(idx>=0)remainder=full.slice(idx+p.length).trim();
    }
    const fragments=[];
    try{
      const walker=document.createTreeWalker(scope,NodeFilter.SHOW_TEXT);
      let n;
      while((n=walker.nextNode())){
        const t=cleanCandidate(n.nodeValue);
        if(t)fragments.push(t);
      }
    }catch{}
    for(const x of scope.querySelectorAll?.('*')||[]){
      if(x.children?.length)continue;
      const t=cleanCandidate(text(x));
      if(t)fragments.push(t);
    }
    let best="",bestScore=-Infinity;
    for(const t of [...new Set(fragments)]){
      const pos=remainder.indexOf(t);
      if(pos<0||pos>180)continue;
      let score=0;
      if(pos===0)score+=120;
      else score+=Math.max(0,70-pos);
      if(t.length<=90)score+=10;
      // Version/status words are useful when a row has no source/edition label, but
      // they should lose against richer source metadata when both are present.
      if(/^(?:legacy|deprecated|archived|old version|current|new|beta|preview|experimental)$/i.test(t))score-=6;
      if(score>bestScore){best=t;bestScore=score;}
    }
    return bestScore>=35?best:"";
  }
  const uniqBy = (arr,keyFn) => [...new Map(arr.map(x=>[keyFn(x),x])).values()];
  function matches(url, patterns=[]) {
    return (patterns||[]).some(p=>{ try{return new RegExp(p,"i").test(url);}catch{return url.includes(String(p));} });
  }
  function abs(raw){ try{return new URL(raw, reading?reading.url:document.baseURI || location.href).href;}catch{return null;} }
  function sameOrigin(url, origin){ try{return new URL(url).origin===origin;}catch{return false;} }
  function selectorFirst(selector, root=pageDoc()) {
    if (!selector) return null;
    for (const s of String(selector).split(",")) {
      try { const el=root.querySelector(s.trim()); if(el) return el; } catch {}
    }
    return null;
  }
  function selectorAll(selector, root=pageDoc()) {
    if (!selector) return [];
    try { return [...root.querySelectorAll(selector)]; } catch { return []; }
  }
  async function waitForDomQuiet(root=document.body, quietMs=220, maxMs=2200) {
    if(!root || typeof MutationObserver==="undefined"){ await sleep(Math.min(quietMs,maxMs)); return; }
    await new Promise(resolve=>{
      let done=false, quietTimer=null;
      const finish=()=>{if(done)return;done=true;clearTimeout(quietTimer);clearTimeout(maxTimer);observer.disconnect();resolve();};
      const arm=()=>{clearTimeout(quietTimer);quietTimer=setTimeout(finish,quietMs);};
      const observer=new MutationObserver(arm);
      const maxTimer=setTimeout(finish,maxMs);
      try{observer.observe(root,{subtree:true,childList:true,attributes:true,characterData:false});arm();}catch{finish();}
    });
  }
  async function applyFilters(filters=[]) {
    let touched=false;
    for (const f of filters) {
      if (!f || !f.selector) continue;
      const el=selectorFirst(f.selector);
      if (!el) continue;
      touched=true;
      const type=f.type || "click";
      if (type === "checkbox" || type === "radio") {
        const wanted = ("checked" in f) ? Boolean(f.checked) : f.value !== false;
        if (Boolean(el.checked)!==wanted) el.click();
      } else if (type === "pressed") {
        const wanted = ("checked" in f) ? Boolean(f.checked) : Boolean(f.value);
        const current=String(el.getAttribute("aria-pressed")).toLowerCase()==="true";
        if(current!==wanted) el.click();
      } else if (type === "select") {
        const wanted=Array.isArray(f.value)?f.value.map(String):[String(f.value ?? "")];
        let changed=false;
        if(el.multiple){
          const set=new Set(wanted);
          for(const o of [...el.options]){const next=set.has(String(o.value));if(Boolean(o.selected)!==next){o.selected=next;changed=true;}}
        }else {const next=wanted[0] ?? "";if(String(el.value)!==String(next)){el.value=next;changed=true;}}
        // Replaying an already-active filter must not fire change again: many paginated
        // applications interpret that as a new search and jump back to page 1.
        if(changed){
          el.dispatchEvent(new Event("input",{bubbles:true}));
          el.dispatchEvent(new Event("change",{bubbles:true}));
        }
      } else if (type === "input") {
        const next=String(f.value ?? "");
        if(String(el.value)!==next){el.value=next;el.dispatchEvent(new Event("input",{bubbles:true}));el.dispatchEvent(new Event("change",{bubbles:true}));}
      } else if (type === "click") el.click();
      if (f.waitMs) await sleep(Math.min(10000,Math.max(0,Number(f.waitMs)||0)));
    }
    if(touched) await waitForDomQuiet(selectorFirst("main,article,[role=main]")||document.body,220,2200);
  }
  const PAGINATION_SCAN_CONTENT_LIVE_KEY="lwl_detection_scan_content_live_v1";
  async function persistDiscoverLive(ctx,stage,extra={}){
    if(!ctx||!chrome?.storage?.local)return;
    try{await chrome.storage.local.set({[PAGINATION_SCAN_CONTENT_LIVE_KEY]:{...ctx,stage,updatedAt:new Date().toISOString(),url:location.href,readyState:document.readyState,title:document.title,...extra}});}catch{}
  }
  function scanDebugFilterState(filters=[]) {
    return (filters||[]).map(f=>{
      const out={selector:f?.selector||null,type:f?.type||"click",exists:false};
      if(!f?.selector)return out;
      const el=selectorFirst(f.selector);out.exists=Boolean(el);if(!el)return out;
      const type=f.type||"click";
      if(type==="select"){
        out.multiple=Boolean(el.multiple);
        out.value=el.multiple?[...el.selectedOptions].map(o=>String(o.value)):String(el.value??"");
        out.selectedLabels=[...el.selectedOptions].map(o=>String(o.textContent||o.label||o.value||"").replace(/\s+/g," ").trim()).filter(Boolean);
      }else if(type==="checkbox"||type==="radio")out.checked=Boolean(el.checked);
      else if(type==="pressed")out.checked=String(el.getAttribute("aria-pressed")).toLowerCase()==="true";
      else if(type==="input")out.value="<redacted-user-input>";
      return out;
    });
  }
  function scanDebugPageStats(source){
    const root=selectorFirst(source?.contentSelector)||document.body||document.documentElement||document;
    let elementCount=0,anchorCount=0,scopeElementCount=0,scopeAnchorCount=0;
    try{elementCount=document.querySelectorAll('*').length;}catch{}
    try{anchorCount=document.querySelectorAll('a[href]').length;}catch{}
    try{scopeElementCount=root.querySelectorAll?.('*').length||0;}catch{}
    try{scopeAnchorCount=root.querySelectorAll?.('a[href]').length||0;}catch{}
    const mem=performance?.memory;
    let bodyTextLength=0,scopeTextLength=0,resourceCount=0,firstHeading="";
    try{bodyTextLength=String(document.body?.innerText||"").length;}catch{}
    try{scopeTextLength=String(root?.innerText||root?.textContent||"").length;}catch{}
    try{resourceCount=performance.getEntriesByType?.("resource")?.length||0;}catch{}
    try{firstHeading=text(selectorFirst("h1,h2",root)||selectorFirst("h1,h2"));}catch{}
    return {
      url:location.href,readyState:document.readyState,title:document.title,firstHeading,
      elementCount,anchorCount,scopeElementCount,scopeAnchorCount,bodyTextLength,scopeTextLength,resourceCount,
      visibilityState:document.visibilityState,
      ...(mem?{memory:{usedJSHeapSize:Number(mem.usedJSHeapSize||0),totalJSHeapSize:Number(mem.totalJSHeapSize||0),jsHeapSizeLimit:Number(mem.jsHeapSizeLimit||0)}}:{})
    };
  }
  function linkRecord(a,source={}) {
    const url=abs(a.getAttribute("href"));
    const card=(source.itemContainerSelector?a.closest(source.itemContainerSelector):null)||a.closest('li,article,[class*="card" i],[class*="tile" i]')||a;
    const selectedTitle=selectorFirst(source.itemTitleSelector,card);
    const selectedCover=selectorFirst(source.itemCoverSelector,card);
    const cover=selectedCover?(selectedCover.currentSrc||abs(selectedCover.getAttribute('src')||selectedCover.getAttribute('data-src'))):LWLPresentation.cover(card,pageHref(),{card:true});
    return url ? {title:text(selectedTitle)||preferredLinkTitle(a)||text(a)||url,url,cover} : null;
  }
  function discoverLinks(source, mode="items") {
    const origin = new URL(source.startUrl || location.href).origin;
    const root=mode === "pages" ? document : selectorFirst(source.discoveryRootSelector || source.contentSelector) || document;
    let anchors=[];
    const selector = mode === "items" ? source.itemLinkSelector : source.navigationSelector;
    if (selector) anchors=selectorAll(selector,root).filter(x=>x.tagName?.toLowerCase()==="a");
    else anchors=[...root.querySelectorAll("a[href]")];
    const includes = mode === "items" ? source.itemUrlPatterns : source.pageUrlPatterns;
    const excludes = mode === "items" ? source.itemExcludePatterns : source.pageExcludePatterns;
    const current = location.href.split("#")[0];
    const out=[];
    for (const a of anchors) {
      if(mode==='items'&&source.itemContainerSelector&&!a.closest(source.itemContainerSelector))continue;
      const rec=linkRecord(a,mode==='items'?source:{}); if(!rec) continue;
      // An entry's row names more than its title: its book, whether it is an older version.
      if(mode==='items'&&source.cardMetaFields?.length)rec.meta=cardMetaOf(catalogContainerForAnchor(a,source),source.cardMetaFields);
      if (!sameOrigin(rec.url,origin)) continue;
      if (rec.url.split("#")[0]===current) continue;
      if (includes?.length && !matches(rec.url,includes)) continue;
      if (excludes?.length && matches(rec.url,excludes)) continue;
      if (mode === "pages" && source.navigationScope === "itemPrefix" && source.collectionRoot) {
        try {
          const rr = new URL(source.collectionRoot), ru = new URL(rec.url);
          const basePath = rr.pathname.replace(/\/+$/, "");
          if (ru.origin !== rr.origin || !(ru.pathname === basePath || ru.pathname.startsWith(basePath + "/"))) continue;
        } catch {}
      }
      if (!rec.title || rec.title.length<1) continue;
      out.push(rec);
    }
    // Collections represent visible entries/cards, not only unique URLs.
    // Preserve distinct cards that share a destination URL; other source types
    // still deduplicate by URL.
    const dedupeKey = source.type === "collection"
      ? (x => `${String(x.title||"").toLowerCase()}\u0000${x.url}`)
      : (x => x.url);
    return uniqBy(out,dedupeKey).slice(0,source.maxItems||5000);
  }
  function autoNextLink(pagination) {
    if (pagination?.selector) {
      const a=selectorFirst(pagination.selector);
      // A selector learned on page 1 can legitimately stop matching on later
      // pagination layouts (ellipsis/current-page shifts). Fall through to the
      // semantic/text fallbacks instead of treating that as end-of-catalog.
      if(a?.href) return a.href;
    }
    const rel=document.querySelector('a[rel="next"]'); if(rel?.href) return rel.href;
    const candidates=[...document.querySelectorAll("a[href],button")];
    const re=/^(next|next page|older|more|weiter|nächste|nächster|›|»|→)$/i;
    const el=candidates.find(x=>re.test(text(x)) && (x.href || x.dataset?.href));
    return el ? abs(el.href || el.dataset.href) : null;
  }
  function escapeMd(s){ return String(s||"").replace(/([\\`*_{}\[\]()#+.!|>~-])/g,"\\$1"); }
  function nodeToMd(node, ctx={}) {
    if (!node) return "";
    if (node.nodeType===Node.TEXT_NODE) return String(node.nodeValue||"").replace(/\s+/g," ");
    if (node.nodeType!==Node.ELEMENT_NODE) return "";
    const tag=node.tagName.toLowerCase();
    if (["script","style","noscript","template","svg"].includes(tag)) return "";
    const child=()=>[...node.childNodes].map(n=>nodeToMd(n,ctx)).join("");
    if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${text(node)}\n\n`;
    if (tag==="p") return `\n\n${child().trim()}\n\n`;
    if (tag==="br") return "\n";
    if (tag==="strong"||tag==="b") return `**${child().trim()}**`;
    if (tag==="em"||tag==="i") return `*${child().trim()}*`;
    if (tag==="code") return `\`${child().trim().replace(/`/g,"\\`")}\``;
    if (tag==="pre") return `\n\n\`\`\`\n${text(node)}\n\`\`\`\n\n`;
    if (tag==="a") {
      const label=child().trim()||text(node); const href=abs(node.getAttribute("href"));
      return href ? `[${label}](${href})` : label;
    }
    if (tag==="li") return `\n- ${child().trim()}`;
    if (tag==="ul"||tag==="ol") return `\n${child()}\n`;
    if (tag==="blockquote") return `\n\n${child().trim().split(/\n/).map(x=>`> ${x}`).join("\n")}\n\n`;
    if (tag==="table") {
      const rows=[...node.querySelectorAll("tr")].map(tr=>[...tr.querySelectorAll(":scope > th, :scope > td")].map(td=>text(td)));
      if (!rows.length) return "";
      const cols=Math.max(...rows.map(r=>r.length));
      const first=rows[0];
      let md=`\n\n| ${Array.from({length:cols},(_,i)=>escapeMd(first[i]||"")).join(" | ")} |\n| ${Array(cols).fill("---").join(" | ")} |\n`;
      for (const r of rows.slice(1)) md+=`| ${Array.from({length:cols},(_,i)=>escapeMd(r[i]||"")).join(" | ")} |\n`;
      return `${md}\n`;
    }
    if (["div","section","article","main","header","footer","nav","aside","dl","dt","dd"].includes(tag)) return child();
    return child();
  }
  function cleanMarkdown(md){ return String(md||"").replace(/[ \t]+\n/g,"\n").replace(/\n{4,}/g,"\n\n\n").replace(/[ \t]{2,}/g," ").trim(); }
  function extractPage(source,root=selectorFirst(source.contentSelector) || pageDoc().body) {
    const clone=root.cloneNode(true);
    for (const sel of [...(source.excludeSelectors||[]),...(source.detailExcludeSelectors||[])]) { try{clone.querySelectorAll(sel).forEach(n=>n.remove());}catch{} }
    LWLPresentation.clean(clone);
    const markdown=cleanMarkdown(nodeToMd(clone));
    const headings=[...clone.querySelectorAll("h1,h2,h3,h4,h5,h6")].map(h=>({level:Number(h.tagName[1]),text:text(h),url:glossaryAnchorUrl(h)})).filter(h=>h.text);
    const links=uniqBy([...clone.querySelectorAll("a[href]")].map(linkRecord).filter(Boolean),x=>x.url);
    const title=pageTitle(clone,source);
    return {title,url:pageHref(),markdown,headings,links,characterCount:markdown.length};
  }
  /* Collects the stylesheets that style this page so the reader can render the
     captured article with the site's own CSS instead of a generic theme. Same
     mechanism for every site - nothing here knows which site it is running on.
     Relative url() references are made absolute, because the reader lives in a
     different directory; anything the reader cannot resolve simply does not
     paint, which is why this is fidelity, not a perfect copy. */
  /* The list row carries only what the site prints in it. The item's own page
     carries more - on a catalog item the individual tags and source citation -
     and those are exactly the dimensions the site itself offers as filters.
     Same generic rule as for rows, with two additions: a key may hold several
     values, and a label the site repeats inside the value is stripped. */
  /* "Utility, Container" is two values, not one string: kept whole it produces
     a thousand unique combinations and no filter at all, split it collapses to
     the handful of tokens the site itself offers as a filter. Only split when
     every part is short, so a title that happens to contain a comma - a source
     book with a page citation - stays intact. */
  function splitListValue(value) {
    if (!/,\s/.test(value)) return null;
    const parts = value.split(/\s*,\s*/).map(p => p.trim()).filter(Boolean);
    if (parts.length < 2 || parts.length > 12) return null;
    if (parts.some(p => p.length > 24 || /^(pp?|pg|page|S|Seite)\.?\s*\d/i.test(p))) return null;
    return parts;
  }

  function stripOwnLabel(key, value) {
    const m = String(value).match(/^([A-Za-z][A-Za-z ]{1,24}):\s*(.+)$/);
    if (!m) return value;
    const prefix = m[1].toLowerCase().replace(/\s+/g, "-");
    const k = String(key).toLowerCase();
    return (k.startsWith(prefix) || prefix.startsWith(k)) ? m[2].trim() : value;
  }
  function genericDetailMeta(root, title) {
    const collected = new Map();
    const name = String(title || "").trim().toLowerCase();
    for (const el of root.querySelectorAll("[class]")) {
      if (collected.size >= 14) break;
      if (el.querySelector("[class]")) continue;
      const key = genericMetaKey(el);
      if (!key) continue;
      let value = metaValue(compactCatalogText(el));
      if (!value || value.length > 90) continue;
      value = stripOwnLabel(key, value);
      if (!value || value.toLowerCase() === name) continue;
      if (!collected.has(key)) collected.set(key, []);
      const list = collected.get(key);
      for (const one of splitListValue(value) || [value]) {
        if (!list.includes(one) && list.length < 12) list.push(one);
      }
    }
    /* Two purely structural tidy-ups, no site knowledge: a class like
       "notes-string" names its markup, not its meaning, and a field that holds
       several values reads as a plural. Both make the key line up with the
       labels the reader already knows ("tags", "source"). */
    const out = {};
    for (const [key, list] of collected) {
      let name = key.replace(/-(string|text|label|value|line|wrapper)$/, "");
      if (list.length > 1 && !name.endsWith("s")) name += "s";
      if (!out[name]) out[name] = list.length > 1 ? list : list[0];
    }
    return out;
  }

  async function collectPageStyles(limitBytes = 12000000, keepPatterns = [], stateClasses = []) {
    const warnings = [], pending = [], seen = new Set(); let size = 0, sheets = 0;
    // Shared site bundles contain artwork and fonts for hundreds of other books.
    // Retain selectors that can match this document, including interactive states
    // and pseudo elements, instead of fetching those unrelated assets offline.
    const selectorCache=new Map(),fontFamilies=new Set();
    for(const el of document.querySelectorAll("*")) {
      for(const family of getComputedStyle(el).fontFamily.split(","))fontFamilies.add(family.trim().replace(/^['"]|['"]$/g,"").toLowerCase());
    }
    const relevant=selector=>{
      if(keepPatterns.some(pattern=>{try{return new RegExp(pattern).test(selector);}catch{return false;}}))return true;
      if(selectorCache.has(selector))return selectorCache.get(selector);
      let relaxed=selector.replace(/::[\w-]+(?:\([^)]*\))?/g,"").replace(/:(?:before|after|hover|active|focus-visible|focus-within|focus|visited|link|target|checked|disabled|enabled)(?![\w-])/g,"")
        .replace(/:(?:nth-child|nth-last-child|nth-of-type|nth-last-of-type)\([^)]*\)/g,"").replace(/:(?:first-child|last-child|only-child|first-of-type|last-of-type|only-of-type)(?![\w-])/g,"")
        .replace(/\[(?:aria-expanded|aria-selected|data-state|data-sort-by|data-sort-direction)[^\]]*\]/g,"").replace(/\.(?:is-|has-|_)?(?:opened|open|closed|active|expanded|collapsed|selected)(?:[_-][\w-]+)?(?![\w-])/g,"");
      for(const name of stateClasses.filter(Boolean)){
        const escaped=cssEscapeIdent(name).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
        relaxed=relaxed.replace(new RegExp('\\.'+escaped+'(?![\\w-])','g'),'');
      }
      let keep=true;try{keep=Boolean(document.querySelector(relaxed));}catch{}
      selectorCache.set(selector,keep);return keep;
    };
    const prune=rules=>[...rules].map(rule=>{
      if(rule.type===1 && !relevant(rule.selectorText))return "";
      if(rule.type===5 && !fontFamilies.has(String(rule.style.getPropertyValue('font-family')||'').replace(/^['"]|['"]$/g,"").toLowerCase()))return "";
      if(rule.cssRules && ![1,7,8].includes(rule.type))return rule.cssText.slice(0,rule.cssText.indexOf("{")+1)+prune(rule.cssRules)+"}";
      return rule.cssText;
    }).filter(Boolean).join("\n");
    const pruneText=css=>{
      if(typeof CSSStyleSheet === "undefined" || !CSSStyleSheet.prototype.replaceSync)return css;
      // Constructed sheets omit @import; retain those explicitly for the builder.
      const imports=[];css=css.replace(/@import\s+(?:url\([^;]+\)|['"][^'"]+['"])[^;]*;/gi,x=>{imports.push(x);return "";});
      try{const parsed=new CSSStyleSheet();parsed.replaceSync(css);return imports.join("\n")+"\n"+prune(parsed.cssRules);}catch{return imports.join("\n")+"\n"+css;}
    };
    const absoluteCss = (css, base) => css.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, (all, q, raw) => {
      const value = raw.trim();
      if (/^(data:|#)/i.test(value)) return all;
      try { return `url("${new URL(value, base).href.replace(/"/g, "%22")}")`; } catch { return all; }
    }).replace(/@import\s+(['"])([^'"]+)\1/gi,(all,q,url)=>`@import "${new URL(url,base).href}"`);
    async function readSheet(sheet) {
      if (sheet.disabled || sheet.media?.mediaText === "print") return "";
      let rules, css = "";
      try { rules = [...sheet.cssRules]; } catch {}
      if (rules) {
        for (const rule of rules) {
          if (rule.type === 3 && rule.styleSheet) {
            const imported = await readSheet(rule.styleSheet);
            const media = rule.media?.mediaText;
            css += media ? `@media ${media}{${imported}}\n` : imported + "\n";
          } else css += absoluteCss(prune([rule]), sheet.href || document.baseURI) + "\n";
        }
      } else if (sheet.href && !seen.has(sheet.href)) {
        seen.add(sheet.href);
        try {
          const response = await fetch(sheet.href, {credentials: new URL(sheet.href).origin===location.origin ? "include" : "omit"});
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          css = absoluteCss(pruneText(await response.text()), sheet.href);
        } catch {
          const marker=`/*lwl-pending-stylesheet-${pending.length}*/`;
          pending.push({url:sheet.href,marker});css=marker;
        }
      }
      return css;
    }
    const parts = [];
    for (const sheet of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) {
      const css = await readSheet(sheet);
      if (!css) continue;
      if (size + css.length > limitBytes) { warnings.push(`Stylesheet budget exceeded: ${sheet.href || "inline"}`); continue; }
      size += css.length; sheets++;
      const media = sheet.media?.mediaText;
      parts.push(media && media !== "all" ? `@media ${media}{${css}}` : css);
    }
    return {css: parts.join("\n"), sheets, bytes: size, warnings, pending};
  }

  function presentationAttributes(element) {
    const out = {};
    for (const attr of element?.attributes || []) {
      if (/^(id|class|lang|dir|role|style)$/.test(attr.name) || /^data-(theme|page|layout|book|source|content)(-|$)/.test(attr.name)) out[attr.name] = attr.value;
    }
    return out;
  }
  function pagePresentation(source) {
    return {html: presentationAttributes(pageDoc().documentElement), body: presentationAttributes(pageDoc().body),
      mode:source?.captureMode === "page" ? "page" : "article", pageSelector:source?.pageSelector||null, navigationToggles:source?.navigationToggles || []};
  }
  function checkAvailability(source) {
    const cfg = source?.availability || {};
    if (!reading && [404, 410].includes(globalThis.performance?.getEntriesByType?.("navigation")[0]?.responseStatus)) throw new Error("Unavailable content: page not found");
    // A fetched page has no layout: there, a notice that is present counts.
    const unavailable = (cfg.unavailableSelectors || []).some(sel => selectorAll(sel).some(reading ? Boolean : visible));
    if (unavailable || (cfg.requiredSelector && !selectorFirst(cfg.requiredSelector))) throw new Error("Unavailable content: required article missing or access notice visible");
    if (/^(just a moment|access denied|sign in|log in|page not found)/i.test(pageDoc().title.trim())) throw new Error("Unavailable content: sign-in, challenge or error page");
  }
  /* Reads the design tokens of the page it is standing on: background, text and
     accent colour, the fonts, the border tone. The reader is built entirely on
     CSS variables, so feeding these in makes its whole interface - not just the
     article - take on the look of the site the content came from. Nothing here
     knows which site that is; another site yields its own tokens. */
  function collectPageTheme() {
    const style = el => (el ? getComputedStyle(el) : null);
    const opaque = v => Boolean(v) && !/^(transparent|rgba\(0,\s*0,\s*0,\s*0\))$/.test(v);
    const luminance = c => {
      const m = String(c).match(/\d+(\.\d+)?/g);
      if (!m || m.length < 3) return null;
      const [r, g, b] = m.slice(0, 3).map(Number);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    const bodyStyle = style(document.body), htmlStyle = style(document.documentElement);
    const bg = [bodyStyle?.backgroundColor, htmlStyle?.backgroundColor].find(opaque) || "#ffffff";
    const ink = bodyStyle?.color || "#111111";

    /* Surfaces and lines are whatever the page uses most often, which is more
       reliable than guessing at a container selector. */
    const tally = (values) => {
      const counts = new Map();
      for (const v of values) if (v) counts.set(v, (counts.get(v) || 0) + 1);
      return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    };
    const sample = [...document.querySelectorAll("div,section,article,aside,li,td")].slice(0, 600);
    const surface = tally(sample.map(el => {
      const c = style(el).backgroundColor;
      return opaque(c) && c !== bg ? c : null;
    })) || bg;
    const line = tally(sample.map(el => {
      const st = style(el);
      return st.borderTopWidth !== "0px" && opaque(st.borderTopColor) ? st.borderTopColor : null;
    }));

    /* Accent detection is the one token with no dependable signal: measured on a
       live page, the most visible link was white (it sits in a dark header), the
       largest saturated area was a cyan promo, and the site's own
       "primary" design token was a light grey. A wrong accent is worse than
       none, so it is only reported when several interactive elements inside the
       content agree on one clearly saturated colour; otherwise the reader keeps
       its own and only background, text, borders and fonts are adopted. */
    const scope = document.querySelector("main, [role='main'], article") || document.body;
    const saturation = c => { const m = c && c.match(/\d+/g); if (!m) return 0;
      const [r, g, b] = m.slice(0, 3).map(Number), mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      return mx ? (mx - mn) / mx : 0; };
    const accentCounts = new Map();
    for (const el of [...scope.querySelectorAll("a[href], button, .btn")].slice(0, 400)) {
      if (!el.getClientRects().length) continue;
      const c = style(el).color;
      if (saturation(c) < 0.55) continue;
      if (Math.abs((luminance(c) ?? 0) - (luminance(bg) ?? 1)) < 0.12) continue;
      accentCounts.set(c, (accentCounts.get(c) || 0) + 1);
    }
    const accentPick = [...accentCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const accent = accentPick && accentPick[1] >= 3 ? accentPick[0] : null;

    const heading = document.querySelector("h1, h2");
    const headingStyle = style(heading);
    const lum = luminance(bg);

    return {
      bg,
      surface,
      ink,
      line: line || null,
      accent,
      sans: bodyStyle?.fontFamily || null,
      serif: headingStyle?.fontFamily || bodyStyle?.fontFamily || null,
      headingWeight: headingStyle?.fontWeight || null,
      radius: style(document.querySelector("button, .btn, input")) ?.borderTopLeftRadius || null,
      dark: lum != null ? lum < 0.5 : false
    };
  }

  async function prepareOfflineCapture() {
    document.querySelectorAll("img[loading='lazy']").forEach(img=>{img.loading="eager";});
    document.querySelectorAll("iframe[loading='lazy']").forEach(x=>{x.loading="eager";});
    const height=Math.max(document.body?.scrollHeight||0,document.documentElement?.scrollHeight||0);
    // Long chapters can span hundreds of screens. Background tabs throttle
    // timers, so unbounded scrolling could consume the entire capture deadline.
    const step=Math.max(700,Math.floor(innerHeight*0.85),Math.ceil(height/48));
    const scrollStarted=Date.now();
    for(let y=0;y<height&&Date.now()-scrollStarted<4000;y+=step){ scrollTo({left:0,top:y,behavior:"instant"}); await sleep(35); }
    scrollTo({left:0,top:height,behavior:"instant"});
    scrollTo({left:0,top:0,behavior:"instant"});
    await waitForDomQuiet(document.body,250,2200);
    if (document.fonts?.ready) await Promise.race([document.fonts.ready,sleep(1500)]).catch(()=>{});
    const imgs=[...document.images];
    await Promise.all(imgs.slice(0,300).map(img=>img.complete?null:Promise.race([new Promise(r=>{img.addEventListener("load",r,{once:true});img.addEventListener("error",r,{once:true});}),sleep(1800)])));
    return {images:imgs.length,incompleteImages:imgs.filter(i=>!i.complete).length,height};
  }
  function glossaryAnchorUrl(node) {
    try {
      const base=new URL(pageHref()); base.hash="";
      const hashUrl=raw=>{
        if(!raw)return null;
        const u=new URL(raw,base.href);
        if(u.origin!==base.origin||u.pathname!==base.pathname||u.search!==base.search)return null;
        return u.hash ? `${base.href}${u.hash}` : null;
      };
      const directId=node?.id||node?.getAttribute?.("name");
      if(directId){const u=new URL(base.href);u.hash=directId;return u.href;}
      const previous=node?.previousElementSibling;
      if(previous?.tagName === "A" && !text(previous) && (previous.id || previous.name)){const u=new URL(base.href);u.hash=previous.id || previous.name;return u.href;}
      const ownAnchor=node?.querySelector?.('a[href^="#"]');
      const ownHref=hashUrl(ownAnchor?.getAttribute?.("href")); if(ownHref)return ownHref;
      const named=node?.querySelector?.('[id],a[name]');
      const nestedId=named?.id||named?.getAttribute?.("name");
      if(nestedId){const u=new URL(base.href);u.hash=nestedId;return u.href;}
      let parent=node?.parentElement;
      for(let i=0;parent&&i<2;i++,parent=parent.parentElement){
        const pid=parent.id||parent.getAttribute?.("name");
        if(pid&&parent.querySelectorAll("h1,h2,h3,h4,h5,h6,dt").length===1){const u=new URL(base.href);u.hash=pid;return u.href;}
      }
      return base.href;
    } catch { return pageHref(); }
  }
  function glossaryEntriesFromPage(source, page) {
    const cfg=source.glossary || {};
    // Chapters have anchors, but that does not make them glossary definitions.
    if(source.type!=='glossary'&&!cfg.termSelector&&!cfg.headingSelector)return [];
    const entries=[];
    if (cfg.termSelector && cfg.definitionSelector) {
      const terms=selectorAll(cfg.termSelector); const defs=selectorAll(cfg.definitionSelector);
      const n=Math.min(terms.length,defs.length);
      for(let i=0;i<n;i++) if(text(terms[i])&&text(defs[i])) entries.push({term:text(terms[i]),definition:text(defs[i]),url:glossaryAnchorUrl(terms[i])});
    } else {
      const root=detailRoot(source);
      const heads=[...root.querySelectorAll(cfg.headingSelector||"h2,h3,h4,h5,h6,dt")];
      for(const [index,h] of heads.entries()) {
        const term=text(h); if(!term||term.length>120) continue;
        let cur=h.nextElementSibling, parts=[];
        while(cur && !/^H[1-6]$/.test(cur.tagName) && cur.tagName!=="DT" && parts.join(" ").length<1600){ parts.push(text(cur)); cur=cur.nextElementSibling; }
        if(cfg.headingSelector||!parts.length){
          const range=pageDoc().createRange();range.setStartAfter(h);
          const next=heads.slice(index+1).find(n=>n.tagName==="DT" || Number(n.tagName[1])<=Number(h.tagName[1]));
          if(next)range.setEndBefore(next);else range.setEnd(root,root.childNodes.length);
          parts=[text(range.cloneContents()).slice(0,1600)];
        }
        const definition=parts.join(" ").trim(); if(definition.length>=15) entries.push({term,definition,url:glossaryAnchorUrl(h)});
      }
    }
    return entries;
  }


  function cssEscapeIdent(value) {
    if (globalThis.CSS?.escape) return CSS.escape(String(value));
    return String(value).replace(/[^a-zA-Z0-9_-]/g, ch=>`\\${ch}`);
  }
  function uniqueSelector(el) {
    if (!el || el.nodeType!==1) return null;
    if (el.id) {
      const id=`#${cssEscapeIdent(el.id)}`;
      try { if (document.querySelectorAll(id).length===1) return id; } catch {}
    }
    for (const attr of ["data-testid","data-test","name","aria-label"]) {
      const v=el.getAttribute?.(attr);
      if (!v || v.length>100) continue;
      const sel=`${el.tagName.toLowerCase()}[${attr}="${String(v).replace(/\\/g,"\\\\").replace(/"/g,'\\"')}"]`;
      try { if (document.querySelectorAll(sel).length===1) return sel; } catch {}
    }
    const parts=[]; let cur=el;
    for(let depth=0;cur&&cur!==document.documentElement&&depth<5;depth++,cur=cur.parentElement){
      let part=cur.tagName.toLowerCase();
      const stable=[...cur.classList].filter(c=>c.length<50&&!/^(active|selected|open|focus|hover|css-|sc-|jsx-)/i.test(c)).slice(0,2);
      if(stable.length) part += stable.map(c=>`.${cssEscapeIdent(c)}`).join("");
      const parent=cur.parentElement;
      if(parent){
        const siblings=[...parent.children].filter(x=>x.tagName===cur.tagName);
        if(siblings.length>1) part += `:nth-of-type(${siblings.indexOf(cur)+1})`;
      }
      parts.unshift(part);
      const sel=parts.join(" > ");
      try { if(document.querySelectorAll(sel).length===1) return sel; } catch {}
    }
    return parts.join(" > ") || null;
  }
  function queryIdentity(u){return [...u.searchParams.keys()].find(key=>/^(?:id|[a-z_]+id|item|entry|record)$/i.test(key)&&u.searchParams.get(key));}
  function pathTemplate(url) {
    try {
      const u=new URL(url), seg=u.pathname.split("/").filter(Boolean);
      if(!seg.length) return null;
      const prefix=seg.slice(0,-1).map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")).join("/");
      const origin=u.origin.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
      const identity=queryIdentity(u);
      if(identity)return `^${origin}${u.pathname.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}\\?(?:[^#]*&)?${identity.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}=[^&#]+(?:[&#].*)?$`;
      return `^${origin}/${prefix?prefix+"/":""}[^/?#]+/?(?:[?#].*)?$`;
    } catch { return null; }
  }
  function pathFamilyKey(url) {
    try {
      const u=new URL(url), seg=u.pathname.split("/").filter(Boolean);
      if(!seg.length) return null;
      const identity=queryIdentity(u);if(identity)return `${u.origin}|${u.pathname}?${identity}=*`;
      return `${u.origin}|/${seg.slice(0,-1).join("/")}/|${seg.length}`;
    } catch { return null; }
  }
  function visible(el){
    if(!el?.getBoundingClientRect) return false;
    const r=el.getBoundingClientRect(), st=getComputedStyle(el);
    return r.width>0&&r.height>0&&st.display!=="none"&&st.visibility!=="hidden";
  }
  function labelForControl(el){
    if(el.id){const lab=document.querySelector(`label[for="${cssEscapeIdent(el.id)}"]`);if(lab&&text(lab))return text(lab);}
    const parent=el.closest("label"); if(parent&&text(parent)) return text(parent).slice(0,180);
    const aria=el.getAttribute("aria-label")||el.getAttribute("title")||el.name||el.placeholder; if(aria)return String(aria).trim();
    const prev=el.previousElementSibling; if(prev&&text(prev))return text(prev).slice(0,180);
    return `${el.tagName.toLowerCase()} ${el.type||""}`.trim();
  }
  function detectControls(contentSelector="body"){
    const root=selectorFirst(contentSelector)||document.body||document;
    const controls=[], seen=new Set();
    const normLabel=x=>String(x||"").replace(/\s+/g," ").trim().toLocaleLowerCase();
    function filterishAncestor(el){
      return el?.closest?.('form,[role="search"],[class*="filter" i],[id*="filter" i],[class*="sort" i],[id*="sort" i],[class*="toolbar" i],[id*="toolbar" i]')||null;
    }
    function nativeSelectRelevant(el){
      if(visible(el))return true;
      // Custom-select libraries commonly hide the real SELECT and render a separate
      // text/combobox UI. A labelled SELECT inside an active filter/search region is
      // still the safest, most generic source of values/options and can be replayed
      // with normal input/change events.
      const anc=filterishAncestor(el);
      if(anc && visible(anc))return true;
      const label=labelForControl(el);
      return Boolean((el.id||el.name) && label && !/^select\s*$/i.test(label) && el.options?.length);
    }
    const add=(el,type,extra={})=>{
      if(!el||el.disabled)return;
      const allowHidden=Boolean(extra.allowHidden);
      if(!allowHidden&&!visible(el))return;
      const selector=uniqueSelector(el); if(!selector||seen.has(selector))return; seen.add(selector);
      const label=labelForControl(el);
      let value=null,checked=null;
      if(type==="checkbox"||type==="radio")checked=Boolean(el.checked);
      else if(type==="pressed")checked=String(el.getAttribute("aria-pressed")).toLowerCase()==="true";
      else if(type==="aria-check")checked=String(el.getAttribute("aria-checked")).toLowerCase()==="true";
      else if(type==="select")value=el.multiple?[...el.selectedOptions].map(o=>String(o.value)):String(el.value??"");
      else if(type==="input"||type==="search")value=String(el.value??"");
      const genericSearch=type==="search"||/search|suche/i.test(label);
      const hasSelectValue=type==="select"&&(Array.isArray(value)?value.some(v=>String(v).length>0):Boolean(value));
      const suggested=(type==="checkbox"||type==="radio"||type==="pressed"||type==="aria-check")?checked:(type==="select"?hasSelectValue:(!genericSearch&&type==="input"&&Boolean(value)));
      controls.push({label,type,selector,name:el.getAttribute?.("name")||el.name||null,value,checked,suggested,stateText:extra.stateText||null,role:el.getAttribute?.("role")||null,ariaHaspopup:el.getAttribute?.("aria-haspopup")||null,multiple:type==="select"?Boolean(el.multiple):undefined,hidden:!visible(el),options:type==="select"?[...el.options].map(o=>({label:text(o),value:o.value,selected:o.selected,disabled:o.disabled})):undefined});
    };
    // Handle native selects first, including hidden source-of-truth selects behind
    // custom widgets. This lets us suppress their generated search inputs later.
    for(const el of root.querySelectorAll('select'))if(nativeSelectRelevant(el))add(el,"select",{allowHidden:true});
    for(const el of root.querySelectorAll('input[type="checkbox"],input[type="radio"],input[type="text"],input[type="search"],input:not([type]),button[aria-pressed]')){
      const type=el.tagName.toLowerCase()==="button"?"pressed":(el.type||"input").toLowerCase();
      add(el,type);
    }
    // Modern web apps frequently render filters as ARIA widgets instead of native form controls.
    for(const el of root.querySelectorAll('[role="combobox"],[role="checkbox"],[role="radio"],[role="switch"],button[aria-haspopup="listbox"],button[aria-haspopup="menu"]')){
      const role=(el.getAttribute("role")||"").toLowerCase();
      if(role==="checkbox"||role==="radio"||role==="switch") add(el,"aria-check",{stateText:text(el).slice(0,180)});
      else add(el,"interactive",{stateText:text(el).slice(0,180)});
    }
    // Generic filter/toolbars sometimes expose only expanded/collapsed buttons.
    for(const el of root.querySelectorAll('button[aria-expanded]')){
      const anc=filterishAncestor(el);
      if(anc) add(el,"interactive",{stateText:text(el).slice(0,180)});
    }
    // If a visible generated input has the same semantic label as a native select,
    // prefer the native select because it contains the actual option/value model.
    const selectLabels=new Set(controls.filter(c=>c.type==="select").map(c=>normLabel(c.label)).filter(Boolean));
    return controls.filter(c=>!(c.type==="text"&&selectLabels.has(normLabel(c.label))));
  }
  function detectPagination(){
    const candidates=[...document.querySelectorAll("a[href],button")].filter(visible);
    const re=/^(next|next page|older|more|weiter|nächste|nächster|mehr|›|»|→)$/i;
    const rel=document.querySelector('a[rel="next"]');
    const el=(rel?.href?rel:null)||candidates.find(x=>re.test(text(x))&&(x.href||x.dataset?.href));
    if(!el)return {detected:false};

    // Prefer semantic/list containers over arbitrary pagination-* classes. A common
    // pattern gives each LI a class such as "pagination-item"; using closest() with
    // all selectors at once would then stop at the Next LI and miss its numeric siblings.
    const semanticScope=el.closest('nav,[role="navigation"],ul,ol');
    let classScope=el.closest('[class*="pagination" i],[class*="pager" i],[class*="paging" i]');
    while(classScope && classScope!==document.body && classScope.querySelectorAll?.('a[href]').length<2){
      classScope=classScope.parentElement?.closest?.('[class*="pagination" i],[class*="pager" i],[class*="paging" i]')||classScope.parentElement;
    }
    const scope=semanticScope||classScope||el.parentElement?.parentElement||document;
    const nextUrl=abs(el.href||el.dataset?.href);

    // Derive the page query parameter from the Next URL where possible. This lets us
    // read page numbers even when the anchor text is hidden, abbreviated or non-numeric.
    let pageParam=null;
    try{
      const nu=new URL(nextUrl,location.href), cu=new URL(location.href);
      for(const [k,v] of nu.searchParams.entries()){
        if(!/^\d+$/.test(v))continue;
        if(/^(page|pagenum|page_num|page_number|pg|p)$/i.test(k) || cu.searchParams.get(k)!==v){pageParam=k;break;}
      }
    }catch{}
    const pageNumberFrom=(node)=>{
      const direct=Number(text(node));
      if(Number.isInteger(direct)&&direct>0)return direct;
      const aria=String(node.getAttribute?.('aria-label')||node.getAttribute?.('title')||'');
      const labelled=aria.match(/(?:page|seite)\s*(\d+)/i); if(labelled)return Number(labelled[1]);
      const href=node.href||node.dataset?.href;
      if(href){
        try{
          const u=new URL(href,location.href);
          if(pageParam){const n=Number(u.searchParams.get(pageParam));if(Number.isInteger(n)&&n>0)return n;}
          for(const [k,v] of u.searchParams.entries())if(/^(page|pagenum|page_num|page_number|pg)$/i.test(k)&&/^\d+$/.test(v))return Number(v);
        }catch{}
      }
      return null;
    };
    const numericPages=[...scope.querySelectorAll('a[href]')].map(pageNumberFrom).filter(n=>Number.isInteger(n)&&n>0);
    const currentCandidates=[...scope.querySelectorAll('[aria-current="page"],.active,.selected')].map(pageNumberFrom).filter(n=>Number.isInteger(n)&&n>0);
    const pageNumbers=[...new Set([...numericPages,...currentCandidates])].sort((a,b)=>a-b);
    const lastPage=pageNumbers.length?Math.max(...pageNumbers):null;
    return {detected:true,selector:uniqueSelector(el),nextUrl,label:text(el)||"next",lastPage,pageNumbers,pageParam};
  }
  function detectGlossaryCandidate(contentSelector){
    const root=selectorFirst(contentSelector)||document.body||document;
    const dts=[...root.querySelectorAll("dt")].filter(visible), dds=[...root.querySelectorAll("dd")].filter(visible);
    if(dts.length>=3&&dds.length>=3){
      return {
        kind:"glossary",
        label:"Glossary / definitions",
        confidence:Math.min(.98,.62+Math.min(dts.length,50)/150),
        itemCount:Math.min(dts.length,dds.length),
        termSelector:"dt",
        definitionSelector:"dd",
        samples:dts.map(text),
        scopeSelector:contentSelector,
        rationale:`${Math.min(dts.length,dds.length)} visible definition-list term/definition pairs detected.`,
        metrics:{glossaryMode:"definition-list",termCount:dts.length,definitionCount:dds.length}
      };
    }

    // Many modern documentation/glossary pages use one heading per term instead of
    // <dt>/<dd>. Detect this generically only when the page itself strongly signals a
    // glossary/definitions page and there is substantial heading-based structure.
    const hint=currentPageHint();
    const headings=[...root.querySelectorAll("h2,h3,h4")].filter(visible).map(h=>({el:h,title:text(h)})).filter(x=>x.title&&x.title.length<=140);
    if(hint==="glossary"&&headings.length>=8){
      const norm=x=>String(x||"").toLocaleLowerCase().replace(/\s+/g," ").trim();
      const headingGroups=new Map();
      for(const x of headings){const k=norm(x.title);if(!headingGroups.has(k))headingGroups.set(k,[]);headingGroups.get(k).push(x.title);}
      const headingNames=new Set(headingGroups.keys());
      const duplicateHeadingGroups=[...headingGroups.values()].filter(xs=>xs.length>1).map(xs=>({title:xs[0],count:xs.length}));
      const base=location.href.split("#")[0];
      const samePageLinks=[...document.querySelectorAll("a[href]")].map(a=>{
        const url=abs(a.getAttribute("href")); if(!url||url.split("#")[0]!==base)return null;
        const title=preferredLinkTitle(a)||text(a); return title?{title,url,visible:visible(a)}:null;
      }).filter(Boolean);
      const samePageNames=new Set(samePageLinks.map(x=>norm(x.title)));
      let overlap=0; for(const name of headingNames)if(samePageNames.has(name))overlap++;
      const overlapRatio=headingNames.size?overlap/headingNames.size:0;
      const confidence=Math.min(.98,.82+Math.min(.10,headings.length/1000)+Math.min(.06,overlapRatio*.12));
      return {
        kind:"glossary",
        label:"Glossary / heading definitions",
        confidence,
        itemCount:headings.length,
        usableItemCount:headings.length,
        uniqueTargetCount:1,
        duplicateEntryCount:0,
        duplicateUrlGroups:[],
        duplicateTitleGroups:[],
        termSelector:null,
        definitionSelector:null,
        samples:headings.map(x=>x.title),
        targets:[],
        detectedTargets:[],
        scopeSelector:contentSelector,
        rationale:`Glossary-like page with ${headings.length} visible term-sized headings and ${samePageLinks.length} same-page navigation link(s); definitions can be extracted from content following each heading.`,
        metrics:{glossaryMode:"heading",headingCount:headings.length,uniqueHeadingCount:headingNames.size,duplicateHeadingCount:headings.length-headingNames.size,duplicateHeadingGroups,samePageLinkCount:samePageLinks.length,headingNavigationOverlap:overlap,headingNavigationOverlapRatio:overlapRatio}
      };
    }
    return null;
  }
  function currentPageHint(){
    const hay=`${document.title.split(/\s(?:[|–—]|-)\s/)[0]} ${location.pathname}`.toLowerCase();
    // Specific semantic page types must win over broad container words such as
    // "sources". A URL like /sources/.../rules-glossary is a glossary page,
    // not a generic source collection.
    if(/glossar|glossary|terms|definitions|begriffe/.test(hay))return"glossary";
    if(/library|books|sources|manuals|handbooks|publications|archive|bibliothek|bücher/.test(hay))return"collection";
    if(/catalog|database|directory|index|reference|listing|results|components|entries|items|api/.test(hay))return"catalog";
    return"section";
  }
  function structuralKey(el,stop){
    let cur=el?.parentElement,parts=[];
    for(let i=0;cur&&cur!==stop&&i<3;i++,cur=cur.parentElement){
      let part=cur.tagName.toLowerCase();
      const cls=[...cur.classList].filter(c=>c.length<45&&!/^(active|selected|open|focus|hover|css-|sc-|jsx-)/i.test(c)).slice(0,2);
      if(cls.length)part+=cls.map(c=>`.${c}`).join("");
      parts.push(part);
    }
    return parts.join("<");
  }
  function stableClasses(el){
    return [...(el?.classList||[])].filter(c=>c.length<80&&!/^(active|selected|open|focus|hover|css-|sc-|jsx-)/i.test(c));
  }
  function simpleElementSelector(el){
    if(!el?.tagName)return null;
    let sel=el.tagName.toLowerCase();
    const cls=stableClasses(el).slice(0,3);
    if(cls.length)sel+=cls.map(c=>`.${cssEscapeIdent(c)}`).join("");
    return sel;
  }
  function dominantValue(values){
    const counts=new Map();
    for(const v of values)if(v)counts.set(v,(counts.get(v)||0)+1);
    let value=null,count=0;
    for(const [v,n] of counts)if(n>count){value=v;count=n;}
    return {value,count};
  }
  function structuralExpansion(arr,allRecords,contentRoot){
    const keys=arr.map(x=>structuralKey(x.el,contentRoot));
    const dom=dominantValue(keys);
    const repeatRatio=arr.length?dom.count/arr.length:0;
    let expanded=arr, structuralSiblingCount=arr.length, structuralOutlierCount=0;
    if(dom.value&&repeatRatio>=.8){
      const siblings=uniqBy(
        allRecords.filter(x=>structuralKey(x.el,contentRoot)===dom.value),
        x=>`${String(x.title||"").toLowerCase()}\u0000${x.url}`
      );
      const upper=Math.max(arr.length+25,Math.ceil(arr.length*1.18));
      if(siblings.length>=arr.length&&siblings.length<=upper){
        expanded=siblings;
        structuralSiblingCount=siblings.length;
        const base=new Set(arr.map(x=>x.url));
        structuralOutlierCount=siblings.filter(x=>!base.has(x.url)).length;
      }
    }
    // Count repeated card-like ancestor containers as well. This catches a sibling card
    // that has no ordinary <a href> at all (for example a button-only entry).
    let containerSelector=null, structuralContainerCount=0;
    if(arr.length>=3){
      const candidates=[];
      for(let level=1;level<=3;level++){
        const sels=arr.map(x=>{let el=x.el;for(let i=0;i<level&&el;i++)el=el.parentElement;return simpleElementSelector(el);});
        const d=dominantValue(sels);
        if(!d.value||d.count/arr.length<.8)continue;
        let count=0;try{count=contentRoot.querySelectorAll(d.value).length;}catch{}
        const upper=Math.max(arr.length+25,Math.ceil(arr.length*1.18));
        if(count>=arr.length&&count<=upper)candidates.push({selector:d.value,count,coverage:d.count/arr.length,level});
      }
      candidates.sort((a,b)=>Math.abs(a.count-arr.length)-Math.abs(b.count-arr.length)||a.level-b.level);
      if(candidates.length){containerSelector=candidates[0].selector;structuralContainerCount=candidates[0].count;}
    }
    return {expanded,repeatRatio,dominantStructuralKey:dom.value,structuralSiblingCount,structuralOutlierCount,containerSelector,structuralContainerCount};
  }
  function debugAnchorInventory(contentSelector="body"){
    const contentRoot=selectorFirst(contentSelector)||document.body||document;
    return [...document.querySelectorAll("a[href]")].map(a=>{
      const url=abs(a.getAttribute("href"));
      const region=a.closest("header")?"header":a.closest("footer")?"footer":a.closest('nav,[role="navigation"]')?"navigation":contentRoot.contains(a)?"content":"document";
      return {
        title:text(a),
        url:url?redactDebugUrl(url):null,
        visible:visible(a),
        sameOrigin:url?sameOrigin(url,location.origin):false,
        region,
        structuralKey:structuralKey(a,contentRoot)||null,
        elementSelector:simpleElementSelector(a),
        parentSelector:simpleElementSelector(a.parentElement)
      };
    });
  }
  function debugLinkFamilyInventory(contentSelector="body"){
    const contentRoot=selectorFirst(contentSelector)||document.body||document;
    const anchors=[...contentRoot.querySelectorAll("a[href]")];
    const groups=new Map();
    for(const a of anchors){
      const url=abs(a.getAttribute("href"));if(!url)continue;
      const key=pathFamilyKey(url)||"<no-family>";
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push({title:text(a),url:redactDebugUrl(url),visible:visible(a),sameOrigin:sameOrigin(url,location.origin),structuralKey:structuralKey(a,contentRoot)||null});
    }
    return [...groups].map(([key,items])=>({key,count:items.length,items})).sort((a,b)=>b.count-a.count);
  }
  function detectLinkFamilies(contentSelector="body"){
    const origin=location.origin, contentRoot=selectorFirst(contentSelector)||document.body||document;
    // Do not require current CSS visibility here. Modern SPAs frequently keep valid
    // catalog cards in collapsed/virtualized DOM containers. Repetition inside the
    // content region is a stronger signal than visibility. Header/footer links are
    // excluded; navigation blocks are scored separately via navigationRatio.
    let anchors=[...contentRoot.querySelectorAll("a[href]")].filter(a=>!a.closest('header,footer'));
    if(anchors.length<3&&contentRoot!==document.body){
      anchors=[...document.querySelectorAll("a[href]")].filter(a=>!a.closest('header,footer'));
    }
    const allRecords=[];
    for(const a of anchors){
      const url=abs(a.getAttribute("href")); if(!url)continue;
      if(url.split("#")[0]===location.href.split("#")[0])continue;
      const title=preferredLinkTitle(a)||text(a); if(!title)continue;
      allRecords.push({title,secondaryTitle:secondaryLinkContext(a,title),url,el:a,visible:visible(a),sameOrigin:sameOrigin(url,origin)});
    }
    const records=allRecords.filter(x=>x.sameOrigin);
    const by=new Map();
    for(const rec of records){const key=pathFamilyKey(rec.url);if(!key)continue;if(!by.has(key))by.set(key,[]);by.get(key).push(rec);}
    const hint=currentPageHint(), candidates=[];
    for(const [key,arr0] of by){
      // Preserve distinct visible entries even when multiple entries share one URL.
      const arr=uniqBy(arr0,x=>`${String(x.title||"").toLowerCase()}\u0000${x.url}`); if(arr.length<3)continue;
      const pattern=pathTemplate(arr[0].url); if(!pattern)continue;
      const uniqueTitles=new Set(arr.map(x=>x.title.toLowerCase())).size;
      if(uniqueTitles<Math.min(3,arr.length))continue;
      const navCount=arr.filter(x=>x.el.closest('header,footer,nav,[role="navigation"]')).length;
      const navRatio=navCount/arr.length;
      const visibleRatio=arr.filter(x=>x.visible).length/arr.length;
      const expansion=structuralExpansion(arr,allRecords,contentRoot);
      const expandedAll=uniqBy(expansion.expanded,x=>`${String(x.title||"").toLowerCase()}\u0000${x.url}`);
      const expandedSameOrigin=expandedAll.filter(x=>x.sameOrigin);
      const baseUrls=new Set(arr.map(x=>x.url));
      const outliers=expandedAll.filter(x=>!baseUrls.has(x.url));
      let prefix="",depth=0;try{const u=new URL(arr[0].url);prefix=queryIdentity(u)?u.pathname:u.pathname.split("/").slice(0,-1).join("/")||"/";depth=u.pathname.split("/").filter(Boolean).length;}catch{}
      let type=hint==="collection"?"collection":hint==="glossary"?"catalog":hint==="section"?(arr.length>=8||expansion.repeatRatio>=.75?"catalog":"section"):"catalog";
      if(navRatio>.6)type="section";
      let confidence=.36+Math.log2(arr.length+1)*.085+(type===hint?.12:0)+Math.min(.16,expansion.repeatRatio*.16)-navRatio*.34;
      // Hidden-but-structurally-repeated content is common in accordions and SPA
      // virtualization. Never punish it merely for being collapsed at scan time.
      if(visibleRatio===0 && expansion.repeatRatio>=.75 && navRatio<.4) confidence+=.06;
      if(prefix==="/")confidence-=.12;
      if(depth>=2)confidence+=.04;
      if(outliers.length>0&&outliers.length<=3)confidence+=.01;
      confidence=Math.max(.18,Math.min(.98,confidence));
      const structuralTotal=Math.max(expandedAll.length,expansion.structuralContainerCount||0);
      const unlinkedStructuralItems=Math.max(0,structuralTotal-expandedAll.length);
      const urlGroups=new Map();
      for(const x of expandedSameOrigin){if(!urlGroups.has(x.url))urlGroups.set(x.url,[]);urlGroups.get(x.url).push(x);}
      const duplicateUrlGroups=[...urlGroups.entries()].filter(([,xs])=>xs.length>1).map(([url,xs])=>({url,count:xs.length,titles:xs.map(x=>x.title)}));
      const titleGroups=new Map();
      for(const x of expandedSameOrigin){const k=String(x.title||"").trim().toLocaleLowerCase();if(!k)continue;if(!titleGroups.has(k))titleGroups.set(k,[]);titleGroups.get(k).push(x);}
      const duplicateTitleGroups=[...titleGroups.values()].filter(xs=>xs.length>1).map(xs=>({title:xs[0].title,count:xs.length,entries:xs.map(x=>({title:x.title,secondaryTitle:x.secondaryTitle||null,url:x.url}))}));
      const uniqueTargetCount=urlGroups.size;
      const duplicateEntryCount=Math.max(0,expandedSameOrigin.length-uniqueTargetCount);
      candidates.push({
        kind:type,
        label:`${type[0].toUpperCase()+type.slice(1)}: ${prefix}`,
        confidence,
        itemCount:type==='catalog'?uniqueTargetCount:(structuralTotal||arr.length),
        usableItemCount:expandedSameOrigin.length,
        uniqueTargetCount,
        duplicateEntryCount,
        duplicateUrlGroups,
        duplicateTitleGroups,
        familyMatchCount:arr.length,
        itemUrlPatterns:[pattern],
        samples:expandedAll.map(x=>({title:x.title,secondaryTitle:x.secondaryTitle||null,url:x.url})),
        targets:expandedSameOrigin.map(x=>({title:x.title,secondaryTitle:x.secondaryTitle||null,url:x.url})),
        detectedTargets:expandedAll.map(x=>({title:x.title,secondaryTitle:x.secondaryTitle||null,url:x.url,sameOrigin:x.sameOrigin,structuralOutlier:!baseUrls.has(x.url)})),
        structuralOnlyCount:unlinkedStructuralItems,
        scopeSelector:contentSelector,
        metrics:{
          navigationRatio:navRatio,
          visibleRatio,
          structuralRepeatRatio:expansion.repeatRatio,
          pathDepth:depth,
          familyMatchCount:arr.length,
          uniqueTargetCount,
          duplicateEntryCount,
          duplicateTitleGroupCount:duplicateTitleGroups.length,
          structuralSiblingCount:expansion.structuralSiblingCount,
          structuralOutlierCount:expansion.structuralOutlierCount,
          structuralContainerSelector:expansion.containerSelector,
          structuralContainerCount:expansion.structuralContainerCount,
          unlinkedStructuralItems
        },
        outliers:outliers.map(x=>({title:x.title,url:x.url,sameOrigin:x.sameOrigin})),
        rationale:`${arr.length} same-origin collection/list entries share one URL family inside ${contentSelector}${visibleRatio===0?`; entries are currently collapsed/hidden but structurally repeated`:""}${duplicateEntryCount?`; ${duplicateEntryCount} duplicate entry/entries point to an already known target`:""}${structuralTotal>arr.length?`; ${structuralTotal-arr.length} additional structurally matching item(s) detected`:""}.`
      });
    }
    candidates.sort((a,b)=>b.confidence-a.confidence||b.itemCount-a.itemCount);
    return candidates;
  }
  function detectNavigationCandidates(contentSelector="body"){
    const blocks=[],root=selectorFirst(contentSelector)||document.body||document;
    for(const el of root.querySelectorAll("nav,aside,[role='navigation'],[class*='toc' i],[id*='toc' i],[class*='sidebar' i]")){
      if(!visible(el)||el.closest('header,footer'))continue;
      const links=uniqBy([...el.querySelectorAll("a[href]")].map(linkRecord).filter(x=>x&&sameOrigin(x.url,location.origin)&&x.url.split("#")[0]!==location.href.split("#")[0]),x=>x.url);
      if(links.length<3)continue;
      const selector=uniqueSelector(el); if(!selector)continue;
      const tocHint=/toc|table.?of.?contents|contents|sidebar|index|navigation/i.test(`${selector} ${el.getAttribute('aria-label')||''}`);
      blocks.push({kind:"section",label:`Navigation: ${text(el).slice(0,60)||selector}`,confidence:Math.min(.94,.48+links.length/140+(tocHint?.18:0)),itemCount:links.length,navigationSelector:`${selector} a[href]`,scopeSelector:contentSelector,samples:links,targets:links,detectedTargets:links.map(x=>({...x,sameOrigin:true})),rationale:`Navigation block with ${links.length} internal links inside ${contentSelector}.`});
    }
    return blocks.sort((a,b)=>b.confidence-a.confidence||b.itemCount-a.itemCount);
  }
  function detectContentSelector(){
    const choices=["main","article","[role='main']","#main","#content","#main-content",".main-content"];
    for(const sel of choices){const el=document.querySelector(sel);if(el&&visible(el)&&text(el).length>200)return sel;}
    return "body";
  }
  function autoDiscoverItems(source){
    if(source.itemLinkSelector)return discoverLinks(source,'items');
    // A glossary is content on the page itself. Its inline links are references
    // inside definitions, not child/detail items to crawl. Pagination can still
    // advance through nextUrl independently while returning no glossary items.
    if(source.type==="glossary")return [];
    const scope=source.contentSelector||detectContentSelector();
    const families=detectLinkFamilies(scope).filter(c=>Array.isArray(c.targets)&&c.targets.length);
    let candidates=families;
    if(source.type==="collection")candidates=families.filter(c=>c.kind==="collection").concat(families.filter(c=>c.kind!=="collection"));
    else if(source.type==="catalog")candidates=families.filter(c=>c.kind==="catalog").concat(families.filter(c=>c.kind!=="catalog"));
    const best=candidates.sort((a,b)=>b.itemCount-a.itemCount||b.confidence-a.confidence)[0];
    if(!best)return [];
    const anchors=new Map();
    for(const a of document.querySelectorAll('a[href]')){
      if(!anchors.has(a.href))anchors.set(a.href,[]);
      anchors.get(a.href).push(a);
    }
    return best.targets.map(item=>{
      const links=(anchors.get(item.url)||[]).map(linkRecord).filter(Boolean);
      return {...item,title:LWLPresentation.chooseTitle([item.title,...links.map(x=>x.title)],item.url),cover:links.find(x=>x.cover)?.cover||null};
    });
  }
  function compactCatalogText(el){ return String(el?.innerText||el?.textContent||"").replace(/\s+/g," ").trim(); }
  const GENERIC_META_SKIP=/^(item|row|card|col|cell|list|grid|flex|container|wrapper|inner|outer|content|body|main|block|details|info|meta|summary|description|byline|select2|sr-only|screen-reader|visually-hidden|tooltip|icon|is-|has-|js-|ui-|b-|p-|_)/i;
  function genericMetaKey(el){
    const classes=String(el.className?.baseVal??el.className??"").split(/\s+/).filter(Boolean);
    for(const c of classes){
      if(/^[a-z][a-z0-9-]{2,28}$/i.test(c)&&!GENERIC_META_SKIP.test(c))return c.toLowerCase();
    }
    return null;
  }
  /* Reads short, classed values out of one list row. Deliberately shallow and
     capped: this feeds a facet builder that can throw away what is useless, so
     over-collecting costs nothing while missing a field costs a filter. */
  function genericCardMeta(box,item){
    const out={},title=String(item?.title||"").trim().toLowerCase();
    let seen=0;
    for(const el of box.querySelectorAll("[class]")){
      if(seen>=12)break;
      if(el.querySelector("[class]"))continue;            // only leaves carry values
      const key=genericMetaKey(el); if(!key||out[key])continue;
      const value=metaValue(compactCatalogText(el));
      if(!value||value.length>60)continue;
      if(value.toLowerCase()===title)continue;            // that is the entry name, not a field
      out[key]=value; seen++;
    }
    return out;
  }
  function catalogIdentityUrl(raw){
    try{const u=new URL(raw,location.href);u.hash="";return u.href;}catch{return String(raw||"");}
  }
  /* What a list row says of its entry, by the profile's card fields. */
  function cardMetaOf(box,fields){
    const cardMeta={};
    for(const f of (fields||[])){
      try{
        const nodes=[...(box?.querySelectorAll(f.selector)||[])];
        if(f.presence){cardMeta[f.key]=nodes.length?'true':String(f.defaultValue??'false');continue;}
        if(!nodes.length&&f.defaultValue!=null){cardMeta[f.key]=String(f.defaultValue);continue;}
        const vals=nodes.map(n=>f.attr?n.getAttribute(f.attr):compactCatalogText(n)).map(metaValue).filter(Boolean);
        if(!vals.length)continue;
        cardMeta[f.key]=f.multiple?[...new Set(vals.flatMap(v=>v.split(/\s*,\s*/)).map(metaValue).filter(Boolean))]:vals[0];
      }catch{}
    }
    return cardMeta;
  }
  function catalogContainerForAnchor(a,source){
    if(!a)return null;
    if(source?.catalogView?.rowSelector){try{const row=a.closest(source.catalogView.rowSelector);if(row)return row;}catch{}}
    let best=a.parentElement||a;
    if(source?.itemContainerSelector){
      try{const hit=a.parentElement?.closest?.(source.itemContainerSelector)||a.closest?.(source.itemContainerSelector);if(hit)best=hit;}catch{}
    }
    const target=catalogIdentityUrl(abs(a.getAttribute?.('href'))||a.href||'');
    const contentRoot=selectorFirst(source?.contentSelector)||document.body||document;
    let cur=best;
    // Walk outward until the next ancestor would contain more than one distinct
    // catalog target. This finds the whole row/card instead of stopping at a tiny
    // title span such as `.name` or `.list-row-name-primary-text`.
    for(let i=0;cur&&i<8;i++){
      const parent=cur.parentElement;if(!parent||parent===contentRoot||parent.matches?.('main,article,[role="main"]'))break;
      const urls=new Set();
      for(const link of parent.querySelectorAll?.('a[href]')||[]){
        const u=catalogIdentityUrl(abs(link.getAttribute('href')));if(!u)continue;
        if(source?.itemUrlPatterns?.length){if(matches(u,source.itemUrlPatterns))urls.add(u);}else if(u===target)urls.add(u);
        if(urls.size>1)break;
      }
      if(urls.size>1)break;
      const len=compactCatalogText(parent).length;
      if(len>0&&len<32000)best=parent;
      cur=parent;
    }
    return best;
  }
  function safeCatalogHtml(el){
    if(!el)return"";
    const clone=el.cloneNode(true);
    clone.querySelectorAll('script,style,noscript,template,iframe,object,embed,canvas,svg,picture,video,audio,source').forEach(x=>x.remove());
    for(const img of [...clone.querySelectorAll('img')]){const alt=String(img.getAttribute('alt')||'').trim();if(alt){const span=document.createElement('span');span.textContent=alt;img.replaceWith(span);}else img.remove();}
    clone.querySelectorAll('form,input,select,textarea').forEach(x=>x.remove());
    for(const b of [...clone.querySelectorAll('button,[role="button"]')]){const span=document.createElement('span');span.textContent=compactCatalogText(b);b.replaceWith(span);}
    for(const a of clone.querySelectorAll('a[href]')){a.removeAttribute('href');a.removeAttribute('target');a.removeAttribute('rel');}
    for(const el2 of clone.querySelectorAll('*')){
      for(const attr of [...el2.attributes]){
        const n=attr.name.toLowerCase();
        if(n.startsWith('on')||n==='style'||n==='srcdoc'||n==='integrity'||n==='nonce')el2.removeAttribute(attr.name);
      }
    }
    return String(clone.innerHTML||"").slice(0,24000);
  }
  function catalogTokens(el){
    const out=new Set();
    const push=v=>{v=String(v||"").replace(/\s+/g," ").trim();if(v&&v.length<=120)out.add(v);};
    if(!el)return[];
    for(const n of el.querySelectorAll('th,td,dt,dd,small,strong,b,[aria-label],[title],[class]')){
      push(n.getAttribute?.('aria-label'));push(n.getAttribute?.('title'));
      const t=compactCatalogText(n); if(t&&t.split(/\s+/).length<=12)push(t);
      for(const attr of [...(n.attributes||[])])if(attr.name.startsWith('data-')&&attr.value.length<=120)push(attr.value);
      if(out.size>=160)break;
    }
    return [...out];
  }
  function catalogFilterDefinitions(contentSelector){
    return detectControls(contentSelector).filter(c=>['select','checkbox','radio','pressed'].includes(c.type)).map(c=>({
      label:c.label||c.selector||'Filter',type:c.type,selector:c.selector||null,name:c.name||null,multiple:Boolean(c.multiple),
      options:c.type==='select'?(c.options||[]).map(o=>({label:String(o.label||o.value||''),value:String(o.value??''),selected:Boolean(o.selected),disabled:Boolean(o.disabled)})):[],
      checked:['checkbox','radio','pressed'].includes(c.type)?Boolean(c.checked):undefined
    }));
  }
  async function expandCatalogCards(source,items){
    if(source?.expandCards===false)return 0;
    const wanted=new Set((items||[]).map(x=>catalogIdentityUrl(x.url)));
    const containers=new Set();
    const root=selectorFirst(source?.contentSelector)||document.body||document;
    for(const a of root.querySelectorAll('a[href]')){
      const u=catalogIdentityUrl(abs(a.getAttribute('href')));if(!wanted.has(u))continue;
      const box=catalogContainerForAnchor(a,source);if(box)containers.add(box);
    }
    let clicked=0;
    const cap=Number(source?.expandLimit)>0?Number(source.expandLimit):120;
    for(const box of [...containers].slice(0,cap)){
      if(source?.expandSelector){
        const own=box.matches?.(source.expandSelector)?box:box.querySelector(source.expandSelector);
        if(own&&visible(own)){ try{own.click();clicked++;await sleep(25);}catch{} continue; }
      }
      let controls=[...box.querySelectorAll('button[aria-expanded="false"],[role="button"][aria-expanded="false"]')].filter(visible);
      if(!controls.length){
        controls=[...box.querySelectorAll('button,[role="button"]')].filter(x=>visible(x)&&/(details?|more|expand|show|open|anzeigen|mehr|aufklapp)/i.test(`${compactCatalogText(x)} ${x.getAttribute?.('aria-label')||''} ${x.className||''}`));
      }
      const ctl=controls.find(x=>!x.closest('form,[role="search"],[class*="filter" i],nav,[role="navigation"]'));
      if(!ctl)continue;
      try{ctl.click();clicked++;await sleep(25);}catch{}
    }
    if(clicked)await waitForDomQuiet(root,180,1800);
    return clicked;
  }
  function catalogSnapshotItems(source,items){
    const root=selectorFirst(source?.contentSelector)||document.body||document;
    const anchors=[...root.querySelectorAll('a[href]')];
    const byUrl=new Map();
    for(const a of anchors){
      const raw=abs(a.getAttribute('href'));if(!raw)continue;
      const u=catalogIdentityUrl(raw);if(!byUrl.has(u))byUrl.set(u,[]);byUrl.get(u).push(a);
    }
    const out=[];
    for(let item of items||[]){
      const u=catalogIdentityUrl(item.url);
      let matches=byUrl.get(u)||[];
      if(source.catalogView?.rowSelector)matches=matches.filter(a=>a.closest(source.catalogView.rowSelector)&&(!source.catalogView.expandedRowSelector||!a.closest(source.catalogView.expandedRowSelector)));
      if(source.itemLinkSelector){try{const titles=matches.filter(a=>a.matches(source.itemLinkSelector));if(titles.length)matches=titles;}catch{}}
      let best=null,bestLen=-1;
      for(const a of matches){const box=catalogContainerForAnchor(a,source);const len=compactCatalogText(box).length;if(box&&len>bestLen){best=box;bestLen=len;}}
      const summary=compactCatalogText(best);
      if(/^(?:view\s+)?details(?:\s+page)?$|^read more$|^mehr erfahren$/i.test(item.title||'')){
        const heading=best?.querySelector('h1,h2,h3,h4,[class*="title" i],[class*="name" i],[class*="header" i]');
        const title=compactCatalogText(heading);if(title&&title.length<=180)item={...item,title};
      }
      const cardMeta=cardMetaOf(best,source?.cardMetaFields);
      /* No configured cardMetaFields means no filters at all in the reader, and
         that is the common case for a profile the detector built. Harvest the
         row generically instead: every classed descendant that holds a short
         piece of text becomes a candidate field, keyed by its class. The page
         determines the field names. The reader's facet builder discards anything
         useless - a key needs between 2 and 60 distinct values to become a
         filter, so constants and free text drop out by themselves. */
      if(!Object.keys(cardMeta).length&&best) Object.assign(cardMeta,genericCardMeta(best,item));
      const columns=best?.tagName==='TR'?[...best.querySelectorAll(':scope > th,:scope > td')].map(compactCatalogText).filter(Boolean):[];
      let rowHtml=null,panelHtml=null,rowGroup=0;
      if(source.catalogView && best){
        const row=best.cloneNode(true),view=source.catalogView;
        const stateNode=view.rowStateSelector?row.querySelector(view.rowStateSelector):row;
        if(view.rowExpandedClass)stateNode?.classList.remove(view.rowExpandedClass);
        if(view.expandedRowSelector)row.querySelectorAll(view.expandedRowSelector).forEach(el=>el.remove());
        if(view.rowToggleSelector)for(const indicator of row.querySelectorAll(view.rowToggleSelector)){
          if(view.indicatorOpenClass)indicator.classList.remove(view.indicatorOpenClass);
          if(view.indicatorClosedClass)indicator.classList.add(view.indicatorClosedClass);
        }
        rowHtml=sanitizeArticle(row,{...source,captureMode:'page'},{fragment:true}).html;
        const panel=view.panelPlacement==='inside'?best.querySelector(view.expandedRowSelector):best.nextElementSibling;
        if(view.expandedRowSelector && panel?.matches(view.expandedRowSelector))panelHtml=sanitizeArticle(panel,{...source,captureMode:'page'},{fragment:true}).html;
        if(view.listSelector)rowGroup=Math.max(0,[...document.querySelectorAll(view.listSelector)].indexOf(best.closest(view.listSelector)));
      }
      out.push({...item,url:u,summaryText:summary.slice(0,8000),cardHtml:safeCatalogHtml(best),rowHtml,panelHtml,rowGroup,columns,tokens:catalogTokens(best),meta:cardMeta});
    }
    return out;
  }
  async function extractCatalogPage(source){
    await applyFilters(source.filters);
    if(!source.catalogView && !source.probeFilter){
      const inferred=inferCatalogView(source);
      if(inferred)source={...source,catalogView:inferred.catalogView,pageSelector:source.pageSelector||inferred.pageSelector};
    }
    const auto=source.discoveryMode==='auto';
    let items=auto?autoDiscoverItems(source):discoverLinks(source,'items');
    const itemsLimited=items.length>(source.maxItems||5000);
    items=items.slice(0,source.maxItems||5000);
    let catalog=null;
    if(source.captureCatalogLayout && source.catalogView){
      await prepareOfflineCapture();
      const mount=catalogListMount(source);
      const listSelector=source.catalogView.listSelector || (mount?uniqueSelector(mount.parent):null);
      if(listSelector&&document.querySelector(listSelector))catalog={version:1,url:location.href,html:sanitizeArticle(document.body,{...source,captureMode:'page'},{catalogControls:source.catalogView.controlsSelector}).html,
        presentation:pagePresentation({...source,captureMode:'page'}),config:{...source.catalogView,listSelector},groupCount:document.querySelectorAll(listSelector).length,pageSize:Math.max(1,items.length)};
    }
    const expandedCount=await expandCatalogCards(source,items);
    if(source.catalogView?.expandedRowSelector && expandedCount){
      const deadline=Date.now()+2500;
      while(Date.now()<deadline && document.querySelectorAll(source.catalogView.expandedRowSelector).length<expandedCount)await sleep(100);
      await waitForDomQuiet(selectorFirst(source.contentSelector)||document.body,220,2200);
    }
    // Expanded descriptions contain citations to other entries. They enrich the
    // original rows but must not change this page's catalog membership.
    const snapshots=catalogSnapshotItems(source,items);
    let pageNumber=1;try{pageNumber=Number(new URL(location.href).searchParams.get(source?.pagination?.pageParam||'page')||1)||1;}catch{}
    const pagination=detectPagination();
    if(catalog)catalog.styles=await collectCatalogStyles(source.catalogView);
    return {ok:true,items:snapshots,itemsLimited,catalog,nextUrl:autoNextLink(source.pagination),title:document.title,url:location.href,pageNumber,expandedCount,filterDefinitions:catalogFilterDefinitions(source.catalogView?.controlsSelector||source.contentSelector),filterState:scanDebugFilterState(source.probeFilter?[source.probeFilter]:[]),pagination};
  }

  function collectCatalogStyles(view={}){
    return collectPageStyles(12000000,view.styleKeepPatterns||[],[
      ...(view.filterBindings||[]).map(b=>b.selectedClass),view.rowExpandedClass,
      ...(view.cycleControls||[]).flatMap(c=>Object.values(c.classes||{})),
      view.indicatorOpenClass,view.indicatorClosedClass,view.advancedOpenClass,
      view.advancedHiddenClass,view.groupClosedClass,view.groupHeaderClosedClass
    ]);
  }

  function catalogListMount(source){
    const root=selectorFirst(source?.contentSelector)||document.body||document;
    const items=source?.discoveryMode==='auto'?autoDiscoverItems(source):discoverLinks(source,'items');
    const groups=new Map(),anchors=[...root.querySelectorAll('a[href]')];
    for(const item of items.slice(0,50)){
      const u=catalogIdentityUrl(item.url);
      for(const a of anchors.filter(x=>catalogIdentityUrl(abs(x.getAttribute('href')))===u)){
      const box=catalogContainerForAnchor(a,source);const parent=box?.parentElement;
      if(!box||!parent)continue;
      // Navigation may repeat the same links before the actual cards. A row
      // must describe one catalog identity, not a whole header of item links.
      const targets=new Set([...box.querySelectorAll('a[href]')].map(x=>catalogIdentityUrl(abs(x.getAttribute('href')))).filter(url=>source.itemUrlPatterns?.length?matches(url,source.itemUrlPatterns):items.some(item=>catalogIdentityUrl(item.url)===url)));
      if(targets.size!==1)continue;
      const g=groups.get(parent)||{parent,boxes:[]};if(!g.boxes.includes(box))g.boxes.push(box);groups.set(parent,g);
      }
    }
    const best=[...groups.values()].sort((a,b)=>b.boxes.length-a.boxes.length)[0];
    if(!best||best.boxes.length<2)return null;
    const classes=[...best.parent.classList];
    const row=best.boxes[0],rowClasses=[...row.classList].filter(c=>best.boxes.every(box=>box.classList.contains(c)));
    const known=new Set(items.map(item=>catalogIdentityUrl(item.url)));
    const mounts=classes.length?[...root.querySelectorAll(best.parent.tagName.toLowerCase()+classes.map(c=>'.'+cssEscapeIdent(c)).join(''))].map(parent=>({parent,boxes:[...parent.children].filter(box=>box.tagName===row.tagName&&rowClasses.every(c=>box.classList.contains(c))&&[...box.querySelectorAll('a[href]')].some(a=>known.has(catalogIdentityUrl(abs(a.getAttribute('href'))))))})).filter(g=>g.boxes.length):[best];
    return {...best,mounts};
  }
  // Learn repeated markup and its controls from the page. Profiles keep the
  // resulting selectors as data; no origin-specific renderer is needed.
  function inferCatalogView(source){
    const mount=catalogListMount(source);if(!mount)return null;
    const parents=mount.mounts.map(m=>m.parent),selectors=parents.map(uniqueSelector);
    const listSelector=selectors.join(', ');
    const first=mount.boxes[0];
    const classes=[...first.classList].filter(c=>mount.boxes.every(el=>el.classList.contains(c)));
    const rowSelector=selectors.map(selector=>selector+' > '+first.tagName.toLowerCase()+classes.map(c=>'.'+cssEscapeIdent(c)).join('')).join(', ');
    let region=mount.parent;
    while(region.parentElement&&!parents.every(parent=>region.contains(parent)))region=region.parentElement;
    while(region.parentElement && region.parentElement!==document.body && !region.querySelector('h1'))region=region.parentElement;
    const forms=[...region.querySelectorAll('form')].sort((a,b)=>b.querySelectorAll('select,input[name]').length-a.querySelectorAll('select,input[name]').length);
    const form=forms[0];
    const search=form?.querySelector('input[type="search"],input[name*="search" i],input[name="q"]');
    const pager=detectPagination();
    const next=selectorFirst(pager.selector);
    const paging=next?.closest('ul,ol,[role="navigation"],nav');
    const catalogView={listSelector,rowSelector,controlsSelector:form?uniqueSelector(form):null,
      searchSelector:search?uniqueSelector(search):null,
      submitSelector:form?uniqueSelector(form)+' [type="submit"]':null,
      resetSelector:form?uniqueSelector(form)+' [type="reset"]':null,
      paginationSelector:paging?uniqueSelector(paging):null,sortSelector:'[data-sort-by],[data-sort]',
      filterBindings:[],styleKeepPatterns:['(?:^|,\\s*)[.#]select2']};
    return {catalogView,pageSelector:uniqueSelector(region)};
  }
  function redactDebugUrl(raw){
    try {
      const u=new URL(raw,location.href);
      const sensitive=/(token|auth|session|sid|secret|password|passwd|key|signature|sig|jwt|cookie|csrf|xsrf|oauth|code)/i;
      for(const key of [...u.searchParams.keys()]) if(sensitive.test(key)) u.searchParams.set(key,"<redacted>");
      u.hash="";
      return u.href;
    } catch { return String(raw||""); }
  }
  function debugControl(c){
    const out={label:c.label,type:c.type,selector:c.selector,suggested:Boolean(c.suggested),hidden:Boolean(c.hidden)};
    if(c.type==="checkbox"||c.type==="radio"||c.type==="pressed") out.checked=Boolean(c.checked);
    else if(c.type==="select") {
      out.value=c.value;
      out.multiple=Boolean(c.multiple);
      out.options=(c.options||[]);
    } else if(c.value) out.value="<redacted-user-input>";
    return out;
  }
  function debugSuggestion(c){
    return {
      id:c.id,
      kind:c.kind,
      label:c.label,
      confidence:c.confidence,
      itemCount:c.itemCount,
      usableItemCount:c.usableItemCount??null,
      uniqueTargetCount:c.uniqueTargetCount??null,
      duplicateEntryCount:c.duplicateEntryCount??0,
      duplicateUrlGroups:(c.duplicateUrlGroups||[]).map(g=>({url:g.url?redactDebugUrl(g.url):null,count:g.count,titles:g.titles||[]})),
      duplicateTitleGroups:(c.duplicateTitleGroups||[]).map(g=>({title:g.title||"",count:g.count||0,entries:(g.entries||[]).map(x=>({title:x.title||"",secondaryTitle:x.secondaryTitle||null,url:x.url?redactDebugUrl(x.url):null}))})),
      familyMatchCount:c.familyMatchCount??null,
      structuralOnlyCount:c.structuralOnlyCount??0,
      navigationSelector:c.navigationSelector||null,
      itemUrlPatterns:c.itemUrlPatterns||[],
      pageUrlPatterns:c.pageUrlPatterns||[],
      termSelector:c.termSelector||null,
      definitionSelector:c.definitionSelector||null,
      rationale:c.rationale||null,
      scopeSelector:c.scopeSelector||null,
      metrics:c.metrics||null,
      samples:(c.samples||[]).map(x=>typeof x==="string"?x:{title:x.title||"",secondaryTitle:x.secondaryTitle||null,url:redactDebugUrl(x.url)}),
      targets:(c.targets||[]).map(x=>({title:x.title||"",secondaryTitle:x.secondaryTitle||null,url:redactDebugUrl(x.url)})),
      detectedTargets:(c.detectedTargets||c.targets||[]).map(x=>({title:x.title||"",secondaryTitle:x.secondaryTitle||null,url:x.url?redactDebugUrl(x.url):null,sameOrigin:x.sameOrigin!==false,structuralOutlier:Boolean(x.structuralOutlier)})),
      outliers:(c.outliers||[]).map(x=>({title:x.title||"",url:x.url?redactDebugUrl(x.url):null,sameOrigin:x.sameOrigin!==false}))
    };
  }
  function buildDetectionDiagnostics(contentSelector,controls,pagination,suggestions){
    const anchors=[...document.querySelectorAll("a[href]")];
    const visibleAnchors=anchors.filter(visible);
    const sameOriginAnchors=visibleAnchors.filter(a=>{try{return new URL(a.href,location.href).origin===location.origin;}catch{return false;}});
    return {
      reportVersion:3,
      pageLanguage:document.documentElement.lang||null,
      contentSelector,
      viewport:{width:innerWidth,height:innerHeight,devicePixelRatio:devicePixelRatio||1},
      documentStats:{
        domElements:document.querySelectorAll("*").length,
        anchors:anchors.length,
        visibleAnchors:visibleAnchors.length,
        visibleSameOriginAnchors:sameOriginAnchors.length,
        headings:document.querySelectorAll("h1,h2,h3,h4,h5,h6").length,
        navigationBlocks:document.querySelectorAll("nav,aside,[role='navigation']").length,
        lists:document.querySelectorAll("ul,ol,dl").length,
        tables:document.querySelectorAll("table").length,
        forms:document.querySelectorAll("form").length,
        glossaryTerms:document.querySelectorAll("dt").length,
        glossaryDefinitions:document.querySelectorAll("dd").length,
        images:document.querySelectorAll("img").length,
        iframes:document.querySelectorAll("iframe").length
      },
      regionStats:{
        mainAnchors:(selectorFirst(contentSelector)||document.body||document).querySelectorAll?.("a[href]").length||0,
        headerAnchors:document.querySelectorAll("header a[href]").length,
        footerAnchors:document.querySelectorAll("footer a[href]").length,
        navigationAnchors:document.querySelectorAll("nav a[href],[role='navigation'] a[href]").length
      },
      pagination:{...pagination,nextUrl:pagination?.nextUrl?redactDebugUrl(pagination.nextUrl):null},
      controls:controls.map(debugControl),
      suggestions:suggestions.map(debugSuggestion),
      anchorInventory:debugAnchorInventory(contentSelector),
      linkFamilyInventory:debugLinkFamilyInventory(contentSelector),
      privacy:{
        pageBodyIncluded:false,
        cookiesIncluded:false,
        storageIncluded:false,
        passwordValuesIncluded:false,
        textInputValuesIncluded:false,
        note:"URLs and visible link titles/selectors are included for detection debugging. Sensitive-looking URL parameters are redacted."
      }
    };
  }
  function detectPageStructure(){
    const suggestions=[];
    const contentSelector=detectContentSelector();
    const gl=detectGlossaryCandidate(contentSelector); if(gl)suggestions.push(gl);
    suggestions.push(...detectLinkFamilies(contentSelector),...detectNavigationCandidates(contentSelector));
    if(!suggestions.length){
      suggestions.push({kind:"section",label:"Section below this page",confidence:.45,itemCount:(selectorFirst(contentSelector)||document).querySelectorAll("a[href]").length,pageUrlPatterns:[],samples:[],scopeSelector:contentSelector,rationale:"No strong repeating list was detected; recursive section crawling is the safest fallback."});
    }
    const controls=detectControls(contentSelector), pagination=detectPagination();
    const numberedSuggestions=suggestions.map((x,i)=>{
      const view=x.kind==='catalog'?inferCatalogView({type:'catalog',discoveryMode:'configured',contentSelector,itemUrlPatterns:x.itemUrlPatterns||[],itemContainerSelector:x.metrics?.structuralContainerSelector}):null;
      return {...x,...(view||{}),id:`candidate-${i+1}`};
    });
    numberedSuggestions.sort((a,b)=>Number(Boolean(b.catalogView))-Number(Boolean(a.catalogView))||b.confidence-a.confidence);
    const diagnostics=buildDetectionDiagnostics(contentSelector,controls,pagination,numberedSuggestions);
    return {ok:true,page:{title:document.title,url:location.href,origin:location.origin,path:location.pathname},contentSelector,controls,filterDefinitions:catalogFilterDefinitions(contentSelector),pagination,suggestions:numberedSuggestions,diagnostics};
  }

  /* ---------------------------------------------------------------------
     Rich detail capture: turns a content page into sanitized, portable HTML
     plus structured metadata for local navigation, search and presentation.
     --------------------------------------------------------------------- */

  // Wrappers/widgets that are never part of the content the user paid for.
  const JUNK_TOKEN=/(^|[-_ ])(comment|comments|commenting|forum|forums|disqus|reply|replies|share|sharing|social|newsletter|subscribe|signup|cookie|consent|gdpr|advert|advertisement|adsense|adslot|sponsor|promo|upsell|paywall|related-?posts?|recommend\w*|more-?like|breadcrumbs?|pagination|pager|site-?header|site-?footer|global-?nav|nav-?menu|navbar|user-?menu|account-?menu|profile-?menu|chat|intercom|zendesk|drift|livechat|helpshift|skip-?link|back-?to-?top|scroll-?top|toolbar|print-?button|feedback|rating|votes?|reactions?|tooltip-?host)([-_ ]|$)/i;
  const JUNK_SELECTORS=[
    "script","style","noscript","template","iframe","object","embed","canvas","form","input","textarea","select",
    "[role='navigation']","[role='banner']","[role='contentinfo']","[role='search']",
    "[aria-hidden='true']","[hidden]","link","meta"
  ];
  // Attributes worth carrying into the offline copy; everything else is dropped.
  const KEEP_ATTRS=new Set(["class","id","name","style","width","height","role","aria-label","open","colspan","rowspan","alt","title","datetime","start","reversed","type","value","dir","lang"]);
  const BLOCK_KEEP=/^(P|DIV|SECTION|ARTICLE|MAIN|ASIDE|HEADER|FOOTER|H1|H2|H3|H4|H5|H6|UL|OL|LI|DL|DT|DD|TABLE|THEAD|TBODY|TFOOT|TR|TH|TD|CAPTION|BLOCKQUOTE|PRE|CODE|FIGURE|FIGCAPTION|IMG|A|EM|STRONG|B|I|U|S|SUP|SUB|BR|HR|SPAN|SMALL|MARK|ABBR|CITE|Q|KBD|VAR|SAMP|DFN|TIME|PICTURE|SOURCE|DETAILS|SUMMARY|SVG|G|PATH|USE|DEFS|SYMBOL|RECT|CIRCLE|LINE|POLYLINE|POLYGON|TITLE|DESC)$/;

  // Sites print a dash where a field has no value; that is not data.
  const META_PLACEHOLDER=/^(?:[-\u2010-\u2015\u2212\s]+|n\/?a|null)$/i;
  function metaValue(raw){
    const v=String(raw??"").replace(/\s+/g," ").trim();
    return (!v||META_PLACEHOLDER.test(v))?"":v;
  }

  function junkyNode(el,keepRe){
    if(!el||el.nodeType!==1)return false;
    const idc=`${el.getAttribute?.("id")||""} ${el.getAttribute?.("class")||""}`;
    if(keepRe&&keepRe.test(idc))return false;
    if(JUNK_TOKEN.test(idc))return true;
    // Only <nav> is junk by tag alone. <aside>, <header> and <footer> inside a
    // content region routinely hold real material, including article sidebars
    // and source citations. Site chrome is caught by JUNK_TOKEN instead.
    if(el.tagName==="NAV")return true;
    return false;
  }

  /* Produce clean article HTML. Internal links become data-lwl-href so the
     reader can rewrite them to local routes; images become data-lwl-src so the
     builder can download and re-point them. */
  function sanitizeArticle(root,source,{fragment=false,catalogControls=null}={}){
    if(!root)return{html:"",images:[],links:[]};
    const captureUrl=source?.captureUrl||pageHref();
    const abs=raw=>{try{return new URL(raw,captureUrl).href;}catch{return null;}};
    const fullPage=source?.captureMode === "page";
    if(fullPage&&!fragment){
      root=source?.pageSelector?selectorFirst(source.pageSelector):pageDoc().body;
      if(!root)throw new Error('Page capture region not found: '+source.pageSelector);
    }
    const clone=root.cloneNode(true);
    if(catalogControls){
      const originals=[...root.querySelectorAll('input,select')];
      [...clone.querySelectorAll('input,select')].forEach((el,i)=>{
        const original=originals[i];
        if(el.tagName==='SELECT')for(let j=0;j<el.options.length;j++)el.options[j].toggleAttribute('selected',Boolean(original.options[j].selected));
        else {el.setAttribute('value',original.value);el.toggleAttribute('checked',original.checked);}
      });
    }
    const originalImages=[...root.querySelectorAll("img")];
    const imageSources=new Map([...clone.querySelectorAll("img")].map((img,i)=>[img,originalImages[i]]));
    clone.setAttribute("data-lwl-article-root", "");
    const keepRe=source?.keepPattern?safeRegex(source.keepPattern):null;
    const passiveDrop=["script","style","noscript","template","iframe","object","embed","canvas","textarea","link","meta",...(catalogControls?[]:["form","input"])];
    const drop=[...(fullPage?passiveDrop:JUNK_SELECTORS),...(source?.excludeSelectors||[]),...(source?.detailExcludeSelectors||[])];
    for(const sel of drop){ try{clone.querySelectorAll(sel).forEach(n=>n.remove());}catch{} }
    if(catalogControls)for(const el of clone.querySelectorAll('form,input,select,button')){
      if(!el.closest(catalogControls) && el.matches('form,input,select'))el.remove();
      else if(el.tagName==='INPUT'&&!/^(text|search|number|checkbox|radio|button|submit|reset)$/.test(el.type))el.remove();
    }
    for(const el of [...clone.querySelectorAll("*")]) if(!fullPage && junkyNode(el,keepRe)) el.remove();
    LWLPresentation.clean(clone,{controlsSelector:catalogControls,listSelector:source?.catalogView?.listSelector,paginationSelector:source?.catalogView?.paginationSelector});
    // Only URL-valued selects represent offline navigation. Catalog filters are
    // handled by the library's filter model, never replayed against the network.
    for(const select of clone.querySelectorAll("select")) {
      if(catalogControls && select.closest(catalogControls))continue;
      const values=[...select.options].map(o=>o.value).filter(Boolean);
      if(!values.length || !values.every(v=>/^(#|\/|\.\.?\/|https?:\/\/)/i.test(v))) {select.remove();continue;}
      select.setAttribute("data-lwl-navigation","");
      for(const option of select.options)if(option.value)option.value=abs(option.value)||"";
    }

    const images=[],links=[];
    for(const a of [...clone.querySelectorAll("a")]){
      const preview=source?.previewSelector&&a.matches(source.previewSelector);
      if(preview)a.setAttribute('data-lwl-preview','original');
      else a.removeAttribute('data-lwl-preview');
      const raw=a.getAttribute("href");
      const full=raw?abs(raw):null;
      a.removeAttribute("href");
      for(const n of ["target","rel","onclick","data-tooltip-href"]) a.removeAttribute(n);
      if(!full||!/^https?:/i.test(full)){ if(a.id || a.name) continue; unwrap(a); continue; }
      if(sameOrigin(full,new URL(captureUrl).origin)){ a.setAttribute("data-lwl-href",full); links.push({url:full,title:compactCatalogText(a),kind:preview?'preview':'link'}); }
      else { a.setAttribute("href",full); a.setAttribute("target","_blank"); a.setAttribute("rel","noopener"); }
    }
    // Use the resolved image chosen by the live renderer, including lazy and
    // responsive pictures. Repeated illustrations are intentional page content.
    const clones = [...clone.querySelectorAll("img")];
    for (const img of clones) {
      const original=imageSources.get(img);
      // Nonvisual tracking pixels are not page artwork and must not be replayed.
      if((original?.naturalWidth===1 && original?.naturalHeight===1) || (img.style.width && img.style.height && parseFloat(img.style.width)<=1 && parseFloat(img.style.height)<=1) || (img.hasAttribute("width") && img.hasAttribute("height") && Number(img.getAttribute("width"))<=1 && Number(img.getAttribute("height"))<=1)) {img.remove();continue;}
      const raw = original?.currentSrc || img.getAttribute("data-src") || img.getAttribute("src") || (img.getAttribute("srcset") || "").split(/\s|,/)[0];
      const full = raw ? abs(raw) : null;
      for (const name of ["src", "srcset", "data-src", "data-srcset", "loading"]) img.removeAttribute(name);
      if (!full || !/^(https?:|data:image\/)/i.test(full)) { img.remove(); continue; }
      if (/^data:/i.test(full)) img.setAttribute("src", full);
      else { img.setAttribute("data-lwl-src", full); images.push(full); }
    }
    // The chosen img is sufficient; a remote source srcset must not override it.
    clone.querySelectorAll("picture source").forEach(el => el.remove());
    for (const el of [clone, ...clone.querySelectorAll("*")]) {
      if (!BLOCK_KEEP.test(el.tagName.toUpperCase()) && !(fullPage && /^(NAV|BUTTON|SELECT|OPTION|OPTGROUP|LABEL)$/.test(el.tagName)) && !(catalogControls && /^(FORM|INPUT)$/.test(el.tagName)) && el !== clone) { unwrap(el); continue; }
      for (const attr of [...el.attributes]) {
        const n = attr.name.toLowerCase();
        if (n === "data-lwl-href" || n === "data-lwl-src" || n === "data-lwl-article-root" || n === "data-lwl-navigation" || n === "data-lwl-preview") continue;
        if(fullPage && (/^aria-/.test(n) || /^(hidden|tabindex|disabled|selected)$/.test(n)))continue;
        if(catalogControls && /^(checked|multiple|placeholder|for|data-count|data-sort-by|data-sort)$/.test(n))continue;
        if (el.tagName === "A" && ["href", "target", "rel"].includes(n)) continue;
        if (el.tagName === "IMG" && n === "src" && /^data:image\//i.test(attr.value)) continue;
        if (el.namespaceURI === "http://www.w3.org/2000/svg" && /^(viewbox|d|fill|fill-rule|clip-rule|opacity|fill-opacity|stroke|stroke-width|stroke-linecap|stroke-linejoin|x|y|x1|x2|y1|y2|cx|cy|r|points|transform|xmlns)$/.test(n)) continue;
        if (el.namespaceURI === "http://www.w3.org/2000/svg" && /^(href|xlink:href)$/.test(n) && attr.value.startsWith("#")) continue;
        if (KEEP_ATTRS.has(n) || /^data-(theme|page|layout|book|source|content)(-|$)/.test(n)) continue;
        el.removeAttribute(attr.name);
      }
      if (el.hasAttribute("style")) {
        const style = el.getAttribute("style").replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, (all, q, raw) => {
          const full = abs(raw.trim());
          return full && /^(https?:|data:image\/)/i.test(full) ? `url("${full}")` : "none";
        });
        el.setAttribute("style", style);
      }
    }
    let wrapped = clone;
    const page=root.ownerDocument||pageDoc();
    for (let parent = fragment?null:root.parentElement; parent && parent !== page.body && parent !== page.documentElement; parent = parent.parentElement) {
      const shell = page.createElement(parent.tagName);
      for (const [key, value] of Object.entries(presentationAttributes(parent))) shell.setAttribute(key, value);
      shell.appendChild(wrapped); wrapped = shell;
    }
    return {html: String(fullPage&&!fragment&&root===page.body?clone.innerHTML:wrapped.outerHTML || "").trim(), images: uniq(images), links: uniqBy(links, x => x.url)};
  }

  function unwrap(el){ const p=el.parentNode; if(!p)return; while(el.firstChild)p.insertBefore(el.firstChild,el); p.removeChild(el); }
  function uniq(arr){ return [...new Set(arr)]; }
  function safeRegex(src){ try{return new RegExp(src,"i");}catch{return null;} }

  /* Metadata: profile-configured fields first, then generic definition lists. */
  function extractDetailMeta(root,source){
    const meta={};
    const put=(k,v)=>{ const val=metaValue(v); if(k&&val&&!meta[k])meta[k]=val; };
    for(const f of (source?.metaFields||[])){
      try{
        const nodes=[...root.querySelectorAll(f.selector)];
        if(f.presence){meta[f.key]=nodes.length?'true':String(f.defaultValue??'false');continue;}
        if(!nodes.length&&f.defaultValue!=null){meta[f.key]=String(f.defaultValue);continue;}
        if(!nodes.length)continue;
        const vals=nodes.map(n=>f.attr?n.getAttribute(f.attr):compactCatalogText(n)).map(metaValue).filter(Boolean);
        if(!vals.length)continue;
        meta[f.key]=f.multiple?uniq(vals):vals[0];
      }catch{}
    }
    // Generic field/value markup, independent of the field label or website.
    for(const lab of root.querySelectorAll('[class*="label"]')){
      const box=lab.parentElement; if(!box)continue;
      let val=lab.nextElementSibling;
      if(!val||!/value|data/.test(val.className||''))val=box.querySelector('[class*="value"],[class*="data"]');
      if(!val||val===lab||lab.contains(val)||val.contains(lab))continue;
      const key=compactCatalogText(lab).replace(/[:：]\s*$/,"");
      if(key&&key.length<=40)put(metaKeyFor(key),compactCatalogText(val));
    }
    for(const dl of root.querySelectorAll("dl")){
      const kids=[...dl.children];
      for(let i=0;i<kids.length-1;i++){
        if(kids[i].tagName!=="DT")continue;
        const dd=kids[i+1]; if(dd?.tagName!=="DD")continue;
        const key=compactCatalogText(kids[i]).replace(/[:：]\s*$/,"");
        if(key&&key.length<=40)put(metaKeyFor(key),compactCatalogText(dd));
      }
    }
    return meta;
  }

  function metaKeyFor(label){
    return String(label||"").normalize("NFKC").toLocaleLowerCase().trim()
      .replace(/[^\p{L}\p{N}_-]+/gu,"-").replace(/^-+|-+$/g,"").slice(0,32);
  }

  const ARTICLE_JUNK=/comment|discussion|forum|reply|sidebar|related|recommend|promo|advert|marketplace|subscribe|social|share|breadcrumb/i;

  /* Finds the container that holds the article and nothing else.

     Falling back to the profile's contentSelector was wrong for a detail page:
     that selector describes the LIST page, so on a captured item it selected
     the whole main column - measured on a live item page, 5986 characters and
     15 images where the article is 1188 characters and one image, which is how
     the same picture ended up in a capture twice.

     Pure text density is no good either: the comment thread scored highest of
     all. So candidates that sit under discussion, related or promotional markup
     are excluded, anything larger than 60% of the page is rejected as "not a
     part but the whole", and among the containers that hold the same text the
     deepest one wins - the tightest boundary around the same article. */
  function pickArticleRoot(scope){
    const length=el=>String(el.innerText||"").replace(/\s+/g," ").trim().length;
    const total=length(scope);
    if(!total)return null;
    const junk=el=>{
      let n=el;
      while(n&&n!==scope){
        if(ARTICLE_JUNK.test(String(n.className?.baseVal??n.className??"")+" "+(n.id||"")))return true;
        n=n.parentElement;
      }
      return false;
    };
    const depth=el=>{let d=0,n=el;while(n&&n!==scope){d++;n=n.parentElement;}return d;};
    // A semantic article can legitimately contain almost all page text. The
    // old 60% limit discarded it and selected a single long table or subsection.
    const articles=[...(scope.matches?.('article,[role="article"],[itemprop="articleBody"]')?[scope]:[]),...scope.querySelectorAll('article,[role="article"],[itemprop="articleBody"]')].filter(el=>length(el)>=100&&!junk(el));
    if(articles.length)return articles.sort((a,b)=>length(b)-length(a)||depth(b)-depth(a))[0];
    const candidates=[...scope.querySelectorAll("div,section,article")]
      .filter(el=>{const t=length(el);return t>=200&&t<=total*0.6&&!junk(el);});
    if(!candidates.length)return null;
    const longest=Math.max(...candidates.map(length));
    return candidates.filter(el=>length(el)>=longest*0.95).sort((a,b)=>depth(b)-depth(a))[0]||null;
  }

  function detailRoot(source){
    const explicit=selectorFirst(source?.detailSelector);
    if(explicit)return explicit;
    if(source?.detailSelector)throw Error('Selected content region was not found: '+source.detailSelector);
    const page=pageDoc(),scope=page.querySelector("[role='main']")||page.querySelector("main")||page.body;
    return pickArticleRoot(scope)||page.querySelector("main article")||page.querySelector("article")
      ||selectorFirst(source?.contentSelector)||scope;
  }

  async function extractDetailPage(source){
    source={...source,pageSelector:source?.detailPageSelector||source?.pageSelector};
    checkAvailability(source);
    await applyFilters(source?.detailFilters||[]);
    await prepareOfflineCapture();
    if(source?.detailExpandSelector)await clickAll(source.detailExpandSelector);
    const detail=detailOf(source);
    if(!source.appExport){detail.styles=await collectPageStyles();detail.theme=collectPageTheme();}
    return {ok:true,detail};
  }
  function detailOf(source){
    const root=detailRoot(source);
    const {html,images,links}=sanitizeArticle(root,source);
    const saved=document.createElement('div');saved.innerHTML=html;
    const headings=[...saved.querySelectorAll("h2,h3,h4")].map(h=>({level:Number(h.tagName[1]),text:compactCatalogText(h)})).filter(h=>h.text);
    const plain=String(saved.textContent||"").replace(/\s+/g," ").trim();
    return {
      url:pageHref(),
      title:pageTitle(saved,source),
      related:source.relatedLinkSelector?selectorAll(source.relatedLinkSelector).map(a=>({url:abs(a.getAttribute('href')),title:preferredLinkTitle(a)})).filter(x=>x.url&&matches(x.url,source.relatedUrlPatterns||[])):[],
      html,images,links,headings,presentation:pagePresentation(source),styles:{warnings:[]},theme:null,captureVersion:5,contentBoundaryVersion:2,captureRules:source.captureRules,
      meta:{...genericDetailMeta(root,text(pageDoc().querySelector('h1'))),...extractDetailMeta(root,source)},
      text:plain.slice(0,120000),
      characterCount:plain.length
    };
  }

  function extractDetailLayout(source){
    checkAvailability(source);
    const root=detailRoot(source),rootSelector=uniqueSelector(root);
    const captured=sanitizeArticle(root,{...source,captureMode:'page'});
    const template=document.createElement('template');template.innerHTML=captured.html;
    const content=template.content.querySelector(rootSelector);
    const title=template.content.querySelector('h1');
    if(!content||!title||content.contains(title))return {ok:false,error:'No separate article layout found'};
    const kept=new Set([content,title]);const images=[];
    // Retain an outside illustration only when it is also present inside the
    // article. Its source can then be recovered from each saved article; never
    // copy the sample page's picture to unrelated entries.
    for(const original of content.querySelectorAll('img[data-lwl-src]')){
      const selector='img'+[...original.classList].map(c=>'.'+cssEscapeIdent(c)).join('');
      if(content.querySelectorAll(selector).length!==1)continue;
      for(const image of template.content.querySelectorAll('img[data-lwl-src]')){
        if(content.contains(image)||image.getAttribute('data-lwl-src')!==original.getAttribute('data-lwl-src'))continue;
        const id=String(images.length);images.push({id,selector});
        image.setAttribute('data-lwl-layout-image',id);image.removeAttribute('data-lwl-src');image.removeAttribute('alt');image.removeAttribute('title');kept.add(image);
      }
    }
    content.replaceChildren();content.setAttribute('data-lwl-layout-content','');
    title.replaceChildren();title.setAttribute('data-lwl-layout-title','');
    const ancestors=new Set();for(const el of kept)for(let p=el.parentElement;p;p=p.parentElement)ancestors.add(p);
    for(const el of [...template.content.querySelectorAll('*')].reverse()){
      if(!kept.has(el)&&!ancestors.has(el)){el.remove();continue;}
      for(const child of [...el.childNodes])if(child.nodeType!==1)child.remove();
      // Structural shells retain layout attributes, never sample links,
      // account data or sample-specific inline backgrounds.
      for(const attr of [...el.attributes])if(!/^(id|class|role|dir|lang|data-lwl-layout-(content|title|image))$/.test(attr.name))el.removeAttribute(attr.name);
    }
    return {ok:true,layout:{version:1,html:template.innerHTML,images}};
  }

  async function clickAll(selector,limit=40){
    let n=0;
    for(const el of [...document.querySelectorAll(selector)].slice(0,limit)){
      if(!visible(el))continue;
      try{el.click();n++;await sleep(40);}catch{}
    }
    if(n)await waitForDomQuiet(document.body,200,2500);
    return n;
  }

  function pageOf(source){
    const articleRoot=detailRoot(source);
    const page=extractPage(source,articleRoot);
    const glossary=glossaryEntriesFromPage(source,page);
    const article=sanitizeArticle(articleRoot,source);
    page.html=article.html; page.images=article.images; page.links=article.links; page.meta=extractDetailMeta(articleRoot,source);
    page.presentation=pagePresentation(source); page.styles={warnings:[]}; page.theme=null; page.captureVersion=5;page.contentBoundaryVersion=2;page.captureRules=source.captureRules;
    return {ok:true,page,glossary};
  }
  /* Reads a page fetched without a tab, as the tab would for an export: the
     site's HTML as served, parsed, never run. Nothing waits for scripts,
     pictures or scrolling — what is read comes as served. */
  function read(html,url,message){
    const source={...message.source,appExport:true};
    reading={doc:new DOMParser().parseFromString(html,'text/html'),url};
    try{
      if(message.type==='EXTRACT_DETAIL'){
        const detailSource={...source,pageSelector:source.detailPageSelector||source.pageSelector};
        checkAvailability(detailSource);
        return {ok:true,detail:detailOf(detailSource)};
      }
      if(message.type==='EXTRACT_PAGE'){checkAvailability(source);return pageOf(source);}
      throw Error('Not read without a tab: '+message.type);
    }finally{reading=null;}
  }

  // The extension's offscreen document uses the same sanitizer for declared
  // HTML preview endpoints. It never executes the downloaded site's scripts.
  globalThis.LWLContentCapture=Object.freeze({sanitizeArticle,extractDetailMeta,read});
  if(location.protocol==='chrome-extension:')return;
  chrome.runtime.onMessage.addListener((msg,_sender,sendResponse)=>{
    if(String(msg?.type||'').startsWith('LWL_GUIDED_'))return false;
    (async()=>{
      const source=msg?.source || {};
      if(msg?.type==="APPLY_FILTERS") { await applyFilters(source.filters); return {ok:true}; }
      if(msg?.type==="EXTRACT_CATALOG_PAGE") return await extractCatalogPage(source);
      if(msg?.type==="EXTRACT_DETAIL") return await extractDetailPage(source);
      if(msg?.type==="EXTRACT_DETAIL_LAYOUT") return extractDetailLayout(source);
      if(msg?.type==="DISCOVER_SOURCE") {
        const scanCtx=msg?.scanDebug||null;
        await persistDiscoverLive(scanCtx,"handler:start");
        const perfNow=()=>Number(performance.now().toFixed(2));
        const started=perfNow();
        const debug={
          startedAt:new Date().toISOString(),
          stages:[{stage:"handler:start",at:new Date().toISOString()}],
          source:{type:source.type||null,discoveryMode:source.discoveryMode||null,contentSelector:source.contentSelector||null,filterCount:(source.filters||[]).length},
          pageBefore:scanDebugPageStats(source),
          filtersBefore:scanDebugFilterState(source.filters)
        };
        let t=perfNow();
        await persistDiscoverLive(scanCtx,"applyFilters:start",{pageStats:debug.pageBefore,filters:debug.filtersBefore});
        await applyFilters(source.filters);
        debug.applyFiltersMs=Number((perfNow()-t).toFixed(2));debug.stages.push({stage:"applyFilters:done",at:new Date().toISOString(),ms:debug.applyFiltersMs});
        debug.pageAfterFilters=scanDebugPageStats(source);
        debug.filtersAfter=scanDebugFilterState(source.filters);
        await persistDiscoverLive(scanCtx,"applyFilters:done",{applyFiltersMs:debug.applyFiltersMs,pageStats:debug.pageAfterFilters,filters:debug.filtersAfter});
        if(source.providerId&&source.type==='collection')await prepareOfflineCapture();
        const auto = source.discoveryMode === "auto";
        t=perfNow();
        await persistDiscoverLive(scanCtx,"discovery:start",{auto});
        const items = auto ? autoDiscoverItems(source) : discoverLinks(source,"items");
        debug.discoveryMs=Number((perfNow()-t).toFixed(2));debug.stages.push({stage:"discovery:done",at:new Date().toISOString(),ms:debug.discoveryMs,itemCount:(items||[]).length});
        await persistDiscoverLive(scanCtx,"discovery:done",{auto,discoveryMs:debug.discoveryMs,itemCount:(items||[]).length});
        t=perfNow();
        await persistDiscoverLive(scanCtx,"nextLink:start",{itemCount:(items||[]).length});
        const nextUrl=autoNextLink(source.pagination);
        debug.nextLinkMs=Number((perfNow()-t).toFixed(2));debug.stages.push({stage:"nextLink:done",at:new Date().toISOString(),ms:debug.nextLinkMs});
        debug.itemCount=(items||[]).length;
        debug.totalMs=Number((perfNow()-started).toFixed(2));
        debug.finishedAt=new Date().toISOString();debug.stages.push({stage:"handler:done",at:debug.finishedAt,totalMs:debug.totalMs});
        await persistDiscoverLive(scanCtx,"handler:done",{itemCount:debug.itemCount,nextUrl:nextUrl||null,totalMs:debug.totalMs});
        return {ok:true,items,nextUrl,title:document.title,url:location.href,autoDetected:auto,_debug:debug};
      }
      if(msg?.type==="DISCOVER_NAVIGATION") {
        await applyFilters(source.filters);
        return {ok:true,pages:discoverLinks(source,"pages"),title:document.title,url:location.href};
      }
      if(msg?.type==="DISCOVER_SECTION_LINKS") return {ok:true,links:discoverLinks({...source,itemLinkSelector:source.navigationSelector||source.itemLinkSelector,itemUrlPatterns:source.pageUrlPatterns||source.itemUrlPatterns,itemExcludePatterns:source.pageExcludePatterns||source.itemExcludePatterns},"items")};
      if(msg?.type==="EXTRACT_PAGE") {
        checkAvailability(source);
        await prepareOfflineCapture();
        const result=pageOf(source);
        if(!source.appExport){result.page.styles=await collectPageStyles();result.page.theme=collectPageTheme();}
        return result;
      }
      if(msg?.type==="EXTRACT_PAGE_STYLES") return {ok:true,...(await collectCatalogStyles(msg.source?.catalogView)),theme:collectPageTheme()};
      if(msg?.type==="PREPARE_OFFLINE_CAPTURE") return {ok:true,info:await prepareOfflineCapture()};
      if(msg?.type==="DETECT_PAGE_STRUCTURE") return detectPageStructure();
      return {ok:false,error:"Unknown Local Web Library message"};
    })().then(sendResponse).catch(e=>sendResponse({ok:false,error:String(e?.message||e)}));
    return true;
  });
})();
