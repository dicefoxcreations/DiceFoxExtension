/* Storage accounting and conservative reachability planning. No website rules. */
(() => {
  "use strict";
  const TEMP_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
  const prefix = id => `lwl:${id}:`;
  const bytes = (key, value) => new TextEncoder().encode(key + JSON.stringify(value)).length;
  const temporary = key => key === "lwl_pending_detection" || key.startsWith("lwl_detection_scan_") || key.startsWith('lwl_guided_');
  const owner = key => /^lwl:([^:]+):/.exec(key)?.[1] || null;

  function summarize(all, resources, writes, profiles, localBytes) {
    const groups = new Map(profiles.map(p => [p.id, { id: p.id, name: p.name, orphan: false, localBytes: 0, records: 0, resourceBytes: 0, resources: 0, writeBytes: 0, writes: 0 }]));
    const group = id => {
      if (!groups.has(id)) groups.set(id, { id, name: id, orphan: true, localBytes: 0, records: 0, resourceBytes: 0, resources: 0, writeBytes: 0, writes: 0 });
      return groups.get(id);
    };
    let temporaryBytes = 0;
    for (const [key, value] of Object.entries(all)) {
      const id = profiles.find(p => key.startsWith(prefix(p.id)))?.id || owner(key);
      if (id) { const row = group(id); row.localBytes += bytes(key, value); row.records++; }
      if (temporary(key)) temporaryBytes += bytes(key, value);
    }
    for (const resource of resources) { const row = group(resource.profileId); row.resourceBytes += resource.bytes; row.resources++; }
    for (const write of writes) if (write.profileId) { const row = group(write.profileId); row.writeBytes += write.bytes; row.writes++; }
    const resourceBytes = resources.reduce((n, r) => n + r.bytes, 0), writeBytes = writes.reduce((n, r) => n + r.bytes, 0);
    return { localBytes, resourceBytes, writeBytes, temporaryBytes, totalBytes: localBytes + resourceBytes + writeBytes,
      profiles: [...groups.values()].map(p => ({ ...p, totalBytes: p.localBytes + p.resourceBytes + p.writeBytes })), writes };
  }

  function resourceUrl(value) { try { const u = new URL(value); u.hash = ""; return u.href; } catch { return value; } }
  function references(text) {
    const result = [];
    for (const m of text.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')|(?:src|data-lwl-src|href|xlink:href)=["']([^"']+)["']/gi)) {
      const raw = m.slice(1).find(value => value !== undefined) || "";
      result.push(raw.trim().replace(/&amp;/g, "&").replace(/\\([0-9a-f]{1,6})\s?|\\(.)/gi, (_,hex,escaped) => hex ? String.fromCodePoint(Math.min(parseInt(hex,16),0x10ffff)) : escaped));
    }
    return result;
  }
  function urlsIn(value, result = new Set()) {
    if (typeof value === "string") {
      const text = value.replace(/&quot;|&#34;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&amp;/gi, "&");
      for (const match of text.matchAll(/https?:\/\/[^\s"'<>`\\)]+/gi)) result.add(resourceUrl(match[0]));
      if (/^https?:\/\//i.test(text.trim())) result.add(resourceUrl(text.trim()));
      for (const ref of references(text)) if (/^https?:\/\//i.test(ref)) result.add(resourceUrl(ref));
    } else if (Array.isArray(value)) { for (const child of value) urlsIn(child, result); }
    else if (value && typeof value === "object") { for (const child of Object.values(value)) urlsIn(child, result); }
    return result;
  }

  async function planKeys(keys, profileId, resources, readRecord, readResource, measure) {
    const base = prefix(profileId), stylePrefix = `${base}styles:capture-`;
    const ownKeys = keys.filter(key=>key.startsWith(base));
    const usedStyles = new Set(), urls = new Set();
    for (const key of ownKeys) if (!key.startsWith(`${base}styles:`)) {
      const record = await readRecord(key);
      if (record?.styleId) usedStyles.add(stylePrefix + record.styleId);
      urlsIn(record, urls);
    }
    const localKeys = [];
    for (const key of ownKeys) if (key.startsWith(`${base}styles:`)) {
      if (key.startsWith(stylePrefix) && !usedStyles.has(key)) localKeys.push(key);
      else urlsIn(await readRecord(key), urls);
    }
    const own = resources.filter(r => r.profileId === profileId);
    // Follow resource dependencies to a fixed point. A retained CSS import can
    // reference another stylesheet, a font, a background, or an SVG resource.
    const scanned = new Set();
    for (;;) {
      const next = own.find(r => !scanned.has(r.key) && urls.has(resourceUrl(r.url)) && (/css|svg/i.test(r.type) || /\.(?:css|svg)(?:[?#]|$)/i.test(r.url)));
      if (!next) break;
      scanned.add(next.key);
      const blob = await readResource(profileId, next.url);
      if (!blob) throw new Error("A retained resource disappeared during cache analysis");
      const text = await blob.text();
      urlsIn(text, urls);
      for (const ref of references(text)) {
        try { urls.add(resourceUrl(new URL(ref, next.url).href)); } catch {}
      }
    }
    const unused = own.filter(r => !urls.has(resourceUrl(r.url)));
    return { localKeys, resourceKeys: unused.map(r => r.key),
      bytes: await measure(localKeys) + unused.reduce((n, r) => n + r.bytes, 0) };
  }

  async function plan(all, profileId, resources, readResource) {
    return planKeys(Object.keys(all),profileId,resources,key=>all[key],readResource,
      keys=>keys.reduce((n,key)=>n+bytes(key,all[key]),0));
  }

  function expiredTemporaryKeys(all, now = Date.now()) {
    const keys = Object.keys(all).filter(temporary);
    const times = keys.flatMap(key => [all[key]?.updatedAt, all[key]?.createdAt, all[key]?.finishedAt].map(value => typeof value === "number" ? value : Date.parse(value)).filter(Number.isFinite));
    // Missing timestamps are not evidence that an interrupted detection is old.
    if (!times.length || now - Math.max(...times) <= TEMP_MAX_AGE) return [];
    return keys;
  }
  function detectionBusy(all, now = Date.now()) {
    const state = all.lwl_detection_scan_debug_meta_v1;
    const time = Date.parse(state?.updatedAt);
    return Boolean(state?.running && (!Number.isFinite(time) || now - time < TEMP_MAX_AGE));
  }
  globalThis.LWLStorage = Object.freeze({ prefix, bytes, summarize, plan, planKeys, expiredTemporaryKeys, detectionBusy, urlsIn });
})();
