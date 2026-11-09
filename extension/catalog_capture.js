/* Read-only HTML capture for declaratively configured catalog endpoints. */
(() => {
  'use strict';
  const query=(root,selector)=>{try{return selector?[...root.querySelectorAll(selector)]:[];}catch{return [];}};
  const absolute=(raw,base)=>{try{return new URL(raw,base).href;}catch{return null;}};
  const patterns=(url,values)=>values?.some(pattern=>{try{return new RegExp(pattern,'i').test(url);}catch{return false;}});

  function membership(html,url,source,def=null){
    const doc=new DOMParser().parseFromString(html,'text/html'),cfg=source.catalogView||{};
    const control=def?query(doc,def.selector)[0]:null;
    const containers=query(doc,cfg.listSelector);
    const supported=input=>input&&(input.tagName==='SELECT'||(input.tagName==='INPUT'&&/^(text|number)$/.test(input.type)));
    const selectedValues=input=>input.tagName==='SELECT'?[...input.selectedOptions].map(o=>o.value):[input.value];
    if((def&&!supported(control))||!containers.length)return {ok:false,error:'Static catalog controls or list missing'};
    const values=control?selectedValues(control):[];
    for(const filter of source.filters||[]){
      const input=query(doc,filter.selector)[0];
      if(!supported(input)||!['select','text','number'].includes(filter.type))return {ok:false,error:'Static filter replay cannot be verified'};
      const selected=selectedValues(input).sort(),expected=(Array.isArray(filter.value)?filter.value:[filter.value]).map(String).sort();
      if(JSON.stringify(selected)!==JSON.stringify(expected))return {ok:false,error:'Static base filter was not applied'};
    }
    const rows=query(doc,cfg.rowSelector).filter(row=>!cfg.emptySelector||!row.matches(cfg.emptySelector));
    const items=new Map();
    for(const row of rows){
      let identified=false;
      const links=query(row,source.itemLinkSelector||'a[href]').filter(a=>!cfg.expandedRowSelector||!a.closest(cfg.expandedRowSelector));
      for(const a of links){
        const target=absolute(a.getAttribute('href'),url);
        if(!target||new URL(target).origin!==new URL(url).origin||!patterns(target,source.itemUrlPatterns)||patterns(target,source.itemExcludePatterns))continue;
        const key=new URL(target);key.hash='';
        const item={url:key.href,title:a.textContent.trim()};
        if(!def){
          const copy=row.cloneNode(true);for(const el of query(copy,cfg.expandedRowSelector))el.remove();
          const state=cfg.rowStateSelector?query(copy,cfg.rowStateSelector)[0]:copy;
          if(cfg.rowExpandedClass)state?.classList.remove(cfg.rowExpandedClass);
          for(const el of query(copy,cfg.rowToggleSelector)){if(cfg.indicatorOpenClass)el.classList.remove(cfg.indicatorOpenClass);if(cfg.indicatorClosedClass)el.classList.add(cfg.indicatorClosedClass);}
          item.rowHtml=LWLContentCapture.sanitizeArticle(copy,{...source,captureMode:'page',captureUrl:url},{fragment:true}).html;
          item.rowGroup=Math.max(0,containers.indexOf(row.closest(cfg.listSelector)));
          item.summaryText=row.textContent.replace(/\s+/g,' ').trim().slice(0,8000);
          item.meta=LWLContentCapture.extractDetailMeta(row,{metaFields:source.cardMetaFields||[]});
        }
        items.set(key.href,item);identified=true;break;
      }
      // A source can print the same entry more than once (for example under
      // several feat categories). Validate every row, then deduplicate URLs.
      if(!identified)return {ok:false,error:'Static row identity is incomplete'};
    }
    const pageParam=source.pagination?.pageParam||'page',current=Number(new URL(url).searchParams.get(pageParam)||1);
    let last=current,nextUrl=null,nextNumber=Infinity;
    for(const a of query(doc,cfg.paginationSelector+' a[href]')){
      const target=absolute(a.getAttribute('href'),url);if(!target)continue;
      const parsed=new URL(target);if(parsed.origin!==new URL(url).origin||parsed.pathname!==new URL(url).pathname)continue;
      const page=Number(parsed.searchParams.get(pageParam)||1);if(!Number.isInteger(page)||page<1)continue;
      last=Math.max(last,page);if(page>current&&page<nextNumber){nextNumber=page;nextUrl=target;}
    }
    return {ok:true,url,items:[...items.values()],filterState:control?[{exists:true,value:control.multiple?values:control.value}]:[],pagination:{lastPage:last,pageParam},nextUrl,pageNumber:current};
  }

  function preview(html,url,source){
    const doc=new DOMParser().parseFromString(html,'text/html');
    const root=query(doc,source.catalogView?.expandedRowSelector)[0];
    if(!root)return {ok:false,error:'The preview response contains no configured preview panel'};
    const captured=LWLContentCapture.sanitizeArticle(root,{...source,captureMode:'page',captureUrl:url},{fragment:true});
    return {ok:true,html:captured.html,meta:LWLContentCapture.extractDetailMeta(root,source)};
  }

  async function readOnce(url,source,timeoutMs){
    const origin=new URL(source.startUrl).origin;
    if(!/^https?:/.test(url)||new URL(url).origin!==origin)throw Error('Catalog request outside profile origin');
    const response=await fetch(url,{credentials:'include',signal:AbortSignal.timeout(timeoutMs)});
    if(!response.ok){
      const error=Error(`Catalog request failed: HTTP ${response.status}`);
      error.retryable=[408,429,500,502,503,504].includes(response.status);
      const seconds=Number(response.headers.get('retry-after'));error.retryAfter=Number.isFinite(seconds)?Math.min(30000,Math.max(0,seconds*1000)):0;
      await response.body?.cancel().catch(()=>{});throw error;
    }
    if(new URL(response.url).origin!==origin)throw Error('Catalog response redirected outside profile origin');
    if(!/text\/html/i.test(response.headers.get('content-type')||''))throw Error('Catalog response is not HTML');
    const reader=response.body.getReader(),parts=[];let bytes=0;
    try{for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>8*1024*1024)throw Error('Catalog response exceeds 8 MiB');parts.push(value);}}
    finally{await reader.cancel().catch(()=>{});}
    return {html:await new Blob(parts).text(),url:response.url};
  }
  async function read(url,source){
    const until=Date.now()+150000;
    for(let attempt=0;;attempt++){
      try{return await readOnce(url,source,Math.max(1,Math.min(45000,until-Date.now())));}
      catch(error){
        const retryable=error.retryable||['TypeError','TimeoutError','AbortError'].includes(error.name);
        if(!retryable||attempt>=2||Date.now()>=until-1000)throw error;
        await new Promise(resolve=>setTimeout(resolve,Math.min(until-Date.now()-1000,Math.max(error.retryAfter||0,2000*(attempt+1)))));
      }
    }
  }
  async function capture(message){
    const {html,url}=await read(message.url,message.source);
    return message.type==='CATALOG_PREVIEW'?preview(html,url,message.source):membership(html,url,message.source,message.type==='CATALOG_ROWS'?null:message.def);
  }
  globalThis.LWLCatalogCapture=Object.freeze({membership,preview,capture});
})();
