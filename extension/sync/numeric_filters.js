/* Capture integer metadata from a site's declared inclusive range controls.
   This uses catalog results, including entries whose detail pages are unavailable.
   Bounds are verified in the returned form; no article access is required. */
async function resolveNumericFilters(source,items,onField=null){
 const ordered=[...new Set(items.map(item=>canonical(item.url)))].sort(),known=new Set(ordered),indices=new Map(ordered.map((url,i)=>[url,i]));
 const key=`${prefix()}numeric-capture:${source.id}`;
 const signature=hashText(stableJson([1,source.startUrl,source.filters,source.itemUrlPatterns,source.catalogView,source.numericFilters,ordered]));
 const previous=(await chrome.storage.local.get(key))[key];
 const cache=previous?.signature===signature?previous:{signature,fields:{}};
 let saving=Promise.resolve();
 const save=()=>{const task=saving.then(()=>chrome.storage.local.set({[key]:cache}));saving=task.catch(()=>{});return task;};
 const results=[];
 for(const field of source.numericFilters||[]){
  if(stopRequested)break;
  const saved=cache.fields[field.field]||={queries:{}};
  const query=async(min,max=null)=>{
   if(stopRequested)throw Error('stopped');
   const queryKey=min+':'+(max??'');
   if(saved.queries[queryKey])return new Set(saved.queries[queryKey].map(i=>ordered[i]));
   const start=new URL(source.startUrl);start.searchParams.set(field.minName,String(min));
   if(max===null)start.searchParams.delete(field.maxName);else start.searchParams.set(field.maxName,String(max));
   const probe={...source,startUrl:start.href,catalogView:{...source.catalogView,filterTransport:'html'},filters:[...(source.filters||[]).filter(f=>![field.minSelector,field.maxSelector].includes(f.selector)),{type:'text',selector:field.minSelector,value:String(min)},{type:'text',selector:field.maxSelector,value:max===null?'':String(max)}]};
   const answer=await itemsForFilterValue(probe,{name:field.minName,selector:field.minSelector},{value:String(min)},10000);
   if(!answer.complete)throw Error(answer.reason||'numeric-range-incomplete');
   const urls=new Set([...answer.urls].filter(url=>known.has(url)));
   saved.queries[queryKey]=[...urls].map(url=>indices.get(url));await save();return urls;
  };
  let result={field:field.field,complete:false};
  try{
   status(`${source.name}: ${field.field}`);
   // Find a finite upper bound, explicitly verifying that its tail is empty.
   let upper=field.initialMax;
   for(let attempt=0;;attempt++){
    const tail=await query(upper+1);
    if(!tail.size)break;
    if(attempt>=24||upper>Number.MAX_SAFE_INTEGER/2)throw Error('numeric-domain-unbounded');
    upper=field.min+2*(upper-field.min+1)-1;
   }
   const root=await query(field.min,upper),values=new Map();
   // Each complete parent set splits into >= midpoint + 1 and its complement.
   // The profile declares integer, inclusive bounds, so single-value leaves
   // recover the site's own numeric field without guessing from article text.
   let pending=[{min:field.min,max:upper,urls:root}];
   setProgress(0,root.size);
   while(pending.length){
    if(stopRequested)throw Error('stopped');
    const batch=pending.splice(0,1);
    const children=await Promise.allSettled(batch.map(async node=>{
     if(!node.urls.size)return [];
     if(node.min===node.max){for(const url of node.urls)values.set(url,String(node.min));setProgress(values.size);return [];}
     const mid=node.min+Math.floor((node.max-node.min)/2),right=await query(mid+1,node.max);
     if([...right].some(url=>!node.urls.has(url)))throw Error('numeric-ranges-inconsistent');
     const left=new Set([...node.urls].filter(url=>!right.has(url)));
     return [{min:node.min,max:mid,urls:left},{min:mid+1,max:node.max,urls:right}].filter(n=>n.urls.size);
    }));
    const failed=children.find(r=>r.status==='rejected');if(failed)throw failed.reason;
    pending.push(...children.flatMap(r=>r.value));
   }
   result={field:field.field,complete:true,min:field.min,max:upper,count:values.size,unknown:ordered.length-values.size,values};
  }catch(error){result.reason=String(error.message||error);}
  if(onField)await onField(result);
  results.push(result);
 }
 return results;
}

async function captureNumericFilters(source,meta){
 if(!source.numericFilters?.length)return;
 await resolveNumericFilters(source,meta.items,async result=>{
  meta.numericFilters||=[];
  if(result.complete){
   const fields=new Set([result.field,...(source.catalogView?.filterBindings||[]).filter(b=>b.field===result.field).flatMap(b=>b.fallbackFields||[])]);
   for(const item of meta.items){item.filterNumbers||={};for(const field of fields)item.filterNumbers[field]=result.values.get(canonical(item.url))??'';}
  }
  const entry={...result,updatedAt:new Date().toISOString()};delete entry.values;
  const index=meta.numericFilters.findIndex(f=>f.field===result.field);
  if(index<0)meta.numericFilters.push(entry);else meta.numericFilters[index]=entry;
  await chrome.storage.local.set({[sourceKey(source.id)]:meta});
 });
}
