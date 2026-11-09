/* Shared by the exporter and the file:// reader. No DOM or Chrome dependency. */
(() => {
  "use strict";
  const clean = value => String(value ?? "").replace(/\s+/g, " ").trim();
  const norm = value => clean(value).toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const facetValue = value => clean(value).replace(/,\s*(?:pp?|pg|page|S|Seite)\.?\s*\d+(?:\s*[-\u2013]\s*\d+)?\s*$/i, "");
  const facetKey = def => String(def.name || def.label || "filter").replace(/^filter[-_]?/i, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  // Nonempty values labelled "All" or "Any" can be genuine categories (for
  // example a creature that speaks all languages), not placeholder options.
  const selectableOptions = def => (def.options || []).filter(o => !o.disabled && clean(o.value) !== "" && !/^(choose.*|select.*|\u2014|-)$/i.test(clean(o.label))).map(o => ({ value: String(o.value), label: clean(o.label || o.value) }));
  function matchesFacets(entry, selections, definitions = []) {
    for (const [key, wanted] of Object.entries(selections)) {
      const wants = (Array.isArray(wanted) ? wanted : [wanted]).filter(v => v !== "" && v != null);
      if (!wants.length) continue;
      const exact = definitions.find(f => f.key === key)?.exact;
      const raw = exact ? entry.f?.[key] : entry.m?.[key];
      const have = (Array.isArray(raw) ? raw : raw == null ? [] : [raw]).map(v => norm(exact ? v : facetValue(v)));
      if (!wants.some(v => have.includes(norm(exact ? v : facetValue(v))))) return false;
    }
    return true;
  }
  function numeric(value){
    const match=clean(value).match(/^(-?\d+(?:\.\d+)?)(?:\s*\/\s*(\d+(?:\.\d+)?))?/);
    if(!match || (match[2]&&Number(match[2])===0))return NaN;
    return Number(match[1])/(match[2]?Number(match[2]):1);
  }
  function matchesBinding(entry,binding,values,labels=new Map()){
    const raw=[binding.field,...(binding.fallbackFields||[])].map(k=>entry.m?.[k]).find(v=>v!=null&&v!=='');
    const have=(Array.isArray(raw)?raw:raw==null?[]:[raw]);
    const wanted=values.map(v=>binding.values?.[v]??labels.get(v)??v);
    if(binding.operator==='gte'||binding.operator==='lte')return wanted.some(v=>have.some(h=>binding.operator==='gte'?numeric(h)>=numeric(v):numeric(h)<=numeric(v)));
    return wanted.some(v=>have.some(h=>norm(facetValue(h))===norm(facetValue(v))));
  }
  function inferFilterBinding(name,entries){
    // A field name must match the control's name. Coincidentally shared values
    // (e.g. "Yes" in unrelated fields) are not evidence of a filter mapping.
    const key=facetKey({name});
    const fields=new Set(entries.flatMap(e=>Object.keys(e.m||{})));
    const candidates=[...fields].filter(f=>f===key||f.endsWith('-'+key));
    const field=candidates.find(f=>f===key)||(candidates.length===1?candidates[0]:null);
    return field?{name,field}:null;
  }
  function urlKey(raw, profile = {}, base) {
    try {
      const u = new URL(raw, base || profile.origin);
      u.hash = "";
      const cfg = profile.canonicalization || {};
      if(!profile.origin || u.origin===new URL(profile.origin).origin)for(const [from,to] of Object.entries(cfg.pathAliases || {})) {
        if(!from.startsWith("/") || !String(to).startsWith("/") || String(to).startsWith("//"))continue;
        if(u.pathname===from || u.pathname.startsWith(from+"/")){u.pathname=to+u.pathname.slice(from.length);break;}
      }
      const drop = new Set([...(cfg.dropQueryParams || []), "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "gclid", "fbclid"]);
      if (cfg.dropAllQuery) u.search = "";
      else {
        for (const key of [...u.searchParams.keys()]) if (drop.has(key) || (cfg.keepQueryParams?.length && !cfg.keepQueryParams.includes(key))) u.searchParams.delete(key);
        u.searchParams.sort();
      }
      u.pathname = u.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/";
      return u.href;
    } catch { return null; }
  }
  function decode(value) { try { return decodeURIComponent(value); } catch { return value; } }
  const routeFor = (id, fragment = "") => `#/e/${encodeURIComponent(id)}${fragment ? "|" + encodeURIComponent(decode(fragment)) : ""}`;
  globalThis.LWLReaderModel = Object.freeze({clean, norm, facetValue, facetKey, selectableOptions, matchesFacets, numeric, matchesBinding, inferFilterBinding, urlKey, decode, routeFor});
})();
