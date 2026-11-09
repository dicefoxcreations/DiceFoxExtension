/* Original catalog markup, driven exclusively by the saved local collection. */
(() => {
  'use strict';
  const Model = LWLReaderModel;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const query = (root, selector) => {try{return selector ? [...root.querySelectorAll(selector)] : [];}catch{return [];}};
  const previewCache=new Map(),previewLoads=new Map();
  async function loadPreview(row){
    const file=row?.panelRef;
    if(!/^data\/previews-[a-zA-Z0-9_-]+-\d+\.js$/.test(file||''))throw Error('Invalid local preview file');
    let chunk=previewCache.get(file);
    if(chunk){previewCache.delete(file);previewCache.set(file,chunk);return chunk[row.id];}
    if(!previewLoads.has(file))previewLoads.set(file,(async()=>{
      window.LWL_PREVIEWS||={};
      if(!window.LWL_PREVIEWS[file])await new Promise((resolve,reject)=>{
        const script=document.createElement('script');script.src=file;
        script.onload=()=>{script.remove();resolve();};script.onerror=()=>{script.remove();reject(Error('Local preview file unavailable'));};document.head.append(script);
      });
      const loaded=window.LWL_PREVIEWS[file];delete window.LWL_PREVIEWS[file];
      if(!loaded)throw Error('Local preview data missing');
      previewCache.set(file,loaded);while(previewCache.size>8)previewCache.delete(previewCache.keys().next().value);
      return loaded;
    })().finally(()=>previewLoads.delete(file)));
    chunk=await previewLoads.get(file);return chunk[row.id];
  }

  function mount({host, source, view, css, profile, state, decorate, navigate, translate:t, isCurrent}) {
    const frame = document.createElement('iframe');
    frame.className = 'original-page'; frame.title = source.name;
    frame.setAttribute('sandbox','allow-same-origin');
    frame.srcdoc = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data: file: https: http:; font-src data: file: https: http:; base-uri *"><base href="${esc(new URL('.',location.href).href)}"></head><body></body></html>`;
    frame.onload = () => {
      if(!isCurrent())return;
      const doc = frame.contentDocument;
      for(const [name,node] of [['html',doc.documentElement],['body',doc.body]])for(const [key,value] of Object.entries(view.presentation?.[name]||{})) {
        if(/^(id|class|lang|dir|role|style)$/.test(key)||/^data-(theme|page|layout|book|source|content)(-|$)/.test(key))node.setAttribute(key,value);
      }
      const style = doc.createElement('style'); style.textContent = (css || '')+'\n.select2-input::placeholder{color:inherit;opacity:1}[data-lwl-catalog-group][hidden],[data-lwl-advanced-panel][hidden]{display:none!important}'; doc.head.append(style);
      doc.body.innerHTML = view.html;
      LWLPresentation.clean(doc.body,{...profile?.presentationPolicy,controlsSelector:view.config?.controlsSelector,listSelector:view.config?.listSelector,paginationSelector:view.config?.paginationSelector});
      setup(doc,{source,view,state,decorate,navigate,t});
    };
    host.replaceChildren(frame);
    return () => {frame.onload=null;};
  }

  function setup(doc,{source,view,state,decorate,navigate,t}) {
    const cfg = view.config || {}, lists = query(doc,cfg.listSelector), list=lists[0];
    if(!list)throw Error('The captured catalog has no list container.');
    const savedRows = new Map((view.rows||[]).map(row=>[row.id,row]));
    const pageSize = lists.length>1||!query(doc,cfg.paginationSelector).length?Math.max(1,source.entries.length):Math.max(1,Math.min(5000,view.pageSize||20));
    const controls = query(doc,cfg.controlsSelector)[0];
    const search = query(doc,cfg.searchSelector)[0];
    const specs = new Map(), widgets = [], cycles = [];
    state.catalogFilters ||= {}; state.catalogPage ||= 1;
    const localOnly = t('This filter was not captured for the local collection.','Dieser Filter wurde für den lokalen Bestand nicht erfasst.');
    for(const input of query(controls||doc,'select[name],input[type=checkbox][name],input[type=radio][name],input[type=number][name],input[type=text][name]')) {
      if(input===search)continue;
      const name = input.name;
      if(!specs.has(name)) {
        const exact = (source.facets||[]).find(f=>f.exact && f.key===Model.facetKey({name}));
        const binding = (cfg.filterBindings||[]).find(b=>b.name===name)||Model.inferFilterBinding(name,source.entries);
        specs.set(name,{name,exact,binding,inputs:[],labels:new Map()});
      }
      const spec = specs.get(name); spec.inputs.push(input);
      if(input.tagName==='SELECT')for(const option of input.options)spec.labels.set(option.value,option.textContent.trim());
      else spec.labels.set(input.value,input.closest('li,label')?.querySelector('label')?.textContent.trim() || input.getAttribute('aria-label') || input.value);
      if(!spec.exact&&!spec.binding) {
        input.setAttribute('aria-disabled','true'); input.title=localOnly;
        input.addEventListener('mousedown',ev=>ev.preventDefault());
        input.addEventListener('keydown',ev=>{if(ev.key!=='Tab')ev.preventDefault();});
        input.addEventListener('click',ev=>ev.preventDefault());
        continue;
      }
      input.addEventListener('change',()=>{
        const empty = new Set(['',...(spec.binding?.emptyValues||[])]);
        const values = spec.inputs.flatMap(el=>el.tagName==='SELECT'?[...el.selectedOptions].map(o=>o.value):/^(checkbox|radio)$/.test(el.type)?el.checked?[el.value]:[]:[el.value]).filter(v=>!empty.has(v));
        if(input.type==='checkbox' && empty.has(input.value) && input.checked){
          for(const el of spec.inputs)if(el!==input)el.checked=false;
          state.catalogFilters[name]=[];
        } else {
          state.catalogFilters[name]=values;
          for(const el of spec.inputs)if(el.type==='checkbox'&&empty.has(el.value))el.checked=!values.length;
        }
        state.catalogPage=1;draw();
      });
      if(input.type==='checkbox'||input.type==='radio') {
        const item=input.closest('li,label');
        if(item && item.querySelectorAll('input').length===1)item.addEventListener('click',ev=>{
          if(ev.target===input || ev.target.closest('label')?.htmlFor===input.id)return;
          ev.preventDefault();input.checked=!input.checked;input.dispatchEvent(new doc.defaultView.Event('change',{bubbles:true}));
        });
      }
    }
    for(const spec of specs.values())for(const input of spec.inputs)if(input.tagName==='SELECT') {
      const container=input.id?doc.getElementById('s2id_'+input.id):null;
      if(container)widgets.push(selectWidget(input,container,Boolean(spec.exact||spec.binding),localOnly));
    }
    for(const control of cfg.cycleControls||[]) {
      const spec=specs.get(control.name),select=spec?.inputs.find(input=>input.tagName==='SELECT');
      if(!select)continue;
      const values=control.values.filter(value=>[...select.options].some(option=>option.value===value&&!option.disabled));
      if(values.length<2)continue;
      const enabled=Boolean(spec.exact||spec.binding);
      const label=select.labels?.[0]?.textContent.trim()||control.name;
      for(const button of query(doc,control.selector)) {
        button.setAttribute('role','button');button.tabIndex=0;
        const refresh=()=>{
          for(const [value,className] of Object.entries(control.classes||{}))button.classList.toggle(className,select.value===value);
          const choice=select.value?spec.labels.get(select.value):t('Any','Beliebig');
          button.setAttribute('aria-label',label+': '+(choice||select.value));
          button.setAttribute('aria-pressed',String(Boolean(select.value)));
        };
        if(!enabled){button.setAttribute('aria-disabled','true');button.title=localOnly;}
        const advance=()=>{if(!enabled)return;select.value=values[(values.indexOf(select.value)+1)%values.length];select.dispatchEvent(new doc.defaultView.Event('change',{bubbles:true}));};
        button.addEventListener('click',ev=>{ev.preventDefault();ev.stopImmediatePropagation();advance();},true);
        button.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();ev.stopImmediatePropagation();advance();}},true);
        cycles.push({refresh});
      }
    }
    const syncControls = () => {
      if(search)search.value=state.filter||'';
      for(const spec of specs.values())if(spec.exact||spec.binding) {
        const values=state.catalogFilters[spec.name]||[];
        const empty=new Set(['',...(spec.binding?.emptyValues||[])]);
        for(const input of spec.inputs) {
          if(input.tagName==='SELECT'){
            for(const option of input.options)option.selected=values.includes(option.value)||(!values.length&&!input.multiple&&empty.has(option.value));
            if(!values.length&&!input.multiple&&input.selectedIndex<0)input.selectedIndex=0;
          }else if(/^(checkbox|radio)$/.test(input.type))input.checked=values.includes(input.value)||(!values.length&&empty.has(input.value));
          else input.value=values[0]||'';
        }
      }
      for(const widget of widgets)widget.refresh();
    };
    const applySearch = () => {state.filter=search?.value||'';state.catalogPage=1;draw();};
    search?.addEventListener('input',applySearch);
    for(const input of query(controls||doc,'input[name]'))if(input!==search&&!specs.has(input.name)&&/^(text|search|number)$/.test(input.type)){
      input.readOnly=true;input.setAttribute('aria-disabled','true');input.title=localOnly;
    }
    controls?.addEventListener('submit',ev=>{ev.preventDefault();applySearch();});
    controls?.addEventListener('keydown',ev=>{if(ev.key==='Enter'&&ev.target===search){ev.preventDefault();applySearch();}});
    const intercept = (selector,fn) => {for(const el of query(doc,selector))el.addEventListener('click',ev=>{ev.preventDefault();ev.stopImmediatePropagation();fn();},true);};
    intercept(cfg.submitSelector,applySearch);
    intercept(cfg.resetSelector,()=>{state.catalogFilters={};state.filter='';state.catalogPage=1;syncControls();draw();});
    for(const group of query(doc,cfg.groupSelector)) {
      group.dataset.lwlCatalogGroup='';
      const trigger=query(group,cfg.groupTriggerSelector)[0],content=query(group,cfg.groupContentSelector)[0];
      if(!trigger||!content||!cfg.groupClosedClass)continue;
      const toggle=()=>{const closed=content.classList.toggle(cfg.groupClosedClass);if(cfg.groupHeaderClosedClass)trigger.classList.toggle(cfg.groupHeaderClosedClass,closed);trigger.setAttribute('aria-expanded',String(!closed));};
      trigger.setAttribute('role','button');trigger.tabIndex=0;trigger.setAttribute('aria-expanded',String(!content.classList.contains(cfg.groupClosedClass)));
      trigger.addEventListener('click',toggle);trigger.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();toggle();}});
    }
    for(const button of query(doc,cfg.advancedToggleSelector)) {
      const panels=query(doc,cfg.advancedPanelSelector);
      if(!panels.length)continue;
      const initialOpen=button.getAttribute('aria-expanded')==='true'||Boolean(cfg.advancedOpenClass&&button.classList.contains(cfg.advancedOpenClass));
      for(const [i,el] of panels.entries()){el.dataset.lwlAdvancedPanel='';el.id||='lwl-advanced-panel-'+i;}
      button.setAttribute('role','button');button.tabIndex=0;
      button.setAttribute('aria-controls',panels.map(el=>el.id).join(' '));
      button.removeAttribute('href');button.removeAttribute('data-lwl-href');
      const setOpen=open=>{
        button.setAttribute('aria-expanded',String(open));
        if(cfg.advancedOpenClass)button.classList.toggle(cfg.advancedOpenClass,open);
        // Both initially open and initially closed captures must be reversible.
        for(const el of panels){el.hidden=!open;if(cfg.advancedHiddenClass)el.classList.toggle(cfg.advancedHiddenClass,!open);}
        const label=button.querySelector('span')||button,value=open?cfg.advancedOpenLabel:cfg.advancedClosedLabel;
        if(value)label.textContent=value;
      };
      button.addEventListener('click',ev=>{
        ev.preventDefault();ev.stopImmediatePropagation();setOpen(button.getAttribute('aria-expanded')!=='true');
      },true);
      if(button.tagName!=='BUTTON')button.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();ev.stopImmediatePropagation();setOpen(button.getAttribute('aria-expanded')!=='true');}},true);
      setOpen(initialOpen);
    }
    for(const button of query(doc,cfg.sortSelector)) {
      const raw=button.getAttribute('data-sort-by')||button.getAttribute('data-sort')||new URL(button.getAttribute('href')||'',view.url).searchParams.get('sort');
      if(!raw)continue;
      const field=cfg.sortFields?.[raw]||raw;
      button.setAttribute('role','button');button.tabIndex=0;
      const sort=()=>{state.catalogSort={field,desc:state.catalogSort?.field===field&&!state.catalogSort.desc};state.catalogPage=1;draw();};
      button.addEventListener('click',ev=>{ev.preventDefault();ev.stopImmediatePropagation();sort();},true);
      button.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();sort();}});
    }
    const pagerNodes=query(doc,cfg.paginationSelector);
    // A learned structural selector can select only the top copy of a repeated
    // pager. Drive matching copies too, so no original page links survive below
    // the local results after filtering.
    for(const sample of [...pagerNodes]){
      const classes=[...sample.classList];
      if(!classes.some(c=>/paginat|paging|pager/i.test(c)))continue;
      for(const el of query(doc,sample.tagName))if(classes.every(c=>el.classList.contains(c))&&!pagerNodes.includes(el))pagerNodes.push(el);
    }
    const pagers=pagerNodes.map(el=>({el,item:el.querySelector('li')?.cloneNode(true),link:el.querySelector('a')?.cloneNode(true)}));
    const status=doc.createElement('span');status.setAttribute('role','status');status.style.cssText='position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)';list.before(status);

    function matches(entry){
      const hay=cfg.searchMode==='metadata'?`${entry.t} ${Object.values(entry.m||{}).flat().join(' ')}`:entry.t;
      if(state.filter && !Model.norm(hay).includes(Model.norm(state.filter)))return false;
      for(const [name,values] of Object.entries(state.catalogFilters)) {
        if(!values?.length)continue;
        const spec=specs.get(name);if(!spec?.exact&&!spec?.binding)continue;
        if(!spec.exact){if(!Model.matchesBinding(entry,spec.binding,values,spec.labels))return false;continue;}
        const raw=entry.f?.[spec.exact.key];
        const have=(Array.isArray(raw)?raw:[raw??'']).map(v=>Model.norm(spec.exact?v:Model.facetValue(v)));
        const wanted=values.map(v=>spec.exact?v:spec.binding.values?.[v]??spec.labels.get(v)??v).map(Model.norm);
        if(!wanted.some(v=>have.includes(v)))return false;
      }
      return true;
    }
    function draw(){
      for(const cycle of cycles)cycle.refresh();
      if(cfg.resetHiddenClass)for(const reset of query(doc,cfg.resetSelector))reset.classList.toggle(cfg.resetHiddenClass,!state.filter);
      for(const spec of specs.values())if(spec.binding?.selectedClass)for(const input of spec.inputs){
        const item=input.closest('li,label');
        for(const icon of query(item||input,spec.binding.choiceSelector||':scope > span'))icon.classList.toggle(spec.binding.selectedClass,input.checked);
      }
      let rows=source.entries.filter(matches).slice();
      const sort=state.catalogSort;
      if(sort)rows.sort((a,b)=>String(sort.field==='name'?a.t:a.m?.[sort.field]||'').localeCompare(String(sort.field==='name'?b.t:b.m?.[sort.field]||''),undefined,{numeric:true,sensitivity:'base'})*(sort.desc?-1:1));
      else rows.sort((a,b)=>(savedRows.get(a.id)?.order||0)-(savedRows.get(b.id)?.order||0));
      const pages=Math.max(1,Math.ceil(rows.length/pageSize));state.catalogPage=Math.max(1,Math.min(pages,state.catalogPage));
      for(const target of lists)target.replaceChildren();
      for(const entry of rows.slice((state.catalogPage-1)*pageSize,state.catalogPage*pageSize)) {
        const saved=savedRows.get(entry.id),template=doc.createElement('template');
        template.innerHTML=saved?.html||`<li><a data-lwl-href="${esc(entry.u)}" href="${esc(entry.u)}">${esc(entry.t)}</a></li>`;
        const row=template.content.firstElementChild;if(!row)continue;
        row.dataset.lwlEntry=entry.id;(lists[saved?.group||0]||list).append(template.content);decorate(row);
        let panel=null,generation=0;
        const notice=message=>`<div class="lwl-missing-preview" role="status" style="padding:24px;border:1px solid #ccc"><p>${esc(message)}</p><a data-lwl-href="${esc(entry.u)}">${esc(t('View details','Details ansehen'))}</a></div>`;
        const showPanel=html=>{
          const temp=doc.createElement('template');temp.innerHTML=html;
          const next=temp.content.firstElementChild;if(!next)return;
          next.hidden=false;next.removeAttribute('aria-hidden');
          if(next.style.display==='none')next.style.removeProperty('display');
          if(panel)panel.replaceWith(next);else if(cfg.panelPlacement==='inside')row.append(next);else row.after(next);
          panel=next;decorate(panel);
        };
        const toggle=()=>{
          const current=++generation;
          const open=!panel;
          if(panel){panel.remove();panel=null;}
          else {
            showPanel(saved?.panel||notice(saved?.panelRef?t('Loading preview…','Vorschau wird geladen…'):t('This row preview has not been saved yet.','Diese Zeilenvorschau wurde noch nicht gespeichert.')));
            if(saved?.panelRef&&!saved.panel){
              loadPreview(saved).then(html=>{
                if(current===generation&&row.isConnected&&panel)showPanel(html||notice(t('The saved preview is missing.','Die gespeicherte Vorschau fehlt.')));
              }).catch(()=>{
                if(current===generation&&row.isConnected&&panel)showPanel(notice(t('The saved preview could not be opened.','Die gespeicherte Vorschau konnte nicht geöffnet werden.')));
              });
            }
          }
          const stateNode=cfg.rowStateSelector?query(row,cfg.rowStateSelector)[0]:row;
          if(cfg.rowExpandedClass)stateNode?.classList.toggle(cfg.rowExpandedClass,open);
          row.setAttribute('aria-expanded',String(open));
          for(const indicator of query(row,cfg.rowToggleSelector)){
            indicator.setAttribute('aria-expanded',String(open));
            indicator.setAttribute('aria-label',t(open?'Collapse':'Expand',open?'Zuklappen':'Aufklappen')+' '+entry.t);
            if(cfg.indicatorOpenClass)indicator.classList.toggle(cfg.indicatorOpenClass,open);
            if(cfg.indicatorClosedClass)indicator.classList.toggle(cfg.indicatorClosedClass,!open);
          }
        };
        row.addEventListener('click',ev=>{if(!panel?.contains(ev.target)&&!ev.target.closest('a,input,select,button'))toggle();});
        for(const trigger of query(row,cfg.rowToggleSelector)){
          trigger.setAttribute('role','button');trigger.tabIndex=0;trigger.setAttribute('aria-label',t('Expand','Aufklappen')+' '+entry.t);
          trigger.setAttribute('aria-expanded','false');
          trigger.addEventListener('click',ev=>{ev.preventDefault();ev.stopImmediatePropagation();toggle();},true);
          trigger.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();toggle();}});
        }
      }
      if(!rows.length){const empty=doc.createElement('li');empty.textContent=t('No results in this local collection.','Keine Treffer im lokalen Bestand.');empty.style.cssText='list-style:none;padding:32px';list.append(empty);}
      status.textContent=`${rows.length} ${t('entries','Einträge')}`;
      if(state.filter)for(const group of query(doc,cfg.groupSelector)){
        group.hidden=!group.querySelector('[data-lwl-entry]');
        const content=query(group,cfg.groupContentSelector)[0],trigger=query(group,cfg.groupTriggerSelector)[0];
        if(content&&cfg.groupClosedClass)content.classList.remove(cfg.groupClosedClass);
        if(trigger&&cfg.groupHeaderClosedClass)trigger.classList.remove(cfg.groupHeaderClosedClass);
        trigger?.setAttribute('aria-expanded','true');
      }else for(const group of query(doc,cfg.groupSelector))group.hidden=false;
      for(const pager of pagers){
        pager.el.replaceChildren();
        const add=(page,label,extra='')=>{
          const li=pager.item?.cloneNode(false)||doc.createElement('li');if(extra)li.classList.add(extra);
          const link=pager.link?.cloneNode(false)||doc.createElement('a');
          link.removeAttribute('data-lwl-href');link.removeAttribute('target');link.removeAttribute('rel');link.href='#';link.textContent=label;
          if(page===state.catalogPage){link.classList.add('s-active','active');link.setAttribute('aria-current','page');}
          else {link.classList.remove('s-active','active');link.removeAttribute('aria-current');}
          link.addEventListener('click',ev=>{ev.preventDefault();state.catalogPage=page;draw();list.scrollIntoView({block:'start'});});li.append(link);pager.el.append(li);
        };
        if(state.catalogPage>1)add(state.catalogPage-1,t('Previous','Zurück'),'b-pagination-item-prev');
        const selected=new Set([1,pages]);for(let p=Math.max(1,state.catalogPage-2);p<=Math.min(pages,Math.max(5,state.catalogPage+2));p++)selected.add(p);
        let previous=0;for(const page of [...selected].sort((a,b)=>a-b)){if(previous&&page>previous+1){const dots=doc.createElement('li');dots.className='dots';dots.textContent='…';pager.el.append(dots);}add(page,String(page));previous=page;}
        if(state.catalogPage<pages)add(state.catalogPage+1,t('Next','Weiter'),'b-pagination-item-next');
      }
    }
    decorate(doc.body);
    syncControls();draw();
    // Some catalogs put a second set of filter choices behind a "Show more"
    // control beside a clipped list. Keep those choices reachable offline.
    for(const list of query(controls,'ul,ol')){
      const choices=[...list.children].filter(el=>el.querySelector('input[type=checkbox][name],input[type=radio][name]'));
      if(choices.length<3)continue;
      const trigger=[...list.parentElement.children].find(el=>el!==list&&/^(show more|more|mehr anzeigen|mehr)$/i.test(el.textContent.trim()));
      if(!trigger)continue;
      const fixed=choices.filter(el=>{const input=el.querySelector('input');return specs.get(input.name)?.binding?.emptyValues?.includes(input.value);});
      const pages=choices.filter(el=>!fixed.includes(el)),original=new Map(choices.map(el=>[el,el.style.display]));
      let page=0,size=pages.length;
      const show=()=>{
        pages.forEach((el,i)=>el.style.display=i>=page*size&&i<(page+1)*size?'list-item':'none');
        trigger.setAttribute('aria-label',t('More filter choices','Weitere Filtermöglichkeiten')+` (${page+1}/${Math.ceil(pages.length/size)})`);
      };
      const measure=()=>{
        for(const [el,display] of original)el.style.display=display;
        const edge=trigger.getBoundingClientRect().left;
        if(doc.defaultView.getComputedStyle(trigger).display==='none'||edge<=0)return;
        size=Math.max(1,pages.filter(el=>el.getBoundingClientRect().width>0&&el.getBoundingClientRect().right<=edge+1).length);
        page=Math.min(page,Math.ceil(pages.length/size)-1);show();
      };
      trigger.setAttribute('role','button');trigger.tabIndex=0;
      trigger.addEventListener('click',()=>{page=(page+1)%Math.ceil(pages.length/size);show();});
      trigger.addEventListener('keydown',ev=>{if(ev.key==='Enter'||ev.key===' '){ev.preventDefault();trigger.click();}});
      doc.defaultView.addEventListener('resize',measure);measure();
    }
  }

  // Select2's saved markup and CSS provide its appearance; local option data
  // provides the choices. Website code and network requests are not needed.
  function selectWidget(select,container,enabled,disabledReason) {
    const doc=select.ownerDocument,win=doc.defaultView;
    const input=container.querySelector('input');
    const drop=container.querySelector('.select2-drop');
    const results=drop?.querySelector('.select2-results');
    const choices=container.querySelector('.select2-choices');
    if(!input||!drop||!results)return {refresh(){}};
    input.value='';input.placeholder=select.getAttribute('placeholder')||'';
    input.setAttribute('role','combobox');input.setAttribute('aria-expanded','false');input.setAttribute('aria-label',select.name);
    if(!enabled){container.title=disabledReason;input.readOnly=true;input.setAttribute('aria-disabled','true');return {refresh(){}};}
    // Like the original widget, place the menu outside the form's list/grid.
    // Otherwise generic form li rules shrink and clip the result labels.
    doc.body.append(drop);drop.classList.add('lwl-select-dropdown');
    results.id='lwl-options-'+select.id;results.setAttribute('role','listbox');
    input.setAttribute('aria-controls',results.id);
    const style=doc.createElement('style');style.textContent='.lwl-select-dropdown .select2-results>li{float:none;width:auto;max-width:none;display:block;white-space:normal}.lwl-select-dropdown .select2-result-label{white-space:normal;overflow-wrap:anywhere}';drop.append(style);
    let opened=false,highlight=0;
    const close=()=>{opened=false;drop.style.display='none';container.classList.remove('select2-dropdown-open');input.setAttribute('aria-expanded','false');input.removeAttribute('aria-activedescendant');};
    const position=()=>{
      const rect=container.getBoundingClientRect(),width=Math.min(rect.width,Math.max(0,win.innerWidth-16));
      const below=win.innerHeight-rect.bottom-8,above=rect.top-8,up=below<180&&above>below;
      Object.assign(drop.style,{position:'fixed',width:width+'px',left:Math.max(8,Math.min(rect.left,win.innerWidth-width-8))+'px',top:up?'auto':rect.bottom+'px',bottom:up?(win.innerHeight-rect.top)+'px':'auto',zIndex:'100001'});
      results.style.maxHeight=Math.max(40,Math.min(240,(up?above:below)-12))+'px';
    };
    const highlightOption=index=>{
      const options=[...results.querySelectorAll('.select2-result')];
      highlight=Math.max(0,Math.min(index,options.length-1));
      options.forEach((el,i)=>{el.classList.toggle('select2-highlighted',i===highlight);el.setAttribute('aria-selected',String(i===highlight));});
      if(options[highlight])input.setAttribute('aria-activedescendant',options[highlight].id);
      else input.removeAttribute('aria-activedescendant');
    };
    const render=()=>{
      results.replaceChildren();
      const options=[...select.options].filter(o=>!o.disabled&&!o.selected&&Model.norm(o.textContent).includes(Model.norm(input.value)));
      highlight=Math.min(highlight,Math.max(0,options.length-1));
      options.forEach((option,index)=>{
        const li=doc.createElement('li');li.className='select2-results-dept-0 select2-result select2-result-selectable'+(index===highlight?' select2-highlighted':'');
        li.setAttribute('role','option');li.setAttribute('aria-selected',String(index===highlight));
        li.id=results.id+'-'+index;
        const label=doc.createElement('div');label.className='select2-result-label';label.textContent=option.textContent.trim();li.append(label);
        li.addEventListener('mousedown',ev=>ev.preventDefault());
        li.addEventListener('pointermove',()=>highlightOption(index));
        li.addEventListener('mousemove',()=>highlightOption(index));
        li.addEventListener('click',()=>{option.selected=true;input.value='';select.dispatchEvent(new win.Event('change',{bubbles:true}));refresh();close();input.focus();});results.append(li);
      });
      if(!options.length){const li=doc.createElement('li');li.className='select2-no-results';li.textContent='No matches found';results.append(li);}
      highlightOption(highlight);position();
    };
    const open=()=>{opened=true;highlight=0;container.classList.add('select2-dropdown-open');drop.style.display='block';input.setAttribute('aria-expanded','true');render();};
    function refresh(){
      for(const old of container.querySelectorAll('.select2-search-choice'))old.remove();
      if(choices)for(const option of select.selectedOptions){
        if(!option.value)continue;
        const li=doc.createElement('li');li.className='select2-search-choice';
        const label=doc.createElement('div');label.textContent=option.textContent.trim();
        const remove=doc.createElement('a');remove.className='select2-search-choice-close';remove.href='#';remove.setAttribute('aria-label','Remove '+label.textContent);
        remove.addEventListener('click',ev=>{ev.preventDefault();ev.stopPropagation();option.selected=false;select.dispatchEvent(new win.Event('change',{bubbles:true}));refresh();});
        li.append(label,remove);choices.insertBefore(li,choices.lastElementChild);
      }
      input.placeholder=select.selectedOptions.length?'':select.getAttribute('placeholder')||'';
      if(opened)render();
    }
    input.addEventListener('input',()=>{highlight=0;open();});
    container.addEventListener('click',ev=>{if(!ev.target.closest('.select2-search-choice-close,.select2-result')){open();input.focus();}});
    input.addEventListener('keydown',ev=>{
      if(ev.key==='Escape'){close();return;}
      if(ev.key==='Tab'){close();return;}
      if(['ArrowDown','ArrowUp','Home','End','Enter'].includes(ev.key)){
        ev.preventDefault();if(!opened){open();return;}
        if(ev.key==='Enter')results.querySelectorAll('.select2-result')[highlight]?.click();
        else {highlightOption(ev.key==='Home'?0:ev.key==='End'?results.children.length-1:highlight+(ev.key==='ArrowDown'?1:-1));results.querySelector('.select2-highlighted')?.scrollIntoView({block:'nearest'});}
      }
    });
    doc.addEventListener('click',ev=>{if(!container.contains(ev.target)&&!drop.contains(ev.target))close();});
    doc.addEventListener('scroll',ev=>{if(opened&&!drop.contains(ev.target))position();},true);
    win.addEventListener('resize',()=>{if(opened)position();});
    close();refresh();return {refresh};
  }
  window.LWLReaderCatalog=Object.freeze({mount});
})();
