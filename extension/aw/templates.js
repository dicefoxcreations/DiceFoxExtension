/* The import contract: check existing types, map stable fields, retain the
   world's policies, and detect changes before writing each package. */
(() => {
  'use strict';
  const copy = value => JSON.parse(JSON.stringify(value));
  const normal = value => String(value || '').trim().toLowerCase();
  const stable = value => JSON.stringify(sort(value));
  function sort(value) {
    if (Array.isArray(value)) return value.map(sort);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map(k => [k,sort(value[k])]));
  }
  const KINDS = {
    classes:['class','subclass'], backgrounds:['background'], species:['species'], feats:['feat'], spells:['spell'],
    equipment:['gear','weapon','armor','potion'], 'magic-items':['weapon','armor','potion','ring','rod','scroll','staff','wand','wondrous-item'],
    monsters:['monster'], 'rules-glossary':['rule'], 'my-library':['book','book-chapter'],
  };
  function required(kinds) {
    return [...new Set(kinds.flatMap(k => KINDS[k] || []))];
  }
  function visible(kinds){return required(kinds.filter(kind=>kind!=='rules-glossary'));}
  function shape(type) {
    const out = copy(type);
    delete out.page;
    // The app keeps no empty setting: an empty sort is none.
    for (const [k, v] of Object.entries(out)) if (Array.isArray(v) && !v.length) delete out[k];
    for (const field of out.properties || []) delete field.default;
    for (const block of out.blocks || []) for (const p of block.parts || []) delete p.text;
    return out;
  }
  function effective(all, id, seen = []) {
    if (seen.includes(id)) throw new Error(`Type/group cycle: ${[...seen,id].join(' → ')}`);
    const t = all.get(id);
    if (!t) throw new Error(`Missing type: ${id}`);
    const parent = t.supertype ? effective(all,t.supertype,[...seen,id]) : null;
    const fields = [];
    for (const f of [...(parent?.fields || []), ...(t.properties || [])]) {
      fields.push(f);
      if (f.kind === 'group') {
        const group = all.get(f.group);
        if (!group?.group) throw new Error(`Invalid property group: ${f.group}`);
        fields.push(...effective(all,f.group,[...seen,id]).fields);
      }
    }
    const infobox = t.infobox?.show?.length ? t.infobox : parent?.infobox || t.infobox || {};
    return {type:t, fields:[...new Map(fields.map(f => [f.key,f])).values()],
      blocks:[...(parent?.blocks || []),...(t.blocks || [])], infobox};
  }
  function reference(field) { return field?.article_type || field?.articleType || ''; }
  function sameField(a,b) {
    return a.kind === b.kind &&
      (a.kind !== 'reference' || (reference(a) === reference(b) && !!a.multiple === !!b.multiple && !!a.parent === !!b.parent)) &&
      (a.kind !== 'group' || a.group === b.group) &&
      (a.kind !== 'relation' || reference(a) === reference(b));
  }
  function policy(value, doc, fallback) {
    const text = typeof value === 'string' && value.trim() ? value.trim() : fallback;
    const own = ['doc:'+doc.id.replace(/^art:/,''), ...(doc.type ? ['type:'+doc.type.replace(/[^a-zA-Z0-9_.-]/g,'-')] : [])];
    return text.split(/\s+OR\s+/i).flatMap(group => {
      const words = group.split(/\s+/);
      return words.some(w => /^self$/i.test(w)) ? own.map(id => words.map(w => /^self$/i.test(w) ? id : w).join(' ')) : [group];
    }).join(' OR ');
  }
  // Subtypes show their parent's fields too: an omitted field leaves every
  // type's infobox and sort order, not only the type that declares it.
  function exportShape(template){
    const omit={monster:['Encountered at'],item:['Owner','Acquired']};
    const keys=new Set(template.flatMap(type=>(type.properties||[]).filter(f=>(omit[type.id]||[]).includes(f.label)).map(f=>f.key)));
    return template.map(type=>{
      const out=copy(type);
      out.properties=(out.properties||[]).filter(f=>!keys.has(f.key));
      if(out.infobox)out.infobox.show=(out.infobox.show||[]).filter(f=>!keys.has(f.property));
      if(out.sort)out.sort=out.sort.filter(k=>!keys.has(k));
      return out;
    });
  }
  function prepare(worldTypes, template, directIds, visibleIds=directIds) {
    // The shared campaign template also contains play-state fields. A library
    // import never writes ownership, sessions or encounter locations; importing
    // those fields into a new schema would pull in an entire empty campaign.
    template=exportShape(template);
    const expected = new Map(template.map(t => [t.id,t]));
    const navigation=new Set(visibleIds),parents=[...navigation];
    // Selecting a subtype also needs its content category in the outline.
    while(parents.length){const parent=expected.get(parents.pop())?.supertype;if(parent&&!navigation.has(parent)){navigation.add(parent);parents.push(parent);}}
    const baseline = new Map(worldTypes.map(t => [t.id,t]));
    const original = new Map(worldTypes.map(t => [t.id,copy(t)])), updates=[];
    const missing = new Map(), needed = new Set(), direct = new Set(directIds), errors = [], compatible = [];
    const todo = [...direct];
    while (todo.length) {
      const id = todo.pop();
      if (!id || needed.has(id)) continue;
      needed.add(id);
      const t = expected.get(id);
      if (!t) { errors.push({type:id, field:'', reason:'Unknown export type'}); continue; }
      if (original.has(id)) {
        if (!!original.get(id).group !== !!t.group) errors.push({type:id,field:'',reason:'Article type / property group mismatch'});
        // Existing dependency types need not have unrelated campaign fields.
        if (!direct.has(id) && !t.group) continue;
      } else {
        const collision = worldTypes.find(other => normal(other.name) === normal(t.name));
        if (collision) errors.push({type:id,field:'',reason:'A type with this name has a different identity; map it before importing'});
        const added=copy(t);
        if(!navigation.has(id))added.navigation_hidden=true;
        missing.set(id,added);
      }
      if (t.supertype) todo.push(t.supertype);
      for (const f of t.properties || []) {
        if (f.kind === 'group') todo.push(f.group);
        if (['reference','relation'].includes(f.kind) && reference(f)) todo.push(reference(f));
      }
    }
    for(const id of needed){
      const t=original.get(id),canonical=expected.get(id);if(!t||!canonical)continue;
      let changed=false;
      // A type without an icon takes the template's; one the world chose stays.
      if(canonical.icon&&!t.icon){t.icon=canonical.icon;changed=true;}
      if(changed)updates.push(t);
    }
    const all = new Map([...original,...missing]);
    for (const id of needed) {
      if (!original.has(id)) continue;
      try { effective(all,id); } catch (e) { errors.push({type:id,field:'',reason:e.message}); }
    }
    const fieldMaps = new Map(), blockMaps = new Map();
    for (const id of direct) {
      if (!expected.has(id) || !all.has(id)) continue;
      try {
        const want = effective(expected,id), have = effective(all,id), before = errors.length;
        const fields = new Map();
        for (const f of want.fields) {
          const found = have.fields.find(p => p.key === f.key) || have.fields.find(p => normal(p.label) === normal(f.label));
          if (!found) errors.push({type:id,field:f.label,reason:'Missing field',expected:f.kind});
          else if (!sameField(f,found)) errors.push({type:id,field:f.label,reason:'Incompatible field',expected:f.kind,actual:found.kind});
          else { fields.set(f.key,found); fields.set(normal(f.label),found); }
        }
        const blocks = new Map();
        for (const b of want.blocks) {
          const found = have.blocks.find(p => p.key === b.key) || have.blocks.find(p => normal(p.title) === normal(b.title));
          if (!found || !found.parts?.length) errors.push({type:id,field:b.title,reason:'Missing text section'});
          else { blocks.set(b.key,found); blocks.set(normal(b.title),found); blocks.set(normal(b.title).replace(/ /g,'-'),found); }
        }
        fieldMaps.set(id,fields); blockMaps.set(id,blocks);
        if (original.has(id) && errors.length === before) compatible.push(id);
      } catch (e) { errors.push({type:id,field:'',reason:e.message}); }
    }
    // Canonical labels are used only inside the converter. Keys, policies and
    // the actual world templates remain unchanged.
    const conversionTypes = [...all.values()].map(t => {
      const out = copy(t), canonical = expected.get(t.id);
      if (!canonical) return out;
      for (const p of out.properties || []) {
        const f = (canonical.properties || []).find(f => f.key === p.key) || (canonical.properties || []).find(f => normal(f.label) === normal(p.label));
        if (f) p.label = f.label;
      }
      for (const b of out.blocks || []) {
        const want = (canonical.blocks || []).find(x => x.key === b.key) || (canonical.blocks || []).find(x => normal(x.title) === normal(b.title));
        if (want) b.title = want.title;
      }
      return out;
    });
    const keyFor = (type,label) => fieldMaps.get(type)?.get(normal(label))?.key || fieldMaps.get(type)?.get(label)?.key || label;
    const typeFor = name => [...all.values()].find(t => t.id === name || normal(t.name) === normal(name))?.id || template.find(t => normal(t.name) === normal(name))?.id || name;
    function rewrite(text,type) {
      const fieldPath = value => value.split('.').map(part => keyFor(type,part.trim())).join('.');
      text = text.replace(/%%([^%]+)%%/g, (_,name) => `%%${fieldPath(name)}%%`);
      return text.replace(/<(list|abilities|image|number|text|select|view)\b([^>]*)>/g, (tag,kind,body) => {
        const attrs = [...body.matchAll(/([a-zA-Z-]+)=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(m => [m[1],m[2] ?? m[3] ?? m[4]]);
        const selected = kind === 'list' ? typeFor(attrs.find(([k]) => k === 'type')?.[1] || type) : type;
        const mapped = attrs.map(([name,value]) => {
          if (name === 'type' && kind === 'list') value = selected;
          else if (['bind','filter','from'].includes(name)) value = keyFor(selected,value);
          // An ability row shows a group by its name; a list, columns by their keys.
          else if (name === 'show' && kind !== 'abilities') value = value.split(',').map(v => keyFor(selected,v.trim())).join(', ');
          else if (name === 'where') value = value.split(',').map(v => { const i=v.indexOf('='); return i<0?v:keyFor(selected,v.slice(0,i).trim())+'='+v.slice(i+1); }).join(', ');
          else if (name === 'sort') value = value.split(',').map(v => { const m=/^(.*?)(\s+(?:desc|asc))?$/.exec(v.trim()); return keyFor(selected,m[1])+(m[2] || ''); }).join(', ');
          return `${name}="${value.replace(/"/g,'&quot;')}"`;
        });
        return `<${kind}${mapped.length?' '+mapped.join(' '):''}>`;
      });
    }
    function document(doc) {
      const out = {...doc,fields:{...doc.fields},parts:[]};
      const typeId = doc.type || doc._overviewFor;
      delete out._overviewFor;
      if (!typeId || !all.has(typeId)) return {...out,parts:doc.parts.map(p => ({...p,fields:{...p.fields}}))};
      const t = effective(all,typeId), base = t.type.auth || {};
      out.view = policy(base.view,doc,'all'); out.edit = policy(base.edit,doc,'gm');
      for (const p of doc.parts) {
        if (p.section === 'properties') {
          const common = {}, own = [];
          for (const [key,value] of Object.entries(p.fields || {})) {
            const f = t.fields.find(f => f.key === key);
            if (!f) throw new Error(`Unmapped field: ${typeId}.${key}`);
            if (f.access) own.push({...p,section:'properties:'+key,fields:{[key]:value},view:policy(f.access.view,doc,out.view),edit:policy(f.access.edit,doc,out.edit)});
            else common[key] = value;
          }
          if (Object.keys(common).length) out.parts.push({...p,fields:common,view:policy(t.infobox.access?.view,doc,out.view),edit:policy(t.infobox.access?.edit,doc,out.edit)});
          out.parts.push(...own);
        } else {
          const b = t.blocks.find(b => b.key === p.section || b.parts?.some(part => part.key === p.section)) || blockMaps.get(typeId)?.get(p.section) || blockMaps.get(typeId)?.get(normal(p.section));
          const primary = b?.parts?.find(part => part.key === b.key) || b?.parts?.[0];
          out.parts.push({...p,section:primary?.key || p.section,fields:{...p.fields},text:rewrite(p.text || '',typeId),
            view:policy(primary?.view,doc,out.view),edit:policy(primary?.edit,doc,out.edit)});
        }
      }
      return out;
    }
    function overview(text){
      return text.split(/(?=^## )/m).map(section=>{
        let lists=0,kept=0;
        const out=section.replace(/<list\b([^>]*)>/g,(_tag,body)=>{
          lists++;
          const attrs=[...body.matchAll(/([a-zA-Z-]+)=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)].map(m=>[m[1],m[2]??m[3]??m[4]]);
          const id=typeFor(attrs.find(([k])=>k==='type')?.[1]||'');
          if(!all.has(id))return '';
          const fields=effective(all,id).fields;
          const has=name=>['name','type','image'].includes(normal(name))||fields.some(f=>f.key===name||f.key===keyFor(id,name)||normal(f.label)===normal(name));
          const where=attrs.find(([k])=>k==='where')?.[1];
          if(where&&where.split(',').some(v=>!has(v.slice(0,v.indexOf('=')).trim())))return '';
          const clean=attrs.filter(([k,v])=>k!=='filter'||has(v)).map(([k,v])=>[k,['show','sort'].includes(k)?v.split(',').map(x=>x.trim()).filter(x=>has(x.replace(/\s+(desc|asc)$/,''))).join(', '):v]).filter(([,v])=>v);
          kept++;return '<list '+clean.map(([k,v])=>`${k}="${v.replace(/"/g,'&quot;')}"`).join(' ')+'>';
        });
        return lists&&!kept?'':out;
      }).filter(s=>s.trim()).join('\n\n');
    }
    function assertCurrent(latest) {
      const byId = new Map(latest.map(t => [t.id,t]));
      for (const id of needed) {
        const had = baseline.get(id), now = byId.get(id), updated=updates.find(t=>t.id===id);
        const matches=t=>now&&stable({...t,page:null})===stable({...now,page:null});
        if (had && !matches(had) && !(updated&&matches(updated))) throw new Error('World templates or permissions changed. Check the world again before importing.');
        if (!had && now && stable(shape(now)) !== stable(shape(missing.get(id)))) throw new Error('A missing type was created with different settings. Check the world again before importing.');
      }
    }
    return {ok:!errors.length,errors,compatible,missing:[...missing.values()],updates,types:[...all.values()],conversionTypes,document,rewrite,overview,assertCurrent};
  }
  globalThis.AWTemplates = Object.freeze({prepare,required,visible});
})();
