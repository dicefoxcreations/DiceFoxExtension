/* Explicit link semantics shared by capture output and offline rendering. */
(() => {
  'use strict';
  function hasPreview(anchor,policy={}){
    if(anchor.hasAttribute('data-lwl-preview'))return true;
    if(!policy.previewSelector)return false;
    try{return anchor.matches(policy.previewSelector);}catch{return false;}
  }
  function glossaryEntries(records,sources){
    const ids=new Set(sources.filter(s=>s.type==='glossary').map(s=>s.id));
    return records.filter(r=>ids.has(r.sourceId)).flatMap(r=>(r.glossaryEntries||[]).map(g=>({...g,entryId:r.id})));
  }
  const text=node=>String(node?.textContent||'').replace(/\s+/g,' ').trim();
  const norm=value=>String(value||'').replace(/\s+/g,' ').trim().toLocaleLowerCase();
  function kind(anchor){
    return ['spell','condition','skill','action','monster','magic-item','item'].find(name=>anchor.classList.contains(name+'-tooltip')||anchor.getAttribute('data-lwl-preview-kind')===name)||'';
  }
  // Keep the saved formatting, but never replay page styles, handlers, forms or
  // remote resources inside a preview in the Reader's own document.
  function previewHtml(node){
    const doc=node.ownerDocument,box=doc.createElement('div');box.append(node.cloneNode(true));
    box.querySelectorAll('script,style,iframe,object,embed,svg,form,input,button,select,textarea,img,video,audio,link,meta,nav,aside,footer').forEach(n=>n.remove());
    for(const el of [...box.querySelectorAll('*')]){
      if(!/^(P|DIV|SECTION|ARTICLE|SPAN|UL|OL|LI|STRONG|EM|B|I|U|S|BR|HR|TABLE|CAPTION|THEAD|TBODY|TFOOT|TR|TH|TD|DL|DT|DD|SUP|SUB|A|H[1-6])$/.test(el.tagName)){el.replaceWith(...el.childNodes);continue;}
      const href=el.tagName==='A'?(el.getAttribute('data-lwl-href')||el.getAttribute('href')):null;
      const type=el.tagName==='A'?kind(el):'';
      for(const attr of [...el.attributes])if(!/^(colspan|rowspan)$/.test(attr.name))el.removeAttribute(attr.name);
      if(href&&/^https?:\/\//i.test(href))el.setAttribute('data-lwl-href',href);
      if(type)el.setAttribute('data-lwl-preview-kind',type);
      if(el.tagName==='A'&&!text(el))el.remove();
    }
    return box.innerHTML;
  }
  function section(root,fragment){
    const heading=[...root.querySelectorAll('[id],a[name]')].find(n=>n.id===fragment||n.getAttribute('name')===fragment);
    if(!heading)return null;
    // Named anchors may precede the visible heading; wrapper IDs contain it.
    const h=/^H[1-6]$/.test(heading.tagName)?heading:heading.querySelector('h1,h2,h3,h4,h5,h6')||(/^H[1-6]$/.test(heading.nextElementSibling?.tagName)?heading.nextElementSibling:heading);
    const doc=root.ownerDocument,range=doc.createRange(),level=Number(h.tagName[1])||6;
    const next=[...root.querySelectorAll('h1,h2,h3,h4,h5,h6')].find(n=>(h.compareDocumentPosition(n)&4)&&Number(n.tagName[1])<=level);
    range.setStartAfter(h);if(next)range.setEndBefore(next);else range.setEnd(root,root.childNodes.length);
    return {heading:h,content:range.cloneContents()};
  }
  function articlePreview(root,{term,fragment='',type='',source='',meta={}}={}){
    const doc=root.ownerDocument;
    if(fragment){
      const part=section(root,fragment);if(!part)return null;
      if(type==='skill'){
        const table=part.heading.closest('table')||part.content.querySelector('table');
        const row=table&&[...table.querySelectorAll('tr')].find(r=>norm(r.cells[0]?.textContent)===norm(term));
        if(!row||row.cells.length<3)return null;
        const ability=text(row.cells[1]),definition=text(row.cells[2]);
        return {term:ability?`${ability} (${text(row.cells[0])})`:term,type,definition,html:previewHtml(row.cells[2].cloneNode(true))};
      }
      const definition=text(part.content);if(!definition)return null;
      return {term:text(part.heading)||term,type,definition,html:previewHtml(part.content)};
    }
    const content=root.querySelector('.more-info-content')||root.querySelector('.detail-content')||root;
    const stats=[...root.querySelectorAll('.ddb-statblock-item')].map(n=>({label:text(n.querySelector('.ddb-statblock-item-label')),value:text(n.querySelector('.ddb-statblock-item-value'))})).filter(n=>n.label&&n.value);
    const definition=text(content);if(!definition)return null;
    const icon=root.querySelector('img.spell-image')?.getAttribute('src');
    return {term,type,subtitle:String(meta.source||source||''),stats,definition,html:previewHtml(content),icon:icon&&/^(assets\/|data:image\/)/.test(icon)?icon:null};
  }
  globalThis.LWLReferences=Object.freeze({hasPreview,glossaryEntries,kind,previewHtml,articlePreview});
})();
