/* Automatic discovery of enabled AnotherWorldbuilder instances on this
   device. The app owns the GM checks. No pairing code or stored token. */
(() => {
  'use strict';
  const PORTS=Array.from({length:8},(_,i)=>47823+i);
  const LATE='The app did not answer in time.';
  let endpoints=[],routes=new Map(),outdated=false,scan=null;
  // A world on a server answers through the app: a minute, not a moment.
  async function call(endpoint,path,{method='GET',body=null,timeout=60000,signal=null}={}){
    const ctl=new AbortController(),timer=setTimeout(()=>ctl.abort(Error(LATE)),timeout);
    const abort=()=>ctl.abort(signal.reason);if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
    try{
      const headers={};if(endpoint.instance)headers['x-dicefox-instance']=endpoint.instance;
      if(body)headers['content-type']='application/json';
      const response=await fetch(endpoint.base+path,{method,headers,credentials:'omit',body:body?JSON.stringify(body):undefined,signal:ctl.signal});
      const data=await response.json().catch(()=>({}));
      if(!response.ok){const error=Error(data.error||response.statusText);error.status=response.status;throw error;}
      return data;
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  async function discover(){
    if(scan)return scan;
    scan=(async()=>{
      const found=await Promise.all(PORTS.map(async port=>{
        const endpoint={port,base:`http://127.0.0.1:${port}/v1`};
        try{const hello=await call(endpoint,'/hello',{timeout:1000});return hello.app==='AnotherWorldbuilder'?{...endpoint,...hello}:null;}catch{return null;}
      }));
      endpoints=found.filter(e=>e&&e.browser_api>=3&&typeof e.instance==='string'&&e.instance);
      outdated=found.some(e=>e&&!(e.browser_api>=3));
      return endpoints;
    })();
    try{return await scan;}finally{scan=null;}
  }
  async function status(){await discover();return endpoints.length?'connected':outdated?'outdated':'closed';}
  async function worlds(){
    if(!endpoints.length)await discover();
    if(!endpoints.length)throw Error(outdated?'Update AnotherWorldbuilder to 0.2.9 or later.':'Open AnotherWorldbuilder and enable Options → Browser.');
    const results=await Promise.allSettled(endpoints.map(async endpoint=>({endpoint,worlds:await call(endpoint,'/worlds')})));
    const available=[];routes=new Map();let firstError=null;
    for(const result of results){
      if(result.status==='rejected'){firstError||=result.reason;continue;}
      const {endpoint,worlds}=result.value;
      for(const world of worlds){
        const key=endpoint.instance+'@'+endpoint.port+'/'+encodeURIComponent(world.id);
        routes.set(key,{endpoint,id:world.id});
        available.push({...world,key,appName:endpoint.name||'AnotherWorldbuilder',appPort:endpoint.port});
      }
    }
    if(!available.length&&results.every(result=>result.status==='rejected'))throw firstError;
    return available;
  }
  function target(key){
    const matching=[...routes.values()].filter(route=>route.id===key);
    const route=routes.get(key)||(matching.length===1?matching[0]:null);
    if(!route)throw Error('Choose the world again after refreshing the app connection.');
    return route;
  }
  globalThis.DiceFoxAW=Object.freeze({
    status,worlds,
    instances:()=>endpoints.map(({port,name,version})=>({port,name,version})),
    types:key=>{const route=target(key);return call(route.endpoint,'/types?world='+encodeURIComponent(route.id));},
    // Which of these document ids the world holds already — an older app answers nothing.
    known:async(key,ids)=>{const route=target(key);try{return await call(route.endpoint,'/known',{method:'POST',body:{world:route.id,ids},timeout:60000});}catch(error){if(error.status===404)return [];throw error;}},
    send:(key,pkg,files,options={})=>{const route=target(key);return call(route.endpoint,'/import',{method:'POST',body:{world:route.id,package:pkg,files},timeout:10*60*1000,...options});},
  });
})();
