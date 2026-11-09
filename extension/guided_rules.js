/* Declarative selectors learned from user-selected page elements. */
(() => {
  'use strict';
  const escape=value=>globalThis.CSS?.escape?CSS.escape(String(value)):String(value).replace(/[^a-zA-Z0-9_-]/g,c=>'\\'+c);
  const query=(root,selector)=>{try{return [...root.querySelectorAll(selector)];}catch{return [];}};
  const text=el=>String(el?.textContent||'').replace(/\s+/g,' ').trim();
  function token(el){
    const tag=el.tagName.toLowerCase();
    const classes=[...el.classList].filter(c=>c.length<70&&!/^(active|selected|open|closed|hidden|hover|focus|disabled)$/i.test(c)&&!/[a-f0-9]{10,}/i.test(c));
    if(classes.length)return tag+classes.slice(0,2).map(c=>'.'+escape(c)).join('');
    for(const key of ['itemprop','data-testid','role'])if(el.hasAttribute(key))return tag+'['+key+'="'+el.getAttribute(key).replace(/["\\]/g,'\\$&')+'"]';
    return tag;
  }
  function selector(el,{repeated=false}={}){
    if(!el||el.nodeType!==1)throw Error('Select a page element');
    const doc=el.ownerDocument;
    if(!repeated&&el.id&&!/\d{5,}/.test(el.id))return '#'+escape(el.id);
    let result=token(el),parent=el.parentElement;
    if(repeated){
      if(result!==el.tagName.toLowerCase())return result;
      for(let i=0;parent&&parent!==doc.body&&i<5;i++,parent=parent.parentElement){
        const part=token(parent);result=part+' > '+result;
        if(part!==parent.tagName.toLowerCase())return result;
      }
      return result;
    }
    for(let i=0;query(doc,result).length!==1&&parent&&i<8;i++,parent=parent.parentElement){
      const part=parent.id&&!/\d{5,}/.test(parent.id)?'#'+escape(parent.id):token(parent);
      result=part+' > '+result;
    }
    if(query(doc,result).length!==1)throw Error('This area is not unique. Select its surrounding content container.');
    return result;
  }
  function describe(el,field){
    if(['itemLinkSelector','navigationSelector'].includes(field))el=el.closest('a[href]')||el;
    if(field==='itemCoverSelector')el=el.matches('img')?el:el.querySelector('img');
    if(!el||el.matches('input,textarea,select')||el.closest('[data-lwl-picker]'))throw Error('Choose content, a heading, an image or a link.');
    if(field==='detailExcludeSelectors'&&el.matches('html,body'))throw Error('Select only the unwanted area, not the entire page.');
    if(['itemLinkSelector','navigationSelector'].includes(field)&&!el.matches('a[href]'))throw Error('Choose a link that opens an item or a chapter.');
    const repeated=['itemLinkSelector','itemContainerSelector','itemTitleSelector','itemCoverSelector','navigationSelector'].includes(field);
    const css=selector(el,{repeated});const matched=query(el.ownerDocument,css);
    return {selector:css,count:matched.length,text:text(el).slice(0,200),characters:text(el).length,tag:el.tagName,url:el.ownerDocument.location.href,samples:matched.slice(0,5).map(x=>({title:text(x).slice(0,100)||x.getAttribute('alt')||x.tagName,url:x.matches('a[href]')?x.href:null}))};
  }
  const fields=['itemContainerSelector','itemLinkSelector','itemTitleSelector','itemCoverSelector','navigationSelector','detailSelector','detailTitleSelector','detailExcludeSelectors'];
  function apply(source,picks){
    const out={...source};
    for(const field of fields){
      const value=picks[field];if(!value)continue;
      if(!value.selector||value.count<1)throw Error('A selected rule has no matching page elements');
      if(field==='detailExcludeSelectors')out[field]=[...new Set([...(out[field]||[]),value.selector])];
      else out[field]=value.selector;
    }
    if(picks.itemLinkSelector)out.discoveryMode='configured';
    if(picks.detailSelector){out.captureMode='article';out.contentBoundaryVersion=2;}
    return out;
  }
  globalThis.LWLGuidedRules=Object.freeze({selector,describe,apply,fields,query});
})();
