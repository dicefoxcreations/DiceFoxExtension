(() => {
  "use strict";
  function normalizeOrigin(raw) {
    try {
      const u = new URL(raw);
      if (!/^https?:$/.test(u.protocol)) return null;
      return u.origin;
    } catch { return null; }
  }
  function absoluteUrl(raw, profile, base) {
    try {
      return new URL(raw, base || profile?.origin || undefined);
    } catch { return null; }
  }
  function canonicalUrl(raw, profile, base) {
    const u = absoluteUrl(raw, profile, base);
    if (!u) return null;
    if (profile?.origin && u.origin !== normalizeOrigin(profile.origin)) return u.href;
    u.hash = "";
    const cfg = profile?.canonicalization || {};
    for(const [from,to] of Object.entries(cfg.pathAliases || {})) {
      if(!from.startsWith("/") || !String(to).startsWith("/") || String(to).startsWith("//"))continue;
      if(u.pathname===from || u.pathname.startsWith(from+"/")){u.pathname=to+u.pathname.slice(from.length);break;}
    }
    const drop = new Set([...(cfg.dropQueryParams || []), "utm_source","utm_medium","utm_campaign","utm_term","utm_content","gclid","fbclid"]);
    if (cfg.dropAllQuery === true) u.search = "";
    else {
      [...u.searchParams.keys()].forEach(k => { if (drop.has(k)) u.searchParams.delete(k); });
      if (Array.isArray(cfg.keepQueryParams) && cfg.keepQueryParams.length) {
        const keep = new Set(cfg.keepQueryParams);
        [...u.searchParams.keys()].forEach(k => { if (!keep.has(k)) u.searchParams.delete(k); });
      }
      u.searchParams.sort();
    }
    u.pathname = (u.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") || "/");
    return u.href;
  }
  function sameOrigin(raw, profile, base) {
    const u = absoluteUrl(raw, profile, base);
    return Boolean(u && normalizeOrigin(profile?.origin) === u.origin);
  }
  function profileId(profile) {
    if (profile?.id) return String(profile.id).replace(/[^a-zA-Z0-9_-]/g, "-");
    const s = `${profile?.origin || "site"}|${profile?.name || "profile"}`;
    let h = 0x811c9dc5;
    for (let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h,0x01000193); }
    return `p-${(h>>>0).toString(16).padStart(8,"0")}`;
  }
  function matchesAny(url, patterns = []) {
    return (patterns || []).some(p => {
      try { return new RegExp(p, "i").test(url); } catch { return String(url).includes(String(p)); }
    });
  }
  function slugFromUrl(raw, fallback = "page") {
    try {
      const u = new URL(raw);
      const parts = u.pathname.split("/").filter(Boolean).slice(-3).join("--") || u.hostname;
      return decodeURIComponent(parts || fallback);
    } catch { return fallback; }
  }
  globalThis.LWLUrl = Object.freeze({ normalizeOrigin, absoluteUrl, canonicalUrl, sameOrigin, profileId, matchesAny, slugFromUrl });
})();
