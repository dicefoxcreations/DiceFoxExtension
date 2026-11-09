/* The supported D&D Beyond surface. No provider decisions belong in the crawler. */
(() => {
  'use strict';
  const origin='https://www.dndbeyond.com';
  const catalogs=['classes','backgrounds','species','feats','spells','equipment','magic-items','monsters'];
  const sourceIds=['rules-glossary','my-library',...catalogs];
  function classify(raw){
    let u;try{u=new URL(raw);}catch{return null;}
    if(u.origin!==origin)return null;
    const p=u.pathname.replace(/\/+$/,'');
    if(/^\/sources\/dnd\/(?:br-2024|free-rules)\/rules-glossary$/.test(p))return 'rules-glossary';
    if(p==='/en/library'||/^\/sources\/(?:dnd\/)?[^/]+(?:\/[^/]+)*$/.test(p))return 'my-library';
    for(const name of catalogs)if(p==='/'+name||new RegExp('^/'+name+'/[0-9]+-[^/]+(?:/[^/]+)*$').test(p))return name;
    if(/^\/subclasses\/[0-9]+-[^/]+$/.test(p))return 'classes';
    return null;
  }
  function allows(source,url){
    const kind=classify(url);
    if(!kind||!sourceIds.includes(source?.providerSource))return false;
    if(source.providerSource!==kind&&!(source.providerSource==='my-library'&&kind==='rules-glossary'))return false;
    if(source.providerSource==='my-library'&&source.collectionRoot){
      const root=new URL(source.collectionRoot),u=new URL(url);
      return u.pathname===root.pathname||u.pathname.startsWith(root.pathname.replace(/\/$/,'')+'/');
    }
    return true;
  }
  LWLProviders.register({id:'dndbeyond',name:'D&D Beyond',version:'1.1.0',origin,sourceIds,profilePath:'providers/dndbeyond.profile.json',catalogStylesPath:'providers/dndbeyond.catalog.css',classify,allows,
    // A page served to someone not signed in: read without a tab, the sign-in did not come along.
    signedOutPattern:'"userId":undefined'});
})();
