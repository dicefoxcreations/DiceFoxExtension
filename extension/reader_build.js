/* Local Web Library – reader v4 builder.

   Emits a self-contained static application under Reader/:

     index.html            copy of reader/shell.html
     app.css, app.js       copy of reader/*
     data/index.js         window.LWL_LIBRARY – sources, facets, entry metadata
     data/content-NNN.js   sanitized article HTML, loaded on demand
     data/previews-*.js    bounded chunks of row previews, loaded when expanded
     data/fts.js           inverted full-text index, loaded on first full search
     assets/<hash>.<ext>   images referenced by the captured articles

   Data travels through <script> tags rather than fetch() because a page opened
   from file:// cannot fetch sibling files. */
(() => {
  "use strict";

  const CHUNK_BYTES = 420000;   // ~400 KiB of article HTML per content chunk
  const MAX_FTS_POSTINGS = 4000; // drop terms that match nearly everything
  const MIN_TOKEN = 3;

  const enc = (obj) =>
    JSON.stringify(obj).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

  function tokenize(text) {
    return String(text || "")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .match(/[a-z0-9äöüß]{3,}/g) || [];
  }

  /* ---------- assets ---------- */

  const EXT_BY_TYPE = {
    "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif",
    "font/woff2": "woff2", "font/woff": "woff", "font/ttf": "ttf", "font/otf": "otf",
    "image/webp": "webp", "image/svg+xml": "svg", "image/avif": "avif",
  };

  function assetExt(url, contentType) {
    const byType = EXT_BY_TYPE[String(contentType || "").split(";")[0].trim().toLowerCase()];
    if (byType) return byType;
    const m = /\.([a-z0-9]{2,5})(?:$|\?)/i.exec(String(url || ""));
    return m ? m[1].toLowerCase() : "img";
  }

  /* Downloads every referenced image once and returns url -> relative path. */
  function resourceCredentials(url, ctx) {
    return new URL(url, ctx.profile.origin).origin === new URL(ctx.profile.origin).origin ? "include" : "omit";
  }
  async function fetchResource(url, ctx) {
    // Bound both connection setup and streaming bodies. A stalled image must
    // not keep the worker (or Stop) waiting indefinitely during a Reader build.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("Resource download timed out")), ctx.resourceTimeoutMs || 20000);
    const stopTimer = setInterval(() => { if (ctx.stopped()) controller.abort(new Error("Stopped")); }, 250);
    let reader;
    try {
      const response = await fetch(url, {credentials:resourceCredentials(url, ctx),signal:controller.signal});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const limit = ctx.maxAssetBytes || 6 * 1024 * 1024;
      if (Number(response.headers.get('content-length')) > limit) throw new Error('Resource exceeds size limit');
      reader = response.body.getReader();
      const parts = []; let size = 0;
      for (;;) {
        const {done,value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('Resource exceeds size limit');
        parts.push(value);
      }
      return new Blob(parts, {type:response.headers.get('content-type') || ''});
    } finally {
      clearTimeout(timeout); clearInterval(stopTimer);
      controller.abort();
      if (reader) reader.cancel().catch(() => {});
    }
  }
  async function collectAssets(urls, ctx) {
    const map = new Map();
    if (!ctx.assetsEnabled || !urls.length) { const all=[...new Set(urls)];ctx.assetReport = {requested:all.length,stored:0,missing:all.map(url=>({url,reason:"assets-disabled"}))}; return map; }
    const list = [...new Set(urls)].slice(0, ctx.maxAssets);
    let done = 0, failed = 0; const missing = [];
    let cursor=0;
    const worker=async()=>{while(cursor<list.length&&!ctx.stopped()){
      const url=list[cursor++];
      try {
        let blob = await ctx.getResource?.(url);
        const cached=Boolean(blob);
        if(!blob){
          blob = await fetchResource(url, ctx);
        }
        if (!blob.size || blob.size > ctx.maxAssetBytes) throw new Error(`size ${blob.size}`);
        if(!cached && ctx.cacheResource)try{await ctx.cacheResource(url,blob);}catch(error){ctx.log(`Resource cache: ${error.message||error}`);}
        const name = `${ctx.hash(url)}.${assetExt(url, blob.type)}`;
        await ctx.download(blob, `${ctx.root}/assets/${name}`);
        map.set(url, `assets/${name}`);
      } catch (e) {
        failed++; missing.push({url,reason:String(e.message||e)});
        if (failed <= 5) ctx.log(`Asset skipped (${e.message || e}): ${url}`);
      }
      if (++done % 25 === 0) ctx.status(`Assets ${done}/${list.length}`);
    }};
    await Promise.all(Array.from({length:Math.min(list.length,Math.max(1,Math.min(3,Number(ctx.assetParallelism)||1)))},worker));
    const reasons=new Map(missing.map(item=>[item.url,item.reason]));
    ctx.assetReport = {requested:new Set(urls).size,stored:map.size,missing:[...new Set(urls)].filter(url=>!map.has(url)).map(url=>({url,reason:reasons.get(url)||(ctx.stopped()?"stopped":"asset-limit")})),stopped:ctx.stopped()};
    if (failed) ctx.log(`${failed} asset(s) could not be stored; those images fall back to the online URL.`);
    return map;
  }

  /* ---------- html rewriting ---------- */

  /* Point images at their local copy and canonicalize internal link targets so
     the reader can map them onto entry ids. */
  function rewriteHtml(html, assetMap, canonical) {
    return rewriteCssAssets(String(html || ""), assetMap)
      .replace(/ data-lwl-src="([^"]*)"/g, (all, raw) => {
        const url = raw.replace(/&amp;/g, "&");
        const local = assetMap.get(url);
        return local ? ` src="${local}" loading="lazy"` : ` src="${raw}" loading="lazy"`;
      })
      .replace(/ data-lwl-href="([^"]*)"/g, (all, raw) => {
        const url = raw.replace(/&amp;/g, "&");
        const hash = (url.match(/#(.*)$/) || [])[1] || "";
        const base = canonical(url.replace(/#.*$/, ""));
        const target = hash ? `${base}#${hash}` : base;
        return ` data-lwl-href="${target.replace(/"/g, "&quot;")}"`;
      });
  }

  /* ---------- facets ---------- */

  /* A metadata key becomes a filter when it has a workable number of distinct
     values; free-text keys like a full description never qualify. */
  /* A citation like "Example Handbook, pg. 150" differs per entry, which would
     make thousands of one-hit filter values. Group by the work, not the page. */
  const facetValue = LWLReaderModel.facetValue;

  function buildFacets(entries, labels) {
    const counts = new Map();
    for (const e of entries) {
      for (const [k, v] of Object.entries(e.m || {})) {
        if (!counts.has(k)) counts.set(k, new Map());
        const bucket = counts.get(k);
        for (const one of Array.isArray(v) ? v : [v]) {
          const val = facetValue(one);
          if (!val || val.length > 60) continue;
          bucket.set(val, (bucket.get(val) || 0) + 1);
        }
      }
    }
    const facets = [];
    for (const [key, bucket] of counts) {
      if (bucket.size < 2 || bucket.size > 200) continue;
      const values = [...bucket.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v]) => v);
      facets.push({ key, label: labels[key] || { en: key, de: key }, values: values.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })) });
    }
    return facets;
  }

  const FACET_LABELS = {};

  const CSS_URL = /url\(\s*(&quot;|&#39;|['"]?)(https?:\/\/[^'"\)]+)\1\s*\)/gi;
  function cssAssetUrls(css) { return [...String(css || "").matchAll(CSS_URL)].map(m => m[2].replace(/&amp;/g, "&")); }
  function rewriteCssAssets(css, map) {
    return String(css || "").replace(CSS_URL, (all, quote, raw) => {
      const local = map.get(raw.replace(/&amp;/g, "&"));
      return local ? `url(${quote}${local}${quote})` : all;
    });
  }
  async function resolveCssImports(css, ctx, base, stack = []) {
    const imports = [...String(css).matchAll(/@import\s+(?:url\(\s*)?['"]([^'"]+)['"]\s*\)?([^;]*);/gi)];
    for (const match of imports) {
      let imported = "";
      try {
        const url = new URL(match[1], base).href;
        if (stack.includes(url) || stack.length >= 8) throw new Error("cyclic/deep CSS import");
        const cached=await ctx.getResource?.(url);
        if(cached)imported=await cached.text();
        else{
          const resource = await fetchResource(url, ctx);
          imported = await resource.text();
          if (ctx.cacheResource) await ctx.cacheResource(url, resource);
        }
        imported = imported.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi, (all, q, value) => /^(data:|#)/i.test(value) ? all : `url("${new URL(value, url).href}")`);
        imported = await resolveCssImports(imported, ctx, url, [...stack, url]);
        if (match[2].trim()) imported = `@media ${match[2].trim()}{${imported}}`;
      } catch (error) { ctx.styleWarnings.push(`CSS import unavailable: ${match[1]} (${error.message})`); }
      css = css.replace(match[0], imported);
    }
    return css;
  }
  function sourceFacets(entries, source) {
    const exact = (source.exactFilters || []).filter(f => f && typeof f === "object" && f.complete);
    const resolved = exact.map(f => ({key:f.key || LWLReaderModel.facetKey(f),label:f.label,multiple:f.multiple,exact:true,values:f.options.map(o=>o.value),options:f.options}));
    const inferred = buildFacets(entries, FACET_LABELS).filter(f => !resolved.some(x=>x.key===f.key));
    if (!(source.filterDefinitions || []).length) return [...resolved,...inferred];
    // Preserve site order and labels. Unresolved site controls are reported,
    // never replaced with a superficially similar but semantically wrong facet.
    return (source.filterDefinitions || []).map(f => resolved.find(x=>x.key===LWLReaderModel.facetKey(f))).filter(Boolean);
  }

  /* ---------- main ---------- */

  /* records: [{ id, url, sourceId, title, meta, html, text, order }]
     sources: [{ id, name, type, layout, group }] */
  async function build(records, sources, ctx) {
    const root = ctx.root;

    const bySource = new Map(sources.map((s) => [s.id, []]));
    for (const r of records) {
      if (!bySource.has(r.sourceId)) bySource.set(r.sourceId, []);
      bySource.get(r.sourceId).push(r);
    }

    ctx.styleWarnings = [...new Set([...records.flatMap(r=>r.captureWarnings||[]),...sources.flatMap(s=>s.catalog?.styles?.warnings||[])])];
    const styles = new Map();
    for(const source of sources) {
      if(source.catalog?.styles?.css)source.siteCss=source.catalog.styles.css;
      // Old captures can contain expanded HTML but only collapsed-page CSS.
      // Provider defaults also repair those saved catalogs during a local rebuild.
      if(source.catalog?.html && ctx.catalogCss)source.siteCss=ctx.catalogCss+'\n'+(source.siteCss||'');
    }
    for (const source of sources) if (source.siteCss) styles.set(ctx.hash(source.siteCss), source.siteCss);
    for (const record of records) {
      if (record.siteCss) styles.set(ctx.hash(record.siteCss), record.siteCss);
      else if (record.styleId && ctx.loadStyle && !styles.has(record.styleId)) styles.set(record.styleId, null);
    }
    // A large library has gigabytes of page-specific CSS. Keep identifiers and
    // load one sheet at a time for resource discovery and again for output.
    const readStyle = async (id, inline) => {
      const css = inline ?? await ctx.loadStyle(id);
      if (css == null) { ctx.styleWarnings.push(`Stored stylesheet unavailable: ${id}`); return ""; }
      return resolveCssImports(css, ctx, ctx.profile.origin);
    };
    const styleFor = (record, source) => record.siteCss ? ctx.hash(record.siteCss)
      : record.styleId && ctx.loadStyle ? record.styleId : source?.siteCss ? ctx.hash(source.siteCss) : null;
    ctx.status("Collecting images, fonts and backgrounds");
    const imageUrls = new Set(sources.map(s=>s.cover).filter(Boolean));
    const addCssAssets = css => { for (const url of cssAssetUrls(css)) imageUrls.add(url); };
    for (const html of [...records.flatMap(r=>[r.html,r.rowHtml,r.panelHtml]),...sources.map(s=>s.catalog?.html)]) {
      for (const m of String(html || "").matchAll(/ data-lwl-src="([^"]*)"/g)) imageUrls.add(m[1].replace(/&amp;/g, "&"));
      addCssAssets(html);
    }
    let scannedStyles=0;
    for (const [id, css] of styles) {
      if(ctx.stopped())break;
      const resolved=await readStyle(id,css);
      addCssAssets(resolved);
      // Inline source styles are already held by the caller; resolve their
      // imports once. Captured page styles remain lazy for the second pass.
      if(css!==null)styles.set(id,resolved);
      if(++scannedStyles%25===0)ctx.status(`Stylesheets ${scannedStyles}/${styles.size}`);
    }
    for (const record of [...records,...sources.map(s=>s.catalog).filter(Boolean)]) {
      addCssAssets(record.html);
      for (const attrs of Object.values(record.presentation || {})) addCssAssets(attrs?.style);
    }
    const assetMap = await collectAssets([...imageUrls], ctx);

    ctx.status("Building content chunks");
    let chunkCount = 0;
    let current = {}, currentBytes = 0;
    const entries = [];
    const flushContent = async () => {
      if (!Object.keys(current).length) return;
      await ctx.download(new Blob([`(window.LWL_CHUNKS=window.LWL_CHUNKS||{})[${chunkCount}]=${enc(current)};`],{type:"text/javascript"}),
        `${root}/data/content-${String(chunkCount).padStart(3,"0")}.js`);
      chunkCount++;current={};currentBytes=0;
    };

    for (const s of sources) {
      const list = bySource.get(s.id) || [];
      list.sort((a, b) =>
        s.layout === "book"
          ? (a.order ?? 0) - (b.order ?? 0)
          : String(a.title || "").localeCompare(String(b.title || ""), undefined, { numeric: true, sensitivity: "base" })
      );
      for (const r of list) {
        let chunkNo = null;
        const html = r.html ? rewriteHtml(r.html, assetMap, ctx.canonical) : "";
        if (html) {
          chunkNo = chunkCount;
          current[r.id] = html;
          currentBytes += html.length;
          if (currentBytes >= CHUNK_BYTES) {
            await flushContent();
          }
        }
        const meta = {};
        for (const [k, v] of Object.entries(r.meta || {})) {
          const val = Array.isArray(v) ? v.map(clean).filter(Boolean) : clean(v);
          if (val && val.length) meta[k] = val;
        }
        entries.push({
          id: r.id,
          t: r.title || r.url,
          s: s.id,
          u: r.url,
          a: r.aliases || [],
          css: styleFor(r,s),
          p: r.presentation ? {...r.presentation,...Object.fromEntries(["html","body"].map(key=>{const attrs=r.presentation[key]||{};return [key,{...attrs,...(attrs.style?{style:rewriteCssAssets(attrs.style,assetMap)}:{})}];}))} : null,
          f: r.filterValues || {},
          c: chunkNo,
          captureStatus: r.captureStatus || null,
          m: meta,
          x: clean(r.text || "").slice(0, 180) || undefined,
          o: r.order,
          k: [r.title, ...Object.values(meta).flat()].filter(Boolean).join(" ").toLowerCase(),
          _text: r.text || "",
        });
      }
    }
    await flushContent();

    ctx.status("Building search index");
    const terms = new Map();
    entries.forEach((e, i) => {
      const seen = new Set(tokenize(`${e.t} ${e._text}`));
      for (const term of seen) {
        if (term.length < MIN_TOKEN) continue;
        let posting = terms.get(term);
        if (!posting) terms.set(term, (posting = []));
        if(posting.length<=MAX_FTS_POSTINGS)posting.push(i);
      }
    });
    const ftsTerms = {};
    for (const [term, posting] of terms) if (posting.length <= MAX_FTS_POSTINGS) ftsTerms[term] = posting;
    for (const e of entries) delete e._text;

    const sourcesOut = sources.map((s) => {
      const list = bySource.get(s.id) || [];
      const facets = s.layout === "book" ? [] : sourceFacets(entries.filter((e) => e.s === s.id), s);
      return {
        id: s.id,
        name: s.name,
        cover: assetMap.get(s.cover) || null,
        url: s.url || null,
        type: s.type,
        layout: s.layout,
        catalog: s.catalog?.html ? ctx.hash(`catalog:${s.id}`) : null,
        articleLayout: s.articleLayout || null,
        badge: facets[0]?.key || null,
        count: list.length,
        facets,
        css: s.siteCss ? ctx.hash(s.siteCss) : null,   /* name of the site-<x>.js holding this source's own CSS */
        theme: s.siteTheme || list.find(r=>r.theme)?.theme || null,
        complete: s.complete !== false,
        unresolvedFilters: (s.filterDefinitions||[]).filter(f=>f.type === "select" && !facets.some(x=>x.key===LWLReaderModel.facetKey(f))).map(f=>f.label),               /* design tokens the reader adopts for this source */
      };
    });

    const groups = [];
    for (const s of sources) {
      const gid = s.group || "sections";
      let g = groups.find((x) => x.id === gid);
      if (!g) groups.push((g = { id: gid, label: GROUP_LABELS[gid] || { en: gid, de: gid }, sourceIds: [] }));
      g.sourceIds.push(s.id);
    }

    const library = {
      format: "local-web-library-reader",
      version: 5,
      generatedAt: new Date().toISOString(),
      profile: { id: ctx.profile.id, name: ctx.profile.name, origin: ctx.profile.origin, canonicalization:ctx.profile.canonicalization || {}, provider:ctx.profile.provider||null, referencePolicy:ctx.profile.referencePolicy||{}, presentationPolicy:ctx.profile.presentationPolicy||{} },
      groups,
      sources: sourcesOut,
      chunks: chunkCount,
      fts: Object.keys(ftsTerms).length > 0,
      assets: assetMap.size,
      entries,
      glossary: LWLReferences.glossaryEntries(records,sources),
      assetReport:ctx.assetReport,
      styleWarnings:ctx.styleWarnings,
    };

    ctx.status("Writing reader");
    const blob = (text, type) => new Blob([text], { type });

    for(const s of sources)if(s.catalog?.html){
      const id=ctx.hash(`catalog:${s.id}`),{styles,...catalog}=s.catalog;
      const presentation=catalog.presentation?{...catalog.presentation,...Object.fromEntries(['html','body'].map(key=>{const attrs=catalog.presentation[key]||{};return [key,{...attrs,...(attrs.style?{style:rewriteCssAssets(attrs.style,assetMap)}:{})}];}))}:null;
      const rows=[];let previewChunk={},previewSize=0,previewNo=0;
      const previewFile=()=>`data/previews-${id}-${String(previewNo).padStart(3,'0')}.js`;
      const flushPreviews=async()=>{
        if(!Object.keys(previewChunk).length)return;
        const file=previewFile();
        await ctx.download(blob(`(window.LWL_PREVIEWS=window.LWL_PREVIEWS||{})[${enc(file)}]=${enc(previewChunk)};`,'text/javascript'),`${root}/${file}`);
        previewChunk={};previewSize=0;previewNo++;
      };
      for(const r of bySource.get(s.id)||[]){
        const panel=rewriteHtml(r.panelHtml,assetMap,ctx.canonical);
        const row={id:r.id,order:r.order??0,group:r.rowGroup||0,html:rewriteHtml(r.rowHtml,assetMap,ctx.canonical)};
        if(panel){
          if(previewSize&&previewSize+panel.length>CHUNK_BYTES)await flushPreviews();
          row.panelRef=previewFile();previewChunk[r.id]=panel;previewSize+=panel.length;
        }
        rows.push(row);
      }
      await flushPreviews();
      const data={...catalog,presentation,html:rewriteHtml(catalog.html,assetMap,ctx.canonical),rows};
      await ctx.download(blob(`(window.LWL_CATALOGS=window.LWL_CATALOGS||{})[${enc(id)}]=${enc(data)};`,"text/javascript"),`${root}/data/catalog-${id}.js`);
    }
    await ctx.download(blob(`window.LWL_LIBRARY=${enc(library)};`, "text/javascript"), `${root}/data/index.js`);
    if (library.fts) await ctx.download(blob(`window.LWL_FTS=${enc({ t: ftsTerms })};`, "text/javascript"), `${root}/data/fts.js`);

    for (const [id, css] of styles) {
      if(ctx.stopped())break;
      await ctx.download(blob(`(window.LWL_SITECSS=window.LWL_SITECSS||{})[${enc(id)}]=${enc(rewriteCssAssets(await readStyle(id,css),assetMap))};`, "text/javascript"), `${root}/data/site-${id}.js`);
    }
    await ctx.download(blob(JSON.stringify({assets:ctx.assetReport,styles:ctx.styleWarnings},null,2),"application/json"),`${root}/capture-report.json`);

    for (const [src, dest] of [["reader/presentation.js", "presentation.js"], ["reader/model.js", "model.js"], ["reader/references.js", "references.js"], ["reader/catalog.js", "catalog.js"], ["reader/shell.html", "index.html"], ["reader/app.css", "app.css"], ["reader/app.js", "app.js"]]) {
      const text = await (await fetch(chrome.runtime.getURL(src))).text();
      await ctx.download(blob(text, dest.endsWith(".css") ? "text/css" : dest.endsWith(".js") ? "text/javascript" : "text/html"), `${root}/${dest}`);
    }

    return {
      complete: !ctx.stopped() && !ctx.assetReport.missing.length && !ctx.styleWarnings.length,
      entryCount: entries.length,
      withContent: entries.filter((e) => e.c !== null).length,
      chunkCount,
      assetCount: assetMap.size,
      termCount: Object.keys(ftsTerms).length,
    };
  }

  const GROUP_LABELS = {
    library: { en: "My Library", de: "Meine Bibliothek" },
    compendium: { en: "Compendium", de: "Kompendium" },
    sections: { en: "Sections", de: "Bereiche" },
  };

  globalThis.LWLReaderBuild = Object.freeze({ build, rewriteHtml, buildFacets, sourceFacets, tokenize, cssAssetUrls, rewriteCssAssets });
})();
