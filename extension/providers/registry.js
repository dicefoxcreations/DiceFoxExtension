/* Provider contracts live here; transport, storage and the Reader remain shared. */
(() => {
  'use strict';
  const adapters=new Map();
  const copy=value=>JSON.parse(JSON.stringify(value));
  function register(adapter){
    if(!adapter?.id||typeof adapter.classify!=='function')throw Error('Invalid provider adapter');
    adapters.set(adapter.id,Object.freeze(adapter));
  }
  function get(id){return adapters.get(id)||null;}
  function forProfile(profile){return get(profile?.provider?.id);}
  function sourceFor(profile,url){
    const adapter=forProfile(profile);if(!adapter)return null;
    const kind=adapter.classify(url);
    return profile.sources.find(s=>s.providerSource===kind)||null;
  }
  function allows(profile,source,url){
    const adapter=forProfile(profile);
    return !profile?.provider || Boolean(adapter&&adapter.allows(source,url));
  }
  function validate(profile){
    if(!profile.provider)return profile;
    const adapter=forProfile(profile);
    if(!adapter)throw Error('Unsupported export provider: '+profile.provider.id);
    if(profile.origin!==adapter.origin)throw Error('Provider origin does not match profile');
    const seen=new Set();
    for(const source of profile.sources){
      if(!adapter.sourceIds.includes(source.providerSource)||seen.has(source.providerSource))throw Error('Unsupported or duplicate provider source: '+source.providerSource);
      if(!adapter.allows(source,source.startUrl))throw Error('Source outside supported export scope: '+source.startUrl);
      seen.add(source.providerSource);
    }
    return profile;
  }
  async function createProfile(id,previous=null){
    const adapter=get(id);if(!adapter)throw Error('Unknown export provider: '+id);
    if(previous&&previous.origin!==adapter.origin)throw Error('Cannot migrate a different website');
    const response=await fetch(chrome.runtime.getURL(adapter.profilePath));
    if(!response.ok)throw Error('Bundled provider profile unavailable');
    return migrate(await response.json(),previous);
  }
  function migrate(template,previous=null){
    const adapter=get(template.provider?.id);if(!adapter)throw Error('Unknown export provider');
    if(previous&&previous.origin!==adapter.origin)throw Error('Cannot migrate a different website');
    const next=copy(template),ids=new Map();
    next.id=previous?.id||next.id;
    // The profile name is also the output folder. Keep it stable on migration.
    next.name=previous?.name||next.name;
    for(const source of next.sources){
      const matches=(previous?.sources||[]).filter(s=>adapter.classify(s.startUrl)===source.providerSource);
      const old=matches.find(s=>s.id===source.id)||matches[0];
      if(old){ids.set(source.id,old.id);source.id=old.id;source.enabledByDefault=old.enabledByDefault!==false;}
    }
    for(const source of next.sources)source.dependencies=source.dependencies.map(id=>ids.get(id)||id);
    next.metadata={...previous?.metadata,...next.metadata,providerMigration:{fromVersion:previous?.profileVersion||null,at:new Date().toISOString(),retainedSourceIds:[...ids.values()],retiredSourceIds:(previous?.sources||[]).filter(s=>!next.sources.some(n=>n.id===s.id)).map(s=>s.id)}};
    return validate(next);
  }
  globalThis.LWLProviders=Object.freeze({register,get,forProfile,sourceFor,allows,validate,createProfile,migrate,list:()=>[...adapters.values()].map(({id,name,version,sourceIds})=>({id,name,version,sourceIds}))});
})();
