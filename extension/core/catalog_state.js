/* Durable catalog checkpoints: a refresh must not erase useful captured data. */
(() => {
  'use strict';
  function mergeItems(incoming,previous,canonical,{complete=false}={}){
    const old=new Map((previous||[]).map(item=>[canonical(item.url),item])),seen=new Set();
    const result=(incoming||[]).map(item=>{
      const key=canonical(item.url),prior=old.get(key)||{};seen.add(key);
      return {...prior,...item,meta:{...prior.meta,...item.meta},rowHtml:item.rowHtml||prior.rowHtml||null,panelHtml:item.panelHtml||prior.panelHtml||null,filterValues:{...prior.filterValues,...item.filterValues}};
    });
    if(!complete)for(const [key,item] of old)if(!seen.has(key))result.push({...item});
    return result;
  }
  function preserveDefinitions(previous,incoming,oldItems,newItems,canonical){
    const old=new Set((oldItems||[]).map(x=>canonical(x.url)));
    const added=(newItems||[]).some(x=>!old.has(canonical(x.url)));
    const definitions=new Map((previous||[]).map(d=>[d.key,{...d,...(added?{complete:false,reason:'new-items-not-classified'}:{})}]));
    for(const definition of incoming||[])if(definition.complete||!definitions.get(definition.key)?.complete)definitions.set(definition.key,definition);
    return [...definitions.values()];
  }
  function applyMemberships(meta,exact,canonical){
    const completed=new Set(exact.definitions.filter(d=>d.complete).map(d=>d.key));
    for(const item of meta.items){
      item.filterValues||={};
      const values=exact.perItem.get(canonical(item.url))||{};
      for(const key of completed)item.filterValues[key]=values[key]||[];
    }
    meta.exactFilters=preserveDefinitions(meta.exactFilters,exact.definitions,meta.items,meta.items,canonical);
  }
  globalThis.LWLCatalogState=Object.freeze({mergeItems,preserveDefinitions,applyMemberships});
})();
