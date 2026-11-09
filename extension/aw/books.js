/* Full books are separate from the compendium's Source value documents, so
   adding them also works in worlds that already contain those sources. */
(() => {
  'use strict';
  const { articleId, ulidOf, link } = AWIds;
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  /* A page's key: its address without what only moves within it, and in the
     form the site names it — where two addresses name the same page, one. */
  function keyer({ origin, aliases = {} } = {}) {
    const renamed = Object.entries(aliases);
    return value => {
      const u = new URL(value, origin);
      u.hash = ''; u.search = '';
      for (const [from, to] of renamed) if (u.pathname === from || u.pathname.startsWith(from + '/')) { u.pathname = to + u.pathname.slice(from.length); break; }
      return u.href.replace(/\/+$/, '');
    };
  }
  function fragment(value) {
    try { return decodeURIComponent(value.replace(/^#/, '')); }
    catch { return value.replace(/^#/, ''); }
  }
  const anchor = value => 'ddb-' + ulidOf('book-anchor', value).toLowerCase().slice(0, 20);

  /* How the site sets its books, as its profile names them (`bookLayout`):
     - statBlock: a creature's stat block. Where `embed` names the creature's
       document — its title links to it, `creature` — the chapter draws that
       in instead of a flattened copy.
     - abilities, sectionNames: inside a block that stays the chapter's text,
       the ability values in pairs and the names of its sections.
     - content, navigation: where a chapter's text stands, and what of it only
       finds the way round the book.
     Without one, a chapter is read as it stands. */
  function layoutOf(layout = {}) {
    const matches = (node, selector) => !!selector && node.matches?.(selector);
    // Read pages carry their links as data-lwl-href; a page as served, as href.
    const hrefOf = a => a.getAttribute('data-lwl-href') || a.getAttribute('href');
    function statBlockOf(node) {
      if (!matches(node, layout.statBlock) || !layout.creature) return null;
      const title = node.querySelector(layout.creature);
      return title ? hrefOf(title) : null;
    }
    /* A stat block without a creature to draw in stays the chapter's text, read
       as one: its abilities a row of values, its sections named in bold. */
    function keptStatBlock(node) {
      if (!layout.statBlock || !node.parentElement?.closest(layout.statBlock)) return null;
      if (matches(node, layout.abilities)) {
        // Names and scores in turn, or each ability a box of its name and score.
        const boxed = node.children.length && [...node.children].every(c => c.children.length >= 2);
        const cells = (boxed ? [...node.children].flatMap(c => [c.children[0].textContent, [...c.children].slice(1).map(x => x.textContent).join(' ')]) : [...node.children].map(c => c.textContent))
          .map(text => clean(text).replace(/\|/g, '\\|'));
        if (cells.length < 2 || cells.length % 2) return null;
        const names = cells.filter((_, i) => !(i % 2)), values = cells.filter((_, i) => i % 2);
        return [names, names.map(() => '---'), values].map(row => '| ' + row.join(' | ') + ' |').join('\n');
      }
      if (matches(node, layout.sectionNames)) {
        const name = clean(node.textContent);
        return name ? '**' + name + '**' : '';
      }
      return null;
    }
    return { statBlockOf, keptStatBlock, content: layout.content, navigation: layout.navigation };
  }

  function create({ entries, books = [], types, parse, site = {}, tidy, resolveRule = () => null, streaming = false, inlineRoot = false, embed = () => null }) {
    const urlKey = keyer(site), { statBlockOf, keptStatBlock, content, navigation } = layoutOf(site.layout);
    const byType = new Map(types.map(t => [t.id, t]));
    if (books.length) {
      for (const [id, label, kind, target] of [['book','URL','text'], ['book-chapter','Book','reference','book'], ['book-chapter','Order','number'], ['book-chapter','URL','text']]) {
        const field = byType.get(id)?.properties?.find(p => p.label === label);
        if (!field || field.kind !== kind || (target && field.article_type !== target)) {
          throw new Error(`The world's ${id} template needs the ${label} field (${kind}${target ? ' to '+target : ''}) before books can be sent.`);
        }
      }
    }
    const byBook = new Map(books.map(b => [b.id, b]));
    // A creature's stat block is the section of its own page styled as one: the book has the lore around it.
    const statSection = (byType.get('monster')?.blocks || []).find(b => b.style === 'statblock')?.title || 'Stat block';
    const byUrl = new Map();
    const chapters = entries.filter(e => e.book && byBook.has(e.book));
    const wantedAnchors = new Map(chapters.map(e => [urlKey(e.u), new Set(e.anchors || [])]));
    const bookId = b => articleId('book', urlKey(b.url));
    const sourceId = b => articleId('Source', clean(b.name).toLowerCase());
    for (const b of books) byUrl.set(urlKey(b.url), { id:bookId(b), chapter:inlineRoot });
    // Missing chapter targets remain plain text instead of dead wiki links.
    for (const e of chapters.filter(e => e.has)) {
      // The book's own page, also under the chapter address it opens on.
      if(inlineRoot&&urlKey(e.u)===urlKey(byBook.get(e.book).url)){for(const u of e.a||[])byUrl.set(urlKey(u),byUrl.get(urlKey(e.u)));continue;}
      const target = { id:articleId('book-chapter', urlKey(e.u)), chapter:true };
      for (const u of [e.u, ...(e.a || [])]) byUrl.set(urlKey(u), target);
    }
    function resolve(href, text) {
      let u;
      try { u = new URL(href, site.origin); } catch { return null; }
      let target = byUrl.get(urlKey(u.href));
      // A streaming chapter can name another chapter before it is received.
      if (!target && streaming && books.some(b=>urlKey(u.href).startsWith(urlKey(b.url)+'/'))) {
        target = {id:articleId('book-chapter',urlKey(u.href)),chapter:true};
      }
      if (!target) return null;
      return link(target.id + (target.chapter && u.hash ? '#^' + anchor(fragment(u.hash)) : ''), text);
    }
    function section(typeId, title) {
      return byType.get(typeId)?.blocks?.find(b => b.title === title)?.key || title.toLowerCase().replace(/ /g, '-');
    }
    function emit(typeId, id, name, values, texts) {
      const fields = {};
      for (const p of byType.get(typeId)?.properties || []) if (values[p.label] != null && values[p.label] !== '') fields[p.key] = values[p.label];
      const part = (key, text, fields = {}) => ({ section:key, title:'', text, fields, view:'all', edit:'gm' });
      return { id, type:typeId, slug:slug(name), name, view:'all', edit:'gm', fields:{}, parts:[
        part('properties', '', fields),
        ...Object.entries(texts).filter(([,text]) => text.trim()).map(([title,text]) => part(section(typeId,title), text)),
      ] };
    }
    const steps = chapters.filter(e => e.has).sort((a,b) => String(a.book).localeCompare(String(b.book)) || a.order-b.order || a.u.localeCompare(b.u))
      .map(e => {
        const root=inlineRoot&&urlKey(e.u)===urlKey(byBook.get(e.book).url);
        return {e,kind:'book-chapter',root,name:clean(e.t),id:root?bookId(byBook.get(e.book)):articleId('book-chapter',urlKey(e.u))};
      });

    function bookDocuments(b,content='',counts=true){
      const own=chapters.filter(e=>e.book===b.id&&(!inlineRoot||urlKey(e.u)!==urlKey(b.url)));
      const source=sourceId(b),captured=own.filter(e=>e.has).length;
      return [
        {id:source,type:'source',slug:slug(b.name),name:b.name,view:'all',edit:'gm',fields:{},parts:[]},
        emit('book',bookId(b),b.name,{
          Cover:b.cover?{image:b.cover,name:b.name}:null,Source:source,URL:b.url,
          ...(counts?{'Captured chapters':captured,'Missing chapters':own.length-captured}:{}),
        },{Description:content,Contents:'<list type=book-chapter where="Book=self" style=tree sort=Order>'}),
      ];
    }

    function roots(ids = new Set(books.map(b => b.id))) {
      const docs = [];
      for (const b of books) {
        if (!ids.has(b.id)) continue;
        if(inlineRoot&&chapters.some(e=>e.book===b.id&&e.has&&urlKey(e.u)===urlKey(b.url)))continue;
        docs.push(...bookDocuments(b));
      }
      return docs;
    }

    function build(step, html) {
      if (!html?.trim()) throw new Error('No captured chapter content');
      const b = byBook.get(step.e.book);
      if (!b) throw new Error('Chapter has no book');
      const soup = parse(html);
      const root = soup.querySelector([content, 'article', 'main'].filter(Boolean).join(', ')) || soup.body;
      const heading=root.querySelector('h1,h2');
      let headingOffset=1;
      if(inlineRoot){
        if(!step.root&&heading)step.name=clean(heading.textContent)||step.name;
        const title=clean(heading?.textContent).toLowerCase();
        // The app already renders the document title. DDB often repeats it
        // in an outer H1 and the article's first H2.
        let removed=0;
        for(const node of [...root.querySelectorAll('h1,h2')]){
          if(removed>=2||clean(node.textContent).toLowerCase()!==title)break;
          const id=node.id;const next=node.nextElementSibling;
          if(id&&next&&!next.id)next.id=id;
          else if(id){const anchor=soup.createElement('a');anchor.setAttribute('name',id);node.before(anchor);}
          node.remove();removed++;
          headingOffset=Number(node.localName[1])-1;
        }
        for(const node of root.querySelectorAll(['[data-lwl-book-navigation]',navigation].filter(Boolean).join(',')))node.remove();
        if(step.root)for(const node of [...root.querySelectorAll('h1,h2')]){
          if(!/^(?:table of )?contents$/i.test(clean(node.textContent)))continue;
          const level=Number(node.localName[1]);let next=node.nextElementSibling;
          while(next&&!( /^h[1-6]$/.test(next.localName)&&Number(next.localName[1])<=level)){
            const after=next.nextElementSibling;next.remove();next=after;
          }
          node.remove();
        }
      }
      if(inlineRoot){
        const used=new Set([...root.querySelectorAll('[id],a[name]')].map(node=>node.id||node.getAttribute('name')));
        for(const node of root.querySelectorAll('h1,h2,h3,h4,h5,h6')){
          if(node.id||node.querySelector('a[name]'))continue;
          const base='dicefox-heading-'+(slug(clean(node.textContent))||'section');let id=base,number=1;
          while(used.has(id))id=base+'-'+(++number);
          node.id=id;used.add(id);
        }
      }
      // Keep meaningful destinations rather than every layout/tooltip id.
      // Cross-chapter destinations come from the captured link metadata.
      for (const node of root.querySelectorAll('a[href], a[data-lwl-href]')) {
        try {
          const u = new URL(node.getAttribute('data-lwl-href') || node.getAttribute('href'), step.e.u);
          if (u.hash) wantedAnchors.get(urlKey(u.href))?.add(fragment(u.hash));
        } catch { /* malformed saved link */ }
      }
      const images = [];
      const text = AWMarkdown.toMarkdown(root, (href, label) => {
        let abs;
        try { abs = new URL(href, step.e.u).href; } catch { return null; }
        return resolveRule(abs, label) || resolve(abs, label);
      }, [], {
        ...(inlineRoot?{headingOffset,minHeadingLevel:2}:{}),tidy,
        replace:node => {
          const kept = keptStatBlock(node);
          if (kept != null) return kept;
          const href = statBlockOf(node);
          let id = null;
          try { id = href ? embed(urlKey(new URL(href, step.e.u).href)) : null; } catch { id = null; }
          if (!id) return null;
          // Pictures some books set inside the block stay the chapter's, after it.
          const pictures = [...node.querySelectorAll('figure')].filter(f => !f.parentElement.closest('figure'));
          // Links into the block land where it stands; those to a picture, at the picture.
          const marks = [node, ...node.querySelectorAll('[id],a[name]')].filter(n => !pictures.some(f => f.contains(n))).map(n => {
            const nid = n.getAttribute('id') || (n.localName === 'a' && n.getAttribute('name'));
            return nid ? anchor(nid) : '';
          }).filter(Boolean);
          return { text: [...new Set(marks)].map(m => '\u200b ^' + m + '\n\n').join('') + `<embed of=${id} section="${statSection}">`, after: pictures };
        },
        anchor:node => {
          const id = node.getAttribute('id') || (node.localName === 'a' && node.getAttribute('name'));
          const meaningful = streaming || /^h[1-6]$/.test(node.localName) || (node.localName === 'a' && node.hasAttribute('name')) || wantedAnchors.get(urlKey(step.e.u))?.has(id);
          return id && meaningful ? anchor(id) : '';
        },
        image:node => {
          const src = node.getAttribute('data-lwl-src') || node.getAttribute('src');
          if (!src) return '';
          let url;
          try { url = new URL(src, step.e.u).href; } catch { return ''; }
          if (!/^https?:|^data:image\//i.test(url)) return '';
          const token = 'dicefox-image-' + images.length;
          images.push({ token, url, name:clean(node.getAttribute('alt')) || step.name });
          return `<image src=${token}>`;
        },
      });
      if (!text.trim()&&!step.root) throw new Error('Captured chapter has no readable content');
      const docs=step.root?bookDocuments(b,text,false):[emit('book-chapter',step.id,step.name,{Book:bookId(b),Order:step.e.order,URL:step.e.u},{Content:text})];
      if(images.length)docs.find(d=>d.type===(step.root?'book':'book-chapter'))._images=images;
      return docs;
    }
    return { steps, roots, build, resolve, missing:chapters.filter(e => !e.has).length,
      incomplete:chapters.filter(e => e.captureStatus === 'incomplete').length };
  }
  globalThis.AWBooks = Object.freeze({ create, layoutOf });
})();
