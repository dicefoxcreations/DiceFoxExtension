/* Shared presentation rules. No website or product names belong here. */
(() => {
  'use strict';
  const text = value => String(value || '').replace(/\s+/g, ' ').trim();
  const words = value => text(value).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ');
  const query = (root, selector) => { try { return selector ? [...root.querySelectorAll(selector)] : []; } catch { return []; } };
  function title(value) {
    const raw = text(value);
    if (!raw || /^(?:https?:\/\/|\/[^\s]+(?:\/|\?))/i.test(raw)) return '';
    const parts = raw.split(/\s+[|–—-]\s+/);
    const key = s => words(s).replace(/\s/g, '');
    // Repeated document-title prefixes are SEO trails, not part of the name.
    if (parts.length > 2 && key(parts[0]) === key(parts[1])) return parts[0];
    return raw;
  }
  function chooseTitle(values, fallback = 'Untitled document') {
    return values.map(title).find(Boolean) || fallback;
  }
  function chapterTitle(value, book) {
    const clean=title(value), parts=clean.split(/\s+[|–—-]\s+/);
    const index=parts.findIndex(part=>words(part)===words(book));
    return index>0?parts.slice(0,index).join(' – '):clean;
  }
  function fitDocument(doc) {
    const root=doc.querySelector('[data-lwl-article-root]')||doc.querySelector('article,main')||doc.body;
    for(let el=root.parentElement;el&&el!==doc.documentElement;el=el.parentElement){
      for(const [key,value] of Object.entries({width:'auto',minWidth:'0',maxWidth:'100%',height:'auto',minHeight:'0',display:'block',position:'static',float:'none',marginLeft:'0',marginRight:'0',marginTop:'0',paddingTop:'0',paddingLeft:'0',paddingRight:'0',boxSizing:'border-box',overflow:'visible'}))el.style[key]=value;
    }
    root.style.minWidth='0';root.style.maxWidth='100%';root.style.width='auto';
    // Captured themes can reserve space for header controls that were removed.
    for(const header of root.querySelectorAll('header'))if(typeof header.innerText==='string'&&!header.innerText.trim()&&![...header.querySelectorAll('img,svg,video')].some(el=>el.getClientRects().length>0))header.remove();
    const style=doc.createElement('style');style.textContent='html{min-width:0!important;width:100%!important;box-sizing:border-box}body{min-width:0!important;margin:0!important;padding:clamp(12px,3vw,32px)!important;box-sizing:border-box}img,svg,video{max-width:100%;height:auto}pre{max-width:100%;overflow:auto}[data-lwl-table-scroll]{max-width:100%;overflow:auto;overscroll-behavior-x:contain}';doc.head.append(style);
    for(const table of [...root.querySelectorAll('table')]){
      if(table.closest('[data-lwl-table-scroll]'))continue;
      const scroll=doc.createElement('div');scroll.dataset.lwlTableScroll='';scroll.tabIndex=0;scroll.setAttribute('role','region');scroll.setAttribute('aria-label',table.caption?.textContent||'Table');
      table.before(scroll);scroll.append(table);
    }
  }
  const chromeWords = /(?:^| )(?:cookie\w*|consent\w*|gdpr|newsletter|advert\w*|adsense|adslot|promo\w*|upsell|announcement\w*|site header|site footer|global header|global footer|global nav\w*|navigation menu\w*|mega menu\w*|menu nav|navbar|nav|navigation|pagination|pager|nav menu|user actions?|user menu|account menu|profile menu|social|sharing|subscribe|subscription\w*|signup|breadcrumbs?)(?: |$)/;
  function clean(root, {controlsSelector = null, listSelector = null, paginationSelector = null, excludeSelectors = []} = {}) {
    if (!root) return root;
    for (const selector of excludeSelectors) for (const el of query(root, selector)) el.remove();
    const protectedNodes = [...query(root, controlsSelector), ...query(root, listSelector), ...query(root, paginationSelector)];
    const protectedTree = el => protectedNodes.some(node => el === node || el.contains(node) || node.contains(el));
    // Decide before removing descendants: a header's navigation is evidence
    // that the whole header is site chrome, including its promotional bars.
    const remove = [];
    for (const el of query(root, '*')) {
      if (protectedTree(el)) continue;
      const tokens = words(`${el.id} ${typeof el.className === 'string' ? el.className : ''}`);
      const role = el.getAttribute('role');
      const contentHeader = /(?:^| )(?:page|article|content) header(?: |$)/.test(tokens) || el.closest('article,main,[role="main"]');
      const globalHeader = el.tagName === 'HEADER' && !contentHeader && (el.querySelector('nav,[role="navigation"]') || chromeWords.test(tokens));
      const article = el.closest('article,main,[role="main"],[data-lwl-article-root]');
      const outsideArticle = !article || (article === root && !root.matches('article,main,[role="main"]'));
      if (el.tagName === 'NAV' || ['navigation','banner','contentinfo'].includes(role) || chromeWords.test(tokens)
          || globalHeader || (el.tagName === 'FOOTER' && outsideArticle)) remove.push(el);
    }
    for (const el of remove) el.remove();
    // Preserve page headings but remove their site-action strips. The reader
    // supplies navigation and can only operate on its own saved collection.
    for (const header of query(root, 'header')) {
      if (protectedTree(header) || header.closest('article')) continue;
      for (const el of query(header, 'a,button,select')) {
        if (protectedTree(el) || el.closest('h1,h2,h3')) continue;
        el.remove();
      }
    }
    return root;
  }
  function imageUrl(raw, base) {
    if (!raw) return null;
    try { const u = new URL(raw, base); return /^(https?:|file:)$/.test(u.protocol) ? u.href : /^data:image\//i.test(raw) ? raw : null; } catch { return null; }
  }
  function cover(root, base, {card = false} = {}) {
    if (!root) return null;
    const candidates = [];
    for (const img of query(root, 'img')) {
      const tokens = words(`${img.className} ${img.alt} ${img.parentElement?.className || ''}`);
      if (/\b(?:avatar|logo|icon|tracking)\b/.test(tokens)) continue;
      const raw = img.getAttribute('data-lwl-src') || img.currentSrc || img.getAttribute('data-src') || img.getAttribute('src');
      const url = imageUrl(raw, base); if (!url) continue;
      const w = Number(img.getAttribute('width') || img.naturalWidth), h = Number(img.getAttribute('height') || img.naturalHeight);
      const explicit = /\b(?:cover|bookcover|thumbnail)\b/.test(tokens);
      if (explicit || card) candidates.push({url,score:(explicit ? 10 : 0) + (h > w && w > 30 ? 3 : 0)});
    }
    for (const a of query(root, 'a[href],a[data-lwl-href]')) {
      if (!/\bcover\b/.test(words(`${a.className} ${a.textContent}`))) continue;
      const raw = a.getAttribute('data-lwl-href') || a.getAttribute('href');
      if (/\.(?:png|jpe?g|webp|avif)(?:[?#]|$)/i.test(raw || '')) candidates.push({url:imageUrl(raw,base),score:12});
    }
    return candidates.filter(x=>x.url).sort((a,b)=>b.score-a.score)[0]?.url || null;
  }
  globalThis.LWLPresentation = Object.freeze({title,chooseTitle,chapterTitle,clean,cover,fitDocument});
})();
