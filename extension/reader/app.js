/* Local Web Library – offline reader application.
   Runs from file:// with no network access. Data arrives through <script> tags
   (data/index.js eagerly, data/content-*.js and data/fts.js on demand) because
   fetch() of local files is blocked by the file:// origin rules. */
(() => {
  "use strict";

  const DB = window.LWL_LIBRARY;
  const Model = window.LWLReaderModel;
  let renderVersion = 0, disposeArticle = () => {};
  const app = document.getElementById("app");
  const nav = document.getElementById("nav");
  const main = document.getElementById("main");
  const qInput = document.getElementById("q");

  if (!DB || !Array.isArray(DB.entries)) {
    main.innerHTML = '<div class="empty"><h2>No library data</h2><p>data/index.js is missing or empty.</p></div>';
    return;
  }

  /* ---------------- i18n ---------------- */
  const DE = String(navigator.language || "").toLowerCase().startsWith("de");
  const t = (en, de) => (DE ? de : en);
  const T = {
    search: t("Search the library …", "Bibliothek durchsuchen …"),
    overview: t("Overview", "Übersicht"),
    all: t("All", "Alle"),
    entries: t("entries", "Einträge"),
    results: t("results", "Treffer"),
    noResults: t("No matches", "Keine Treffer"),
    noResultsHint: t("Try a different term or clear the filters.", "Anderer Suchbegriff oder Filter zurücksetzen."),
    titles: t("Titles", "Titel"),
    fullText: t("Full text", "Volltext"),
    loadMore: t("Show more", "Mehr anzeigen"),
    contents: t("Contents", "Inhalt"),
    online: t("View online", "Original online"),
    prev: t("Previous", "Zurück"),
    next: t("Next", "Weiter"),
    noContent: t("No content stored", "Kein Inhalt gespeichert"),
    noContentHint: t(
      "This entry was indexed but its page content was not captured. Use “Fetch missing or outdated pages” in the extension or sync this source again. Opening an entry in the offline Reader does not download its content.",
      "Dieser Eintrag ist indexiert, aber der Seiteninhalt wurde nicht erfasst. Nutze „Fehlende oder veraltete Seiten nachladen“ in der Erweiterung oder synchronisiere diese Quelle erneut. Das Öffnen im Offline-Reader lädt keine Inhalte nach."
    ),
    loading: t("Loading …", "Lädt …"),
    missing: t("not stored locally", "lokal nicht vorhanden"),
    sources: t("Sections", "Bereiche"),
    library: t("Library", "Bibliothek"),
    clearFilters: t("Reset", "Zurücksetzen"),
    sortAz: t("A–Z", "A–Z"),
    sortSource: t("Book order", "Buchreihenfolge"),
    inThis: t("in this section", "in diesem Bereich"),
  };

  const label = (v) => (v && typeof v === "object" ? (DE ? v.de || v.en : v.en || v.de) : v || "");

  /* ---------------- helpers ---------------- */
  const esc = (s) =>
    String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
    );

  const norm = (s) =>
    String(s || "")
      .toLocaleLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, " ")
      .trim();


  const debounce = (fn, ms) => {
    let h;
    return (...a) => {
      clearTimeout(h);
      h = setTimeout(() => fn(...a), ms);
    };
  };

  /* ---------------- indexes ---------------- */
  const entries = DB.entries;
  entries.forEach((e, i) => {
    e._i = i;
    e._k = norm(e.k || ([e.t, ...Object.values(e.m || {}).flat()].join(" ")));
  });

  const byId = new Map(entries.map((e) => [e.id, e]));
  const byUrl = new Map();
  const glossaryByUrl=new Map();
  const glossaryByPage=new Map();
  for(const g of DB.glossary||[]){
    const base=Model.urlKey(g.url,DB.profile),key=base+"#"+Model.decode((g.url.match(/#(.*)$/)||[])[1]||"");
    if(!glossaryByUrl.has(key))glossaryByUrl.set(key,g);
    if(!glossaryByPage.has(base))glossaryByPage.set(base,[]);
    if(!glossaryByPage.get(base).some(item=>item.url===g.url))glossaryByPage.get(base).push(g);
  }
  for (const e of entries) for (const url of [e.u, ...(e.a || [])].filter(Boolean)) {
    const key = Model.urlKey(url, DB.profile);
    if (!byUrl.has(key) || (byUrl.get(key).c == null && e.c != null)) byUrl.set(key, e);
  }

  const sources = (DB.sources || []).map((s) => ({ ...s, entries: [] }));
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const sourceByUrl=new Map();
  for(const s of sources)if(s.url){
    sourceByUrl.set(Model.urlKey(s.url,DB.profile),s);
    try{const u=new URL(s.url);u.search="";sourceByUrl.set(Model.urlKey(u.href,DB.profile),s);}catch{}
  }
  for (const e of entries) {
    const s = sourceById.get(e.s);
    if (s) s.entries.push(e);
  }
  for (const s of sources) {
    if (s.layout === "book") s.entries.sort((a, b) => (a.o ?? 0) - (b.o ?? 0) || a._i - b._i);
    else s.entries.sort((a, b) => cmpTitle(a, b));
    const first=s.entries[0];
    s.name=LWLPresentation.chooseTitle([s.name,s.layout==='book'?first?.t:null],t('Untitled document','Dokument ohne Titel'));
    for(const e of s.entries)e.t=LWLPresentation.chooseTitle([s.layout==='book'?LWLPresentation.chapterTitle(e.t,s.name):e.t],s.name);
  }

  function cmpTitle(a, b) {
    return String(a.t || "").localeCompare(String(b.t || ""), undefined, { numeric: true, sensitivity: "base" }) || a._i - b._i;
  }

  const groups = (DB.groups && DB.groups.length
    ? DB.groups
    : [{ id: "all", label: { en: T.sources, de: T.sources }, sourceIds: sources.map((s) => s.id) }]
  ).map((g) => ({ ...g, sources: (g.sourceIds || []).map((id) => sourceById.get(id)).filter(Boolean) }));

  /* ---------------- content chunk loading ---------------- */
  window.LWL_CHUNKS = window.LWL_CHUNKS || {};
  const chunkPromises = new Map();

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error("Could not load " + src));
      document.head.appendChild(el);
    });
  }

  /* Original styles, cached by content hash. Each article document keeps its
     own cascade without applying those rules to the library controls. */
  window.LWL_SITECSS = window.LWL_SITECSS || {};
  const siteCssPromises = {};
  function loadSiteCss(entry) {
    const key = entry.css || sourceById.get(entry.s)?.css;
    if (!key) return Promise.resolve(null);
    if (window.LWL_SITECSS[key]) return Promise.resolve(window.LWL_SITECSS[key]);
    if (!siteCssPromises[key]) siteCssPromises[key] = loadScript(`data/site-${key}.js`).then(() => window.LWL_SITECSS[key] || window.LWL_SITECSS[entry.s] || null).catch(() => null);
    return siteCssPromises[key];
  }

  function loadChunk(n) {
    if (n == null) return Promise.resolve(null);
    if (window.LWL_CHUNKS[n]) return Promise.resolve(window.LWL_CHUNKS[n]);
    if (!chunkPromises.has(n)) {
      chunkPromises.set(
        n,
        loadScript(`data/content-${String(n).padStart(3, "0")}.js`)
          .then(() => window.LWL_CHUNKS[n] || {})
          .catch(() => ({}))
      );
    }
    return chunkPromises.get(n);
  }

  let ftsPromise = null;
  function loadFts() {
    if (!DB.fts) return Promise.resolve(null);
    if (window.LWL_FTS) return Promise.resolve(window.LWL_FTS);
    if (!ftsPromise) ftsPromise = loadScript("data/fts.js").then(() => window.LWL_FTS || null).catch(() => null);
    return ftsPromise;
  }

  /* ---------------- routing ---------------- */
  function parseHash() {
    const raw = String(location.hash || "").replace(/^#/, "");
    const m = raw.match(/^\/([a-z]+)(?:\/(.*))?$/);
    if (!m) return { view: "home" };
    const [, kind, rest = ""] = m;
    if (kind === "s") {
      const [id, frag] = rest.split("|");
      return { view: "source", id:Model.decode(id), frag:Model.decode(frag || "") };
    }
    if (kind === "e") {
      const [id, frag] = rest.split("|");
      return { view: "entry", id:Model.decode(id), frag:Model.decode(frag || "") };
    }
    if (kind === "q") return { view: "search", q:Model.decode(rest) };
    if (kind === "missing") return { view: "missing", url:Model.decode(rest) };
    return { view: "home" };
  }

  const go = (hash) => {
    if (location.hash === hash) render();
    else location.hash = hash;
  };

  /* ---------------- state ---------------- */
  const state = { facets: {}, filter: "", limit: 120, scope: "titles", sort: "src", sourceId:null };
  const sourceStates = new Map();
  const sourceRoute = s => s.layout==='book' && s.entries.length ? Model.routeFor(s.entries.find(e=>e.c!=null)?.id||s.entries[0].id) : '#/s/'+encodeURIComponent(s.id);

  function renderLibraryBar() {
    const bar=document.getElementById('libraryBar');if(!bar)return;
    const route=parseHash(),active=route.view==='source'?route.id:route.view==='entry'?byId.get(route.id)?.s:null;
    const catalogs=sources.filter(s=>s.layout!=='book'),books=sources.filter(s=>s.layout==='book');
    const menu=(title,items)=>`<details class="library-menu"><summary>${esc(title)}</summary><div class="library-menu-panel">${items.length?items.map(item=>`<a href="${esc(item.href)}"${item.active?' aria-current="page"':''}>${esc(item.name)}</a>`).join(''):`<p>${esc(t('Nothing saved here yet.','Hier ist noch nichts gespeichert.'))}</p>`}</div></details>`;
    const sections=list=>list.map(s=>({name:s.name,href:'#/s/'+encodeURIComponent(s.id),active:s.id===active}));
    const libraries=(window.LWL_LIBRARY_DIRECTORY?.libraries||[]).filter(l=>/^[^/]+\/Reader\/index\.html$/.test(l.path)&&!l.path.split('/').some(p=>p==='..'||p==='.')&&!/[\\?#:]/.test(l.path));
    bar.innerHTML=`<a class="library-home" href="#/" aria-label="${esc(T.overview)}">DiceFox Library</a>`+
      menu(t('Catalogs','Kataloge'),sections(catalogs))+menu(t('Documents','Dokumente'),sections(books))+
      (libraries.length>1?menu(t('Libraries','Bibliotheken'),libraries.map(l=>({name:l.name,href:'../../'+l.path,active:l.id===DB.profile?.id}))):'')+
      `<span class="library-context">${esc(sourceById.get(active)?.name||DB.profile?.name||T.library)}</span><a class="library-search" href="#/q/">${esc(t('Search','Suche'))}</a>`;
    bar.setAttribute('aria-label',t('Local library navigation','Lokale Bibliotheksnavigation'));
    for(const details of bar.querySelectorAll('details'))details.addEventListener('toggle',()=>{if(details.open)for(const other of bar.querySelectorAll('details'))if(other!==details)other.open=false;});
    bar.querySelector('.library-search').addEventListener('click',ev=>{ev.preventDefault();go('#/');requestAnimationFrame(()=>qInput.focus());});
    bar.onkeydown=ev=>{if(ev.key==='Escape')for(const d of bar.querySelectorAll('details[open]')){d.open=false;d.querySelector('summary').focus();}};
    bar.onclick=ev=>{if(ev.target.closest('a'))for(const d of bar.querySelectorAll('details'))d.open=false;};
  }

  /* ---------------- sidebar ---------------- */
  document.addEventListener('click',ev=>{const bar=document.getElementById('libraryBar');if(bar&&!bar.contains(ev.target))for(const d of bar.querySelectorAll('details'))d.open=false;});
  const expanded = new Set();

  function renderNav() {
    const route = parseHash();
    const activeSource = route.view === "source" ? route.id : route.view === "entry" ? byId.get(route.id)?.s : null;
    const parts = [];

    parts.push(
      `<div class="nav-group"><button class="nav-item${route.view === "home" ? " active" : ""}" data-go="#/">` +
        `<span class="dot"></span><span class="label">${esc(T.overview)}</span>` +
        `<span class="count">${entries.length}</span></button></div>`
    );

    for (const g of groups) {
      if (!g.sources.length) continue;
      parts.push(`<div class="nav-group"><div class="nav-title">${esc(label(g.label) || g.id)}</div>`);
      for (const s of g.sources) {
        const isActive = s.id === activeSource;
        const isBook = s.layout === "book";
        const open = expanded.has(s.id) || (isActive && isBook);
        if (open) expanded.add(s.id);
        parts.push(
          `<button class="nav-item${isActive && !isBook ? " active" : ""}" data-go="${sourceRoute(s)}"` +
            (isBook ? ` data-book="${esc(s.id)}" aria-expanded="${open}"` : "") +
            `>` +
            (isBook ? `<span class="nav-toggle">&#9656;</span>` : `<span class="dot"></span>`) +
            `<span class="label">${esc(s.name)}</span><span class="count">${s.entries.length}</span></button>`
        );
        if (isBook && open) {
          parts.push('<div class="nav-sub">');
          for (const e of s.entries.slice(0, 400)) {
            parts.push(
              `<button class="nav-item${route.view === "entry" && route.id === e.id ? " active" : ""}" ` +
                `data-go="#/e/${encodeURIComponent(e.id)}"><span class="label">${esc(e.t)}</span></button>`
            );
          }
          parts.push("</div>");
        }
      }
      parts.push("</div>");
    }
    nav.innerHTML = parts.join("");
  }

  nav.addEventListener("click", (ev) => {
    const btn = ev.target.closest("[data-go]");
    if (!btn) return;
    const book = btn.getAttribute("data-book");
    if (book && ev.target.closest(".nav-toggle")) {
      expanded.has(book) ? expanded.delete(book) : expanded.add(book);
      const articleNav = nav.querySelector('.article-nav');
      renderNav();
      if (articleNav) nav.prepend(articleNav);
      return;
    }
    app.classList.remove("nav-open");
    go(btn.getAttribute("data-go"));
  });

  /* ---------------- views ---------------- */
  /* ---------------- theme captured from the source site ----------------

     The reader is built entirely on CSS variables, so the tokens read off the
     original page can drive the whole interface, not just the article. Every
     site brings its own; none of this knows which site it is. */

  const THEME_VARS = ["--bg","--bg-alt","--surface","--surface-2","--ink","--ink-soft","--muted",
                      "--line","--line-soft","--accent","--accent-ink","--accent-soft","--serif","--sans"];

  function rgb(value) {
    const m = String(value || "").match(/\d+(\.\d+)?/g);
    return m && m.length >= 3 ? m.slice(0, 3).map(Number) : null;
  }
  const css = c => `rgb(${c.map(v => Math.round(Math.max(0, Math.min(255, v)))).join(",")})`;
  const mix = (a, b, t) => (a && b ? css(a.map((v, i) => v + (b[i] - v) * t)) : null);
  const lum = c => (c ? (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255 : null);

  function applyTheme(theme) {
    const root = document.documentElement;
    for (const v of THEME_VARS) root.style.removeProperty(v);
    if (!theme || root.getAttribute("data-theme") === "dark") return;
    const bg = rgb(theme.bg), ink = rgb(theme.ink);
    if (!bg || !ink) return;
    const sampledSurface = rgb(theme.surface) || bg;
    // A sample from unrelated site chrome can be white on a dark page. Keep
    // captured text readable on generated cards and chapter lists as well.
    const surface = Math.abs(lum(sampledSurface)-lum(ink)) < 0.3 ? bg : sampledSurface;
    const line = rgb(theme.line) || null;
    const accent = rgb(theme.accent);
    const set = (name, value) => { if (value) root.style.setProperty(name, value); };

    set("--bg", css(bg));
    set("--bg-alt", mix(bg, ink, 0.05));
    set("--surface", css(surface));
    set("--surface-2", mix(surface, ink, 0.04));
    set("--ink", css(ink));
    set("--ink-soft", mix(ink, bg, 0.2));
    set("--muted", mix(ink, bg, 0.45));
    set("--line", line ? css(line) : mix(ink, bg, 0.78));
    set("--line-soft", line ? mix(line, bg, 0.5) : mix(ink, bg, 0.88));
    if (accent) {
      set("--accent", css(accent));
      set("--accent-ink", lum(accent) > 0.55 ? "#141414" : "#ffffff");
      set("--accent-soft", mix(accent, bg, 0.85));
    }
    set("--sans", theme.sans);
    set("--serif", theme.serif || theme.sans);
  }

  function themeForRoute(route) {
    const id = route.view === "source" ? route.id
      : route.view === "entry" ? byId.get(route.id)?.s
      : null;
    if (id) return sourceById.get(id)?.theme || null;
    /* On the overview and in search: if every themed source agrees, use it, so
       the reader does not flip appearance between two views of one library. */
    const themes = sources.map(x => x.theme).filter(Boolean);
    return themes.length && themes.every(x=>x.bg===themes[0].bg&&x.ink===themes[0].ink) ? themes[0] : null;
  }

  function render() {
    hideGlossary();
    document.body.classList.remove("original-view","book-view","entry-view");
    renderVersion++; disposeArticle(); disposeArticle = () => {};
    const route = parseHash();
    applyTheme(themeForRoute(route));
    renderNav();
    renderLibraryBar();
    main.scrollTop = 0;
    if (route.view === "entry") return renderEntry(route);
    if (route.view === "source") return renderSource(route);
    if (route.view === "search") return renderSearch(route);
    if (route.view === "missing") return renderMissing(route);
    return renderHome();
  }

  function renderMissing(route) {
    let url;
    try{url=new URL(route.url);if(!/^https?:$/.test(url.protocol))throw Error('Invalid URL');}catch{return renderHome();}
    main.innerHTML=`<div class="page reading">${breadcrumb([[T.library,'#/'],[T.noContent,null]])}<div class="empty"><h1>${esc(T.noContent)}</h1><p>${esc(t('This linked page is not part of the local copy yet. Sync its source to read it offline.','Diese verlinkte Seite fehlt noch im lokalen Abzug. Synchronisiere die zugehörige Quelle, um sie offline zu lesen.'))}</p><p><a class="btn" href="${esc(url.href)}" target="_blank" rel="noopener">${esc(T.online)}</a></p></div></div>`;
  }

  function renderHome() {
    qInput.value = "";
    const cards = groups
      .map((g) => {
        if (!g.sources.length) return "";
        const items = g.sources
          .map(
            (s) =>
              `<a class="card${s.layout==='book'?' book-card':''}" href="${sourceRoute(s)}">` +
              (s.layout==='book'?`<div class="book-cover" data-cover-source="${esc(s.id)}">${s.cover?`<img src="${esc(s.cover)}" alt="" loading="lazy">`:`<span aria-hidden="true">${esc(s.name)}</span>`}</div>`:'')+
              `<div class="card-body"><div class="kicker">${esc(s.layout==='book'?t('Document','Dokument'):t('Catalog','Katalog'))}</div>` +
              `<h3>${esc(s.name)}</h3>` +
              `<p>${s.entries.length} ${esc(T.entries)}</p></div></a>`
          )
          .join("");
        return `<h2 class="nav-title" style="padding-left:0;margin:28px 0 12px">${esc(label(g.label) || g.id)}</h2>` +
          `<div class="card-grid">${items}</div>`;
      })
      .join("");

    const withContent = entries.filter((e) => e.c != null).length;
    main.innerHTML =
      `<div class="page">` +
      `<div class="page-head"><h1>${esc(DB.profile?.name || T.library)}</h1>` +
      `<p class="lede">${esc(T.library)} · ${esc(new Date(DB.generatedAt || Date.now()).toLocaleString())}</p></div>` +
      `<div class="stat-row">` +
      `<div class="stat"><div class="n">${entries.length}</div><div class="l">${esc(T.entries)}</div></div>` +
      `<div class="stat"><div class="n">${withContent}</div><div class="l">${esc(t("with content", "mit Inhalt"))}</div></div>` +
      `<div class="stat"><div class="n">${sources.length}</div><div class="l">${esc(T.sources)}</div></div>` +
      `</div>` +
      (DB.assetReport?.missing?.length || DB.styleWarnings?.length ? `<p class="capture-notice">${esc(t("The offline copy is missing resources:","In der Offlinekopie fehlen Ressourcen:"))} ${DB.assetReport?.missing?.length || 0} ${esc(t("files", "Dateien"))}, ${DB.styleWarnings?.length || 0} ${esc(t("style warnings", "Style-Hinweise"))}. <a href="capture-report.json" target="_blank" rel="noopener">${esc(t("Import report", "Importbericht"))}</a></p>` : "") +
      `${cards}</div>`;
    // Older libraries did not carry covers in source metadata. Recover only
    // explicitly marked cover images from their already-local first chapter.
    const version=renderVersion;
    for(const s of sources.filter(s=>s.layout==='book'&&!s.cover)){
      const first=s.entries[0];if(first?.c==null)continue;
      loadChunk(first.c).then(chunk=>{
        if(version!==renderVersion)return;
        const template=document.createElement('template');template.innerHTML=chunk?.[first.id]||'';
        const cover=LWLPresentation.cover(template.content,location.href);
        if(!cover||!cover.startsWith(new URL('.',location.href).href))return;
        const slot=[...main.querySelectorAll('[data-cover-source]')].find(el=>el.dataset.coverSource===s.id);
        if(slot){const img=document.createElement('img');img.src=cover;img.alt='';img.loading='lazy';slot.replaceChildren(img);}
      });
    }
  }

  function facetValues(source) {
    return (source.facets || []).filter((f) => f.exact || (f.values || []).length > 1);
  }

  const matchesFacets = Model.matchesFacets;

  function renderSource(route) {
    const s = sourceById.get(route.id);
    if (!s) return renderHome();
    qInput.value = "";
    if (state.sourceId !== s.id) {
      if (state.sourceId) sourceStates.set(state.sourceId, {facets:state.facets,filter:state.filter,sort:state.sort,catalogFilters:state.catalogFilters,catalogPage:state.catalogPage,catalogSort:state.catalogSort});
      Object.assign(state, sourceStates.get(s.id) || {facets:{},filter:"",catalogFilters:{},catalogPage:1,catalogSort:null,sort:s.layout === "book" ? "src" : "az"});
      state.sourceId = s.id;
    }
    state.limit = 120;

    if(s.catalog && window.LWLReaderCatalog){renderCatalog(s);return;}

    const facets = facetValues(s);
    const draw = () => {
      const f = norm(state.filter);
      let rows = s.entries.filter((e) => matchesFacets(e, state.facets, facets) && (!f || e._k.includes(f)));
      if (s.layout !== "book" || state.sort === "az") rows = rows.slice().sort(cmpTitle);

      const shown = rows.slice(0, state.limit);
      const listHtml = shown.length
        ? `<div class="entry-list">${shown.map((e) => entryRow(e, s)).join("")}</div>` +
          (rows.length > shown.length
            ? `<button class="btn load-more" id="more">${esc(T.loadMore)} (${rows.length - shown.length})</button>`
            : "")
        : `<div class="empty"><h2>${esc(T.noResults)}</h2><p>${esc(T.noResultsHint)}</p></div>`;

      const body = document.getElementById("srcBody");
      const count = document.getElementById("srcCount");
      if (count) count.textContent = `${rows.length} ${T.entries}`;
      if (body) {
        body.innerHTML = listHtml;
        const more = document.getElementById("more");
        if (more)
          more.onclick = () => {
            state.limit += 200;
            draw();
          };
      }
    };

    const facetHtml = facets.map(f => {
      const selected = Array.isArray(state.facets[f.key]) ? state.facets[f.key] : [state.facets[f.key]];
      const options = f.options || f.values.map(value=>({value,label:value}));
      return `<label class="facet"><span class="facet-label">${esc(label(f.label) || f.key)}</span>` +
        `<select data-facet="${esc(f.key)}"${f.multiple ? ' multiple size="4"' : ''}>` +
        (f.multiple ? "" : `<option value="">${esc(T.all)}</option>`) +
        options.map(o=>`<option value="${esc(o.value)}"${selected.includes(o.value) ? " selected" : ""}>${esc(o.label)}</option>`).join("") + `</select></label>`;
    }).join("");

    const bookNav = s.layout === "book";
    main.innerHTML =
      `<div class="page">` +
      breadcrumb([[T.library, "#/"], [s.name, null]]) +
      `<div class="page-head"><h1>${esc(s.name)}</h1>` +
      `<p class="lede">${s.entries.length} ${esc(T.entries)}${s.type ? " · " + esc(s.type) : ""}</p></div>` +
      `<div class="toolbar">` +
      `<label class="facet"><span class="facet-label">${esc(t("Filter", "Filter"))}</span>` +
      `<input id="srcFilter" type="search" placeholder="${esc(T.inThis)}" style="border:0;background:transparent;min-width:170px"></label>` +
      facetHtml + `<button class="btn" id="resetFilters">${esc(T.clearFilters)}</button>` +
      (bookNav
        ? `<div class="scope"><button data-sort="src" class="${state.sort === "src" ? "on" : ""}">${esc(T.sortSource)}</button>` +
          `<button data-sort="az" class="${state.sort === "az" ? "on" : ""}">${esc(T.sortAz)}</button></div>`
        : "") +
      `<span class="result-count" id="srcCount"></span></div>` +
      (s.unresolvedFilters?.length ? `<p class="capture-notice">${esc(t("These original filters have not been fully captured:", "Diese Originalfilter sind noch nicht vollständig erfasst:"))} ${s.unresolvedFilters.map(esc).join(", ")}</p>` : "") +
      (s.complete === false ? `<p class="capture-notice">${esc(t("This catalog import is incomplete.", "Dieser Katalogimport ist unvollständig."))}</p>` : "") +
      `<div id="srcBody"></div></div>`;

    const filterInput = document.getElementById("srcFilter");
    filterInput.value = state.filter;
    filterInput.addEventListener(
      "input",
      debounce(() => {
        state.filter = filterInput.value;
        state.limit = 120;
        draw();
      }, 120)
    );
    main.querySelectorAll("[data-facet]").forEach((sel) => {
      sel.addEventListener("change", () => {
        state.facets[sel.getAttribute("data-facet")] = sel.multiple ? [...sel.selectedOptions].map(o=>o.value) : sel.value;
        state.limit = 120;
        draw();
      });
    });
    document.getElementById("resetFilters").onclick = () => {state.facets={};state.filter="";renderSource(route);};
    main.querySelectorAll("[data-sort]").forEach((b) => {
      b.addEventListener("click", () => {
        state.sort = b.getAttribute("data-sort");
        renderSource(route);
      });
    });
    draw();
  }

  async function renderCatalog(source){
    const version=renderVersion;
    main.innerHTML='<div class="spinner"></div>';
    try{
      window.LWL_CATALOGS=window.LWL_CATALOGS||{};
      if(!window.LWL_CATALOGS[source.catalog])await loadScript(`data/catalog-${source.catalog}.js`);
      const css=await loadSiteCss({s:source.id});
      if(version!==renderVersion)return;
      const view=window.LWL_CATALOGS[source.catalog];
      if(!view?.html)throw Error(t('Catalog layout is missing. Sync this source again.','Das Kataloglayout fehlt. Diese Quelle erneut synchronisieren.'));
      document.body.classList.add('original-view');
      disposeArticle=LWLReaderCatalog.mount({host:main,source,view,css,profile:DB.profile,state,
        decorate:(root)=>decorateArticle(root,{u:view.url||source.url,s:source.id,p:view.presentation},true),
        navigate:go,translate:t,isCurrent:()=>version===renderVersion});
    }catch(error){if(version===renderVersion)main.innerHTML=`<div class="empty"><p>${esc(error.message)}</p><a href="#/">${esc(T.library)}</a></div>`;}
  }

  /* Keys whose value is self-explanatory in a list row; everything else is
     shown as "Label: value" so a bare "Required" cannot be misread. */
  const BARE_KEYS = new Set(["type", "subtype", "tags", "category", "kind"]);

  function entryRow(e, source) {
    const meta = e.m || {};
    const badgeKey = source?.badge;
    const badge = meta[badgeKey];
    const bits = Object.entries(meta)
      .filter(([k]) => k !== badgeKey)
      .map(([k, v]) => {
        const val = Array.isArray(v) ? v.join(", ") : v;
        if (!val) return "";
        return BARE_KEYS.has(k) ? val : `${labelForKey(source, k)}: ${val}`;
      })
      .filter(Boolean);
    return (
      `<a class="entry-row" href="#/e/${encodeURIComponent(e.id)}">` +
      `<span class="name">${esc(e.t)}</span>` +
      (badge ? `<span class="badge">${esc(badge)}</span>` : "<span></span>") +
      (bits.length ? `<span class="meta">${bits.map((b) => `<span>${esc(b)}</span>`).join("")}</span>` : "") +
      (e.x ? `<span class="snippet">${esc(e.x)}</span>` : "") +
      `</a>`
    );
  }

  function breadcrumb(items) {
    return (
      `<nav class="breadcrumb">` +
      items
        .map(([txt, href], i) =>
          (i ? '<span class="sep">/</span>' : "") + (href ? `<a href="${esc(href)}">${esc(txt)}</a>` : `<span>${esc(txt)}</span>`)
        )
        .join("") +
      `</nav>`
    );
  }

  /* ---------------- entry view ---------------- */
  async function renderEntry(route) {
    const version = renderVersion;
    const e = byId.get(route.id);
    if (!e) return renderHome();
    const s = sourceById.get(e.s);
    const meta = e.m || {};

    const props = Object.entries(meta)
      .map(
        ([k, v]) =>
          `<span class="prop"><span class="prop-key">${esc(labelForKey(s, k))}</span>` +
          `<span>${esc(Array.isArray(v) ? v.join(", ") : v)}</span></span>`
      )
      .join("");

    main.innerHTML =
      `<div class="page reading">` +
      breadcrumb([[T.library, "#/"], [s?.name || e.s, s ? `#/s/${encodeURIComponent(s.id)}` : null], [e.t, null]]) +
      `<header class="entry-header"><h1>${esc(e.t)}</h1>` +
      (props ? `<div class="entry-props">${props}</div>` : "") +
      `</header>` +
      `<div class="with-toc"><div><div class="article" id="article"><div class="spinner"></div></div>` +
      pagerHtml(e, s) +
      `</div><aside class="toc" id="toc"></aside></div></div>`;

    const article = document.getElementById("article");
    if(e.captureStatus==='incomplete'){
      const notice=document.createElement('p');notice.className='capture-notice';
      notice.textContent=t('This older book capture may contain only part of the chapter. Use “Fetch missing or outdated pages” in the extension or sync the book again to restore its text and images.','Diese ältere Buchkopie kann nur einen Teil des Kapitels enthalten. Nutze „Fehlende oder veraltete Seiten nachladen“ in der Erweiterung oder synchronisiere das Buch erneut, um Text und Bilder wiederherzustellen.');
      article.before(notice);
    }
    if (e.c == null) {
      const hint=e.captureStatus==='unavailable'
        ?t('This page was not accessible with the account used for the import. Its contents could not be saved.','Diese Seite war mit dem beim Import verwendeten Konto nicht zugänglich. Ihr Inhalt konnte deshalb nicht gespeichert werden.')
        :T.noContentHint;
      article.innerHTML =
        `<div class="empty"><h2>${esc(T.noContent)}</h2><p>${esc(hint)}</p>` +
        (e.u ? `<p style="margin-top:14px"><a class="btn" href="${esc(e.u)}" target="_blank" rel="noopener">${esc(T.online)}</a></p>` : "") +
        `</div>`;
      document.getElementById("toc").remove();
      return;
    }

    const chunk = await loadChunk(e.c);
    if (version !== renderVersion) return; // navigated away while loading
    const html = chunk?.[e.id];
    if (!html) {
      article.innerHTML = `<div class="empty"><h2>${esc(T.noContent)}</h2><p>${esc(T.noContentHint)}</p></div>`;
      return;
    }
    const siteCss = await loadSiteCss(e);
    if (version !== renderVersion) return;
    if (e.p) {
      // Original CSS needs the original viewport even when only the article
      // region was captured. A second, auto-sized scroll frame breaks both
      // responsive layouts and wheel/anchor navigation.
      document.body.classList.add("original-view");
      document.body.classList.add('entry-view');
      if(s?.layout==='book')document.body.classList.add('book-view');
      article.classList.add("original-article");
      const frame = document.createElement("iframe");
      frame.className = "original-page";
      frame.title = e.t;
      // Original scripts, forms and top-level navigation remain disabled.
      // The parent wires up local navigation after the inert document loads.
      frame.setAttribute("sandbox", "allow-same-origin");
      frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: file: https: http:; font-src data: file: https: http:; base-uri *"><base href="${esc(new URL(".", location.href).href)}"></head><body></body></html>`;
      frame.onload = () => {
        if (version !== renderVersion) return;
        const doc = frame.contentDocument;
        if (!doc) return;
        const setAttrs = (node, attrs) => {
          for (const [key,value] of Object.entries(attrs || {})) if (/^(id|class|lang|dir|role|style)$/.test(key) || /^data-(theme|page|layout|book|source|content)(-|$)/.test(key)) node.setAttribute(key,value);
        };
        setAttrs(doc.documentElement,e.p.html);setAttrs(doc.body,e.p.body);
        const style = doc.createElement("style");style.textContent = siteCss || "body { background:white; color:#222; font:16px/1.6 system-ui; } img { max-width:100%; height:auto; }";doc.head.appendChild(style);
        doc.body.innerHTML = html;
        if(e.p.mode!=='page' && s?.articleLayout)restoreArticleLayout(doc,s.articleLayout,e.t);
        LWLPresentation.clean(doc.body,DB.profile?.presentationPolicy);
        LWLPresentation.fitDocument(doc);
        decorateArticle(doc.body,e,true);
        buildToc(doc.body);
        if (route.frag) requestAnimationFrame(()=>scrollToAnchor(doc.body,route.frag,frame));
        const title = doc.body.querySelector("h1");
        if (title && norm(title.textContent) === norm(e.t)) document.querySelector(".entry-header").hidden = true;
      };
      article.replaceChildren(frame);
      if(!siteCss){const notice=document.createElement("p");notice.className="capture-notice";notice.textContent=t("Original styles are missing; sync this page again.","Die Originalstyles fehlen; diese Seite erneut synchronisieren.");article.prepend(notice);}
    } else {
      article.innerHTML = html;
      LWLPresentation.clean(article,DB.profile?.presentationPolicy);
      decorateArticle(article,e);
      buildToc(article);
      if (route.frag) scrollToAnchor(article,route.frag);
      if (!siteCss) {
        const notice=document.createElement("p");notice.className="capture-notice";
        notice.textContent=t("Original styles are missing. Sync this page again to restore its appearance.","Die Originalstyles fehlen. Diese Seite erneut synchronisieren, um ihre Darstellung wiederherzustellen.");
        article.prepend(notice);
      }
    }
  }

  function scrollToAnchor(root, fragment, frame) {
    const id=Model.decode(fragment);
    const target=root.querySelector(`[id="${CSS.escape(id)}"],a[name="${CSS.escape(id)}"]`);
    if (!target) return false;
    if (frame && document.body.classList.contains("original-view")) target.scrollIntoView({block:"start"});
    else if (frame) main.scrollTop += frame.getBoundingClientRect().top + target.getBoundingClientRect().top - main.getBoundingClientRect().top - 16;
    else target.scrollIntoView({block:"start"});
    return true;
  }

  function restoreArticleLayout(doc,layout,title){
    const original=doc.body.querySelector('[data-lwl-article-root]');
    if(!original||original.querySelector('h1'))return;
    const template=doc.createElement('template');template.innerHTML=layout.html||'';
    const slot=template.content.querySelector('[data-lwl-layout-content]');
    const heading=template.content.querySelector('[data-lwl-layout-title]');
    if(!slot||!heading)return;
    // A shell is reusable only for the same root structure. An unrelated
    // article or another page family keeps its own captured structure.
    if(slot.tagName!==original.tagName||[...slot.classList].some(c=>!original.classList.contains(c)))return;
    for(const binding of layout.images||[]){
      let source;try{source=original.querySelector(binding.selector);}catch{continue;}
      const image=template.content.querySelector(`[data-lwl-layout-image="${CSS.escape(binding.id)}"]`);
      if(!image)continue;
      if(!source?.getAttribute('src')){image.remove();continue;}
      image.src=source.getAttribute('src');image.alt=source.alt||title;
    }
    heading.textContent=title;slot.replaceWith(original);
    doc.body.replaceChildren(template.content);
  }


  function labelForKey(source, key) {
    const f = (source?.facets || []).find((x) => x.key === key);
    if (f && label(f.label)) return label(f.label);
    return String(key).replace(/[-_]+/g, " ").replace(/^./, (c) => c.toUpperCase());
  }

  function pagerHtml(e, s) {
    if (!s) return "";
    const list = s.entries;
    const i = list.indexOf(e);
    if (i < 0) return "";
    const prev = list[i - 1];
    const next = list[i + 1];
    if (!prev && !next) return "";
    return (
      `<div class="pager">` +
      (prev
        ? `<a href="#/e/${encodeURIComponent(prev.id)}"><span class="dir">${esc(T.prev)}</span><span class="ttl">${esc(prev.t)}</span></a>`
        : "") +
      (next
        ? `<a class="next" href="#/e/${encodeURIComponent(next.id)}"><span class="dir">${esc(T.next)}</span><span class="ttl">${esc(next.t)}</span></a>`
        : "") +
      `</div>`
    );
  }

  /* Rewrite captured links to local routes and make wide tables scrollable. */
  function decorateArticle(root, entry, original = false) {
    // The captured page usually repeats its own title as an <h1>; the entry
    // header already shows it, so drop the duplicate.
    const first = root.firstElementChild;
    if (!original && first && first.tagName === "H1" && norm(first.textContent) === norm(entry?.t)) first.remove();

    // Reconnect the captured ARIA disclosure menus without executing site code.
    const disclosures=[];
    for(const button of root.querySelectorAll("button[aria-controls][aria-expanded]")) {
      const panel=root.querySelector(`[id="${CSS.escape(button.getAttribute("aria-controls"))}"]`);if(!panel)continue;
      const initialStyle=panel.getAttribute("style"),initialHidden=panel.hidden;
      const setOpen=open=>{
        button.setAttribute("aria-expanded",String(open));
        if(open){panel.hidden=false;Object.assign(panel.style,{opacity:"1",visibility:"visible",pointerEvents:"auto",transform:"none"});if(root.ownerDocument.defaultView.getComputedStyle(panel).display==="none")panel.style.display="block";}
        else {if(initialStyle==null)panel.removeAttribute("style");else panel.setAttribute("style",initialStyle);panel.hidden=initialHidden;}
        for(const link of panel.querySelectorAll("a"))link.tabIndex=open?0:-1;
      };
      disclosures.push({button,panel,setOpen});
      button.addEventListener("click",()=>{const open=button.getAttribute("aria-expanded")!=="true";for(const d of disclosures)if(d.button!==button)d.setOpen(false);setOpen(open);});
    }
    root.addEventListener("keydown",ev=>{if(ev.key==="Escape")for(const d of disclosures)d.setOpen(false);});

    for(const select of root.querySelectorAll("select[data-lwl-navigation]"))select.addEventListener("change",()=>{
      const raw=select.value;if(!raw)return;
      const base=Model.urlKey(raw,DB.profile,entry.u),frag=(raw.match(/#(.*)$/)||[])[1]||"";
      const target=base===Model.urlKey(entry.u,DB.profile)?entry:byUrl.get(base);
      if(target?.c!=null){
        const route=Model.routeFor(target.id,frag);
        if(target.id===entry.id && frag && scrollToAnchor(root,frag,root.ownerDocument.defaultView?.frameElement))history.pushState(null,"",route);
        else go(route);
      }
    });
    for(const toggle of entry.p?.navigationToggles||[]) {
      if(!/^[a-zA-Z_][\w-]*$/.test(toggle.className||""))continue;
      try{for(const trigger of root.querySelectorAll(toggle.selector)) {
        const container=trigger.closest(toggle.container);if(!container)continue;
        const activate=()=>{
          const closed=container.classList.toggle(toggle.className);
          if(/^[a-zA-Z_][\w-]*$/.test(toggle.expandedClassName||""))container.classList.toggle(toggle.expandedClassName,!closed);
          trigger.setAttribute("aria-expanded",String(!closed));
        };
        trigger.setAttribute("role","button");trigger.setAttribute("tabindex","0");
        trigger.setAttribute("aria-expanded",String(!container.classList.contains(toggle.className)));
        trigger.addEventListener("click",activate);
        if(trigger.tagName!=="BUTTON")trigger.addEventListener("keydown",ev=>{if(ev.key==="Enter"||ev.key===" "){ev.preventDefault();activate();}});
      }}catch{}
    }

    for (const a of root.querySelectorAll("a[data-lwl-href]")) {
      const raw = a.getAttribute("data-lwl-href");
      if(a.title)a.title=glossaryExcerpt(a.title,240);
      const reference=referenceFor(a,entry.u,LWLReferences.hasPreview(a,DB.profile?.referencePolicy));
      const {base,frag,glossary}=reference;
      const target = base === Model.urlKey(entry.u,DB.profile) ? entry : byUrl.get(base);
      const sourceTarget=sourceByUrl.get(base);
      if (target?.id) {
        const route=Model.routeFor(target.id,frag);
        a.setAttribute("href",route);a.removeAttribute("target");
        a.addEventListener("click",ev=>{
          ev.preventDefault();
          if(target.id===entry.id && frag){
            const frame=root.ownerDocument.defaultView?.frameElement;
            if(scrollToAnchor(root,frag,frame)) {history.pushState(null,"",route);return;}
          }
          go(route);
        });
      } else if(!entry.id && frag && base===Model.urlKey(entry.u,DB.profile) && root.ownerDocument.getElementById(Model.decode(frag))){
        a.setAttribute("href","#"+frag);a.removeAttribute("target");
        a.addEventListener("click",ev=>{ev.preventDefault();scrollToAnchor(root.ownerDocument,frag,root.ownerDocument.defaultView?.frameElement);});
      } else if(sourceTarget && !frag){
        const route=`#/s/${encodeURIComponent(sourceTarget.id)}`;
        a.setAttribute("href",route);a.removeAttribute("target");a.addEventListener("click",ev=>{ev.preventDefault();go(route);});
      } else if(base && DB.profile?.origin && new URL(base).origin===new URL(DB.profile.origin).origin){
        const route=`#/missing/${encodeURIComponent(raw)}`;
        a.setAttribute('href',route);a.removeAttribute('target');a.setAttribute('data-lwl-missing','');a.setAttribute('title',T.missing);
        a.addEventListener('click',ev=>{ev.preventDefault();go(route);});
      } else {
        a.setAttribute("href",raw);a.setAttribute("target","_blank");a.setAttribute("rel","noopener");
        a.setAttribute("data-lwl-missing","");a.setAttribute("title",T.missing);
      }
      if(LWLReferences.hasPreview(a,DB.profile?.referencePolicy))bindReferencePreview(a,{...reference,target});
    }
    if(original)root.addEventListener("click",ev=>{
      if(ev.defaultPrevented)return;
      const link=ev.target.closest("a[href]");
      if(link&&!link.getAttribute("href").startsWith("#/")){
        ev.preventDefault();window.open(link.href,"_blank","noopener");
      }
    });
    for (const table of original ? [] : root.querySelectorAll("table")) {
      if (table.parentElement?.classList.contains("table-scroll")) continue;
      const wrap = document.createElement("div");
      wrap.className = "table-scroll";
      table.replaceWith(wrap);
      wrap.appendChild(table);
    }
    if (entry?.u && !original) {
      const p = document.createElement("p");
      p.style.marginTop = "34px";
      p.innerHTML = `<a class="btn" href="${esc(entry.u)}" target="_blank" rel="noopener">${esc(T.online)}</a>`;
      root.appendChild(p);
    }
  }

  function buildToc(article) {
    const headingsById = new Map();
    const toc = document.getElementById("toc");
    if (!toc) return;
    const heads = [...article.querySelectorAll("h2, h3, h4")].filter((h) => h.textContent.trim());
    if (heads.length < 3) {
      toc.remove();
      return;
    }
    heads.forEach((h, i) => {
      if (!h.id) h.id = "h-" + i + "-" + norm(h.textContent).replace(/[^a-z0-9]+/g, "-").slice(0, 40);
      headingsById.set(h.id, h);
    });
    const entry=byId.get(parseHash().id),source=sourceById.get(entry?.s);
    const inSidebar=document.body.classList.contains('entry-view')&&source?.layout!=='book';
    const roots=[],stack=[];
    for(const h of heads){
      const node={h,level:Number(h.tagName[1]),children:[]};
      while(stack.length&&stack.at(-1).level>=node.level)stack.pop();
      (stack.length?stack.at(-1).children:roots).push(node);stack.push(node);
    }
    const link=h=>`<a href="${esc(Model.routeFor(entry?.id||'',h.id))}" data-to="${esc(h.id)}" data-level="${h.tagName[1]}">${esc(h.textContent.trim())}</a>`;
    const tree=nodes=>nodes.map(({h,children})=>children.length?`<details class="toc-branch"><summary>${link(h)}</summary><div>${tree(children)}</div></details>`:link(h)).join('');
    toc.innerHTML=(inSidebar?`<a class="article-nav-back" href="#/s/${encodeURIComponent(source.id)}">← ${esc(source.name)}</a><div class="article-nav-title">${esc(entry.t)}</div>`:'')+
      `<div class="toc-title">${esc(T.contents)}</div>`+(inSidebar?tree(roots):heads.map(link).join(''));
    if(inSidebar){toc.classList.add('article-nav');nav.prepend(toc);nav.scrollTop=0;}
    toc.addEventListener("click", (ev) => {
      const a = ev.target.closest("[data-to]");
      if (!a) return;
      ev.preventDefault();
      const branch=a.closest('summary')?.parentElement;if(branch)branch.open=true;
      scrollToAnchor(article,a.getAttribute("data-to"),article.ownerDocument.defaultView?.frameElement);
      if(entry)history.pushState(null,'',Model.routeFor(entry.id,a.getAttribute('data-to')));
      app.classList.remove('nav-open');
    });
    const links = new Map([...toc.querySelectorAll("[data-to]")].map((a) => [a.getAttribute("data-to"), a]));
    const active=links.get(Model.decode(parseHash().frag||''));
    if(active)for(let p=active.parentElement;p&&p!==toc;p=p.parentElement)if(p.tagName==='DETAILS')p.open=true;
    const obs = new IntersectionObserver(
      (recs) => {
        for (const r of recs) {
          if (!r.isIntersecting) continue;
          links.forEach((a) => a.classList.remove("active"));
          links.get(r.target.id)?.classList.add("active");
        }
      },
      { rootMargin: "0px 0px -70% 0px", threshold: 0 }
    );
    heads.forEach((h) => obs.observe(h));
    const previousDispose=disposeArticle;disposeArticle=()=>{previousDispose();obs.disconnect();hideGlossary();};
  }

  let glossaryTip,glossaryHideTimer,previewGeneration=0;
  const previewStack=[];
  const detailPreviews=new Map();
  const glossaryDocuments=new WeakSet();
  const glossaryExcerpt=(value,limit=360)=>{
    const text=String(value||'').replace(/\s+/g,' ').trim();
    if(text.length<=limit)return text;
    const start=text.slice(0,limit-1),space=start.lastIndexOf(' ');
    return start.slice(0,space>limit*0.7?space:start.length)+'…';
  };
  function referenceFor(anchor,baseUrl,allowTermAlias=true){
    const raw=anchor.getAttribute('data-lwl-href')||'',base=Model.urlKey(raw,DB.profile,baseUrl);
    let frag=(raw.match(/#(.*)$/)||[])[1]||'',glossary=glossaryByUrl.get(base+'#'+Model.decode(frag));
    if(!glossary&&frag&&allowTermAlias){
      // Some original links use a stale fragment (OpportunityAttack). Accept
      // only one exact term on that same saved page, never another book/edition.
      const matches=(glossaryByPage.get(base)||[]).filter(g=>norm(g.term)===norm(anchor.textContent));
      if(matches.length===1){glossary=matches[0];frag=(glossary.url.match(/#(.*)$/)||[])[1]||frag;}
    }
    return {raw,base,frag,glossary,target:byUrl.get(base)};
  }
  function insidePreview(node){return Boolean(node&&previewStack.some(card=>card.tip.contains(node)));}
  function closePreviewsFrom(depth){
    previewGeneration++;clearTimeout(glossaryHideTimer);
    for(const card of previewStack.splice(depth)){
      card.anchor.removeAttribute('aria-describedby');card.tip.hidden=true;
      if(card.tip!==glossaryTip)card.tip.remove();
    }
  }
  function bindReferencePreview(anchor,reference,parent=null){
    const {target,frag,glossary}=reference;
    const detail=target?.c!=null&&(Boolean(frag)||sourceById.get(target.s)?.type==='catalog');
    if(!glossary?.definition&&!detail)return;
    anchor.removeAttribute('title');for(const child of anchor.querySelectorAll('[title]'))child.removeAttribute('title');
    if(glossary?.definition)anchor.setAttribute('aria-description',glossaryExcerpt(glossary.definition));
    const depthFor=()=>parent?previewStack.indexOf(parent)+1:0;
    const show=async()=>{
      if(parent&&!previewStack.includes(parent))return;
      const depth=depthFor();closePreviewsFrom(depth);
      const request=previewGeneration,version=renderVersion;
      let preview=glossary;
      if(target?.c!=null)try{preview=(await storedDetailPreview(target,frag,LWLReferences.kind(anchor),anchor.textContent))||glossary;}catch{/* A missing content chunk may still have a stored glossary definition. */}
      if(preview&&request===previewGeneration&&version===renderVersion&&anchor.isConnected&&(!parent||previewStack.includes(parent))){
        anchor.setAttribute('aria-description',glossaryExcerpt(preview.definition));showGlossary(anchor,preview,depth);
      }
    };
    anchor.addEventListener('mouseenter',show);anchor.addEventListener('focus',show);
    anchor.addEventListener('mouseleave',()=>queueHideGlossary(depthFor()));
    // Focus moving out of a sandboxed article frame can report relatedTarget
    // as null. Let the destination card receive focus/click before closing.
    anchor.addEventListener('blur',ev=>{if(!insidePreview(ev.relatedTarget))queueHideGlossary(depthFor());});
    anchor.addEventListener('click',hideGlossary);
    const doc=anchor.ownerDocument;
    if(!glossaryDocuments.has(doc)){
      glossaryDocuments.add(doc);
      doc.addEventListener('scroll',ev=>{
        const depth=previewStack.findIndex(card=>card.tip.contains(ev.target));
        if(depth<0)hideGlossary();else if(depth+1<previewStack.length)closePreviewsFrom(depth+1);
      },true);
      doc.addEventListener('keydown',ev=>{if(ev.key==='Escape')hideGlossary();});
    }
  }
  async function storedDetailPreview(entry,fragment='',type='',term=''){
    // Skills share one #Skills URL. The visible label is part of their identity;
    // different spell editions continue to use their exact saved entry ID.
    const key=JSON.stringify([entry.id,Model.decode(fragment),type,type==='skill'?norm(term):'']);
    if(detailPreviews.has(key))return detailPreviews.get(key);
    const html=(await loadChunk(entry.c))?.[entry.id];if(!html)return null;
    const template=document.createElement('template');template.innerHTML=html;
    LWLPresentation.clean(template.content,DB.profile?.presentationPolicy);
    const root=template.content.querySelector('[data-lwl-article-root]')||template.content;
    const preview=LWLReferences.articlePreview(root,{term:term||entry.t,fragment:Model.decode(fragment),type,meta:entry.m});
    if(!preview)return null;
    // The link label may be abbreviated or plural; details retain their title.
    if(!fragment)preview.term=entry.t;
    detailPreviews.set(key,preview);
    if(detailPreviews.size>100)detailPreviews.delete(detailPreviews.keys().next().value);
    return preview;
  }
  function hideGlossary(){closePreviewsFrom(0);}
  function queueHideGlossary(depth=0){previewGeneration++;clearTimeout(glossaryHideTimer);glossaryHideTimer=setTimeout(()=>closePreviewsFrom(depth),240);}
  window.addEventListener('resize',hideGlossary);
  window.addEventListener('keydown',ev=>{if(ev.key==='Escape')hideGlossary();});
  function showGlossary(anchor,entry,depth=0){
    clearTimeout(glossaryHideTimer);
    let tip=depth===0?glossaryTip:null;
    if(!tip){
      tip=document.createElement('div');tip.id='lwl-reference-preview-'+depth;tip.className='glossary-tip';tip.setAttribute('role','tooltip');document.body.appendChild(tip);
      tip.addEventListener('mouseenter',()=>clearTimeout(glossaryHideTimer));
      tip.addEventListener('mouseleave',()=>queueHideGlossary(0));
      tip.addEventListener('focusin',()=>clearTimeout(glossaryHideTimer));
      tip.addEventListener('focusout',ev=>{if(!insidePreview(ev.relatedTarget))queueHideGlossary(0);});
      if(depth===0)glossaryTip=tip;
    }
    const card={tip,anchor};previewStack.push(card);
    if(anchor.ownerDocument===document)anchor.setAttribute('aria-describedby',tip.id);
    tip.replaceChildren();tip.classList.toggle('rich-preview',Boolean(entry.html));tip.style.zIndex=String(1000+depth);
    tip.dataset.kind=entry.type||'';tip.dataset.depth=String(depth);
    const header=document.createElement('div');header.className='preview-header';
    if(entry.icon){const icon=document.createElement('img');icon.src=entry.icon;icon.alt='';header.append(icon);}
    const heading=document.createElement('div'),title=document.createElement("strong");title.className='preview-title';title.textContent=entry.term;heading.append(title);
    if(entry.subtitle){const subtitle=document.createElement('div');subtitle.className='preview-source';subtitle.textContent=entry.subtitle;heading.append(subtitle);}
    header.append(heading);
    if(entry.type){const kind=document.createElement('span');kind.className='preview-kind';kind.textContent=entry.type.replace(/-/g,' ');header.append(kind);}
    const body=document.createElement('div');body.className='preview-body';
    if(entry.stats?.length){const stats=document.createElement('dl');stats.className='preview-stats';for(const item of entry.stats){const cell=document.createElement('div'),label=document.createElement('dt'),value=document.createElement('dd');label.textContent=item.label;value.textContent=item.value;cell.append(label,value);stats.append(cell);}body.append(stats);}
    const definition=document.createElement('div');definition.className='preview-description';
    if(entry.html)definition.innerHTML=entry.html;
    else {const p=document.createElement('p');p.textContent=entry.definition;definition.append(p);}
    // Links in the saved definition use the same local URL/alias map as pages.
    for(const link of definition.querySelectorAll('a[data-lwl-href]')){
      const reference=referenceFor(link),{raw,base,target,frag}=reference,source=sourceByUrl.get(base);
      const route=target?Model.routeFor(target.id,frag):source&&!frag?`#/s/${encodeURIComponent(source.id)}`:base&&new URL(base).origin===DB.profile?.origin?`#/missing/${encodeURIComponent(raw)}`:null;
      if(route){link.setAttribute('href',route);link.addEventListener('click',ev=>{ev.preventDefault();hideGlossary();go(route);});}
      else if(/^https?:\/\//i.test(raw)){link.href=raw;link.target='_blank';link.rel='noopener';}
      bindReferencePreview(link,reference,card);
    }
    body.append(definition);tip.append(header,body);
    const rect=anchor.getBoundingClientRect(),frame=anchor.ownerDocument.defaultView?.frameElement?.getBoundingClientRect();
    tip.hidden=false;
    const box=tip.getBoundingClientRect();let left=rect.left+(frame?.left||0);
    let top=rect.bottom+(frame?.top||0)+8;
    if(depth){const parent=previewStack[depth-1].tip.getBoundingClientRect();left=parent.right+8+box.width<=innerWidth-8?parent.right+8:parent.left-box.width-8>=8?parent.left-box.width-8:parent.left+32;}
    if(top+box.height>innerHeight-8)top=rect.top+(frame?.top||0)-box.height-8;
    tip.style.left=`${Math.max(8,Math.min(innerWidth-box.width-8,left))}px`;
    tip.style.top=`${Math.max(8,Math.min(innerHeight-box.height-8,top))}px`;
  }

  /* ---------------- search ---------------- */
  async function renderSearch(route) {
    const raw = route.q || "";
    qInput.value = raw;
    const needle = norm(raw);
    if (needle.length < 2) return renderHome();

    let hits;
    if (state.scope === "full" && DB.fts) {
      const fts = await loadFts();
      hits = ftsSearch(fts, needle);
    } else {
      hits = entries.filter((e) => e._k.includes(needle));
    }

    const bySource = new Map();
    for (const e of hits) {
      if (!bySource.has(e.s)) bySource.set(e.s, []);
      bySource.get(e.s).push(e);
    }

    const scopeHtml = DB.fts
      ? `<div class="scope"><button data-scope="titles" class="${state.scope === "titles" ? "on" : ""}">${esc(T.titles)}</button>` +
        `<button data-scope="full" class="${state.scope === "full" ? "on" : ""}">${esc(T.fullText)}</button></div>`
      : "";

    const groupsHtml = [...bySource.entries()]
      .map(([sid, list]) => {
        const s = sourceById.get(sid);
        const shown = list.slice(0, 40);
        return (
          `<h2 class="nav-title" style="padding-left:0;margin:26px 0 10px">${esc(s?.name || sid)} · ${list.length}</h2>` +
          `<div class="entry-list">${shown.map((e) => searchRow(e, s, needle)).join("")}</div>` +
          (list.length > shown.length
            ? `<p class="lede" style="margin-top:10px"><a href="#/s/${encodeURIComponent(sid)}">${esc(T.loadMore)} →</a></p>`
            : "")
        );
      })
      .join("");

    main.innerHTML =
      `<div class="page">` +
      breadcrumb([[T.library, "#/"], [`“${raw}”`, null]]) +
      `<div class="page-head"><h1>${hits.length} ${esc(T.results)}</h1></div>` +
      `<div class="toolbar">${scopeHtml}<span class="result-count">${hits.length} ${esc(T.entries)}</span></div>` +
      (hits.length ? groupsHtml : `<div class="empty"><h2>${esc(T.noResults)}</h2><p>${esc(T.noResultsHint)}</p></div>`) +
      `</div>`;

    main.querySelectorAll("[data-scope]").forEach((b) =>
      b.addEventListener("click", () => {
        state.scope = b.getAttribute("data-scope");
        renderSearch(route);
      })
    );
  }

  function searchRow(e, source, needle) {
    const html = entryRow(e, source);
    if (!needle) return html;
    return html.replace(/(<span class="name">)([^<]*)(<\/span>)/, (all, a, txtRaw, c) => {
      const i = norm(txtRaw).indexOf(needle);
      if (i < 0) return all;
      return a + txtRaw.slice(0, i) + "<mark>" + txtRaw.slice(i, i + needle.length) + "</mark>" + txtRaw.slice(i + needle.length) + c;
    });
  }

  function ftsSearch(fts, needle) {
    if (!fts?.t) return entries.filter((e) => e._k.includes(needle));
    const words = needle.split(" ").filter((w) => w.length >= 2);
    if (!words.length) return [];
    let acc = null;
    for (const w of words) {
      const ids = new Set();
      for (const term of Object.keys(fts.t)) {
        if (term.startsWith(w)) for (const i of fts.t[term]) ids.add(i);
      }
      acc = acc === null ? ids : new Set([...acc].filter((x) => ids.has(x)));
      if (!acc.size) break;
    }
    const out = [...(acc || [])].map((i) => entries[i]).filter(Boolean);
    // Title matches first, then alphabetical.
    return out.sort((a, b) => Number(b._k.includes(needle)) - Number(a._k.includes(needle)) || cmpTitle(a, b));
  }

  /* ---------------- chrome ---------------- */
  qInput.placeholder = T.search;
  document.getElementById("brandName").textContent = DB.profile?.name || T.library;
  document.getElementById("brandSub").textContent = `${entries.length} ${T.entries}`;
  document.title = `${DB.profile?.name || T.library} – ${T.library}`;

  qInput.addEventListener(
    "input",
    debounce(() => {
      const v = qInput.value.trim();
      if (v.length >= 2) go("#/q/" + encodeURIComponent(v));
      else if (parseHash().view === "search") go("#/");
    }, 180)
  );

  qInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      qInput.value = "";
      qInput.blur();
      go("#/");
    }
  });

  document.addEventListener("keydown", (ev) => {
    if (ev.key === "/" && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName || "")) {
      ev.preventDefault();
      qInput.focus();
      qInput.select();
    }
  });

  document.getElementById("menuBtn").addEventListener("click", () => app.classList.toggle("nav-open"));

  const themeBtn = document.getElementById("themeBtn");
  themeBtn.addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const dark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("lwl-theme", next);
    } catch (e) {}
    applyTheme(themeForRoute(parseHash()));
  });

  addEventListener("hashchange", render);
  render();
})();
