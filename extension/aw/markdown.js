/* HTML as AnotherWorldbuilder's Markdown: paragraphs, emphasis, lists,
   tables, quotes — the same as tools' html2md.py, on the browser's own DOM.
   Links to pages the package holds become links to their documents
   (`@@art:…|text@@`); every other link is plain text. `resolve(href, text)`
   decides what an `<a>` becomes. */
(() => {
  'use strict';
  const BLOCK = new Set(['p', 'div', 'section', 'article', 'aside', 'header', 'footer', 'figure', 'figcaption', 'img', 'dl', 'dd', 'dt', 'blockquote', 'ul', 'ol', 'table', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr']);
  const SKIP = new Set(['script', 'style', 'noscript', 'template', 'svg', 'img', 'button', 'nav', 'form', 'input', 'select', 'figcaption']);
  const TEXT = 3, ELEMENT = 1;

  const squeeze = text => text.replace(/[ \t\r\n ]+/g, ' ');
  // Marks of the app's own language stay text.
  const escape = text => text.replace(/@@/g, '@ @').replace(/%%/g, '% %').replace(/\[\[/g, '[ [');
  function wrap(text, mark) {
    const stripped = text.trim();
    if (!stripped) return text;
    // Bold in bold stays bold once: ****x**** is not markdown.
    if (stripped.length > 2 * mark.length && stripped.startsWith(mark) && stripped.endsWith(mark) && stripped[mark.length] !== '*' && stripped[stripped.length - mark.length - 1] !== '*') return text;
    const lead = text.slice(0, text.length - text.trimStart().length);
    const trail = text.slice(text.trimEnd().length);
    return `${lead}${mark}${stripped}${mark}${trail}`;
  }
  function tidyLines(text) {
    const lines = text.split('\n').map(l => l.trim());
    return lines.length > 1 ? lines.filter(Boolean).join('\n') : text.trim();
  }
  const name = node => node.localName || node.nodeName.toLowerCase();

  class Converter {
    constructor(resolve, skipClasses = [], options = {}) {
      this.resolve = resolve || (() => null);
      this.skipClasses = new Set(skipClasses);
      this.options = options;
      this.detachedImages = [];
    }
    skipped(node) {
      return (SKIP.has(name(node)) && !(this.options.image && ['img', 'figcaption'].includes(name(node)))) || [...(node.classList || [])].some(c => this.skipClasses.has(c));
    }
    marked(blocks, node) {
      const anchor = this.options.anchor?.(node);
      if (!anchor || !blocks.length) return blocks;
      const lines = blocks[0].split('\n');
      if (/^<(?:image|embed)\s/.test(lines[0]) || /\s\^[a-z0-9-]+\s*(?:\|\s*)?$/i.test(lines[0])) return ['\u200b ^' + anchor, ...blocks];
      lines[0] = /\|\s*$/.test(lines[0]) ? lines[0].replace(/\s*\|\s*$/, ` ^${anchor} |`) : lines[0] + ' ^' + anchor;
      return [lines.join('\n'), ...blocks.slice(1)];
    }
    // Lists and table cells flatten their text. Keep native anchors at a
    // line's end; images from these compact structures follow the chapter.
    flattened(text, detachImages = true) {
      const anchors = [];
      if (this.options.anchor) text = text.replace(/[\s\u200b]+\^(ddb-[a-z0-9]{20})\b/g, (_, id) => { anchors.push(id); return ''; });
      if (detachImages && this.options.image) text = text.replace(/<image src=dicefox-image-\d+>/g, tag => { this.detachedImages.push(tag); return ''; });
      return { text, anchors };
    }
    anchor(c) {
      const inner = this.inline(c);
      const href = c.getAttribute('data-lwl-href') || c.getAttribute('href') || '';
      const made = inner.trim() ? this.resolve(href, inner.trim()) : null;
      return made || inner;
    }
    inlineOne(c) {
      const n = name(c);
      if (n === 'br') return '\n';
      if (n === 'strong' || n === 'b') return wrap(this.inline(c), '**');
      if (n === 'em' || n === 'i') return wrap(this.inline(c), '*');
      if (n === 'a') return this.anchor(c);
      if (n === 'img' && this.options.image) return '\n\n' + this.options.image(c) + '\n\n';
      return this.inline(c);
    }
    inline(node) {
      let out = '';
      for (const c of node.childNodes) {
        if (c.nodeType === TEXT) { out += escape(squeeze(c.nodeValue)); continue; }
        if (c.nodeType !== ELEMENT || this.skipped(c)) continue;
        const made = this.inlineOne(c);
        const anchor = this.options.anchor?.(c);
        out += made + (anchor ? `\n\u200b ^${anchor}\n` : '');
      }
      return out;
    }
    blocks(node) {
      const out = [];
      let pending = '';
      const flush = () => {
        const made = this.flattened(pending, false);
        pending = '';
        const text = made.text.trim();
        if (text) out.push(tidyLines(text));
        out.push(...made.anchors.map(id => '\u200b ^' + id));
      };
      for (const c of node.childNodes) {
        if (c.nodeType === TEXT) { pending += escape(squeeze(c.nodeValue)); continue; }
        if (c.nodeType !== ELEMENT || this.skipped(c)) continue;
        if (!BLOCK.has(name(c))) {
          const anchor = this.options.anchor?.(c);
          pending += this.inlineOne(c) + (anchor ? `\n\u200b ^${anchor}\n` : '');
          continue;
        }
        flush();
        out.push(...this.marked(this.block(c), c));
      }
      flush();
      return out.filter(b => b.trim());
    }
    block(c) {
      // A block the caller writes itself — as written, not escaped — and what of it is read on after.
      const own = this.options.replace?.(c);
      if (own != null) {
        if (typeof own === 'string') return own ? [own] : [];
        return [...(own.text ? [own.text] : []), ...(own.after || []).flatMap(n => this.marked(this.block(n), n))];
      }
      const n = name(c);
      if (n === 'img' && this.options.image) { const image = this.options.image(c); return image ? [image] : []; }
      if (n === 'figcaption') {
        const made = this.flattened(this.inline(c));
        const text = squeeze(made.text).trim();
        return text ? ['*' + text + '*', ...made.anchors.map(id => '\u200b ^' + id)] : [];
      }
      if (/^h[1-6]$/.test(n)) {
        const made = this.flattened(this.inline(c));
        const text = squeeze(made.text).trim();
        const level=Math.min(6,Math.max(this.options.minHeadingLevel||1,Number(n[1])-(this.options.headingOffset??1)));
        return text ? [`${'#'.repeat(level)} ${text}`, ...made.anchors.map(id => '\u200b ^' + id)] : [];
      }
      if (n === 'p') {
        const made = this.flattened(this.inline(c), false);
        const text = made.text.trim();
        return [...(text ? [tidyLines(text)] : []), ...made.anchors.map(id => '\u200b ^' + id)];
      }
      if (n === 'hr') return ['---'];
      if (n === 'ul' || n === 'ol') return [this.listing(c, n === 'ol')];
      if (n === 'table') { const t = this.table(c); return t ? [t] : []; }
      if (n === 'blockquote') {
        const inner = this.blocks(c).join('\n\n');
        return inner ? [inner.split('\n').map(l => (l ? '> ' + l : '>')).join('\n')] : [];
      }
      if (n === 'dl') {
        const rows = [], anchors = [];
        for (const child of c.children) {
          const cn = name(child);
          if (cn !== 'dt' && cn !== 'dd') continue;
          const made = this.flattened(this.inline(child));
          anchors.push(...made.anchors);
          const own = this.options.anchor?.(child);
          if (own) anchors.push(own);
          const text = squeeze(made.text).trim();
          if (!text) continue;
          if (cn === 'dd' && rows.length) rows[rows.length - 1] += ' ' + text;
          else rows.push(text);
        }
        return [...(rows.length ? [rows.join('\n')] : []), ...anchors.map(id => '\u200b ^' + id)];
      }
      return this.blocks(c);
    }
    listing(c, ordered) {
      const imageStart=this.detachedImages.length;
      const lines = [];
      let i = 0;
      for (const li of c.children) {
        if (name(li) !== 'li') continue;
        i++;
        const nested = [...li.children].filter(x => name(x) === 'ul' || name(x) === 'ol');
        for (const x of nested) x.remove();
        const flattened = this.flattened(this.blocks(li).join(' '));
        const text = squeeze(flattened.text).trim();
        lines.push(ordered ? `${i}. ${text}` : `- ${text}`);
        const own = this.options.anchor?.(li);
        for (const anchor of new Set([...flattened.anchors, ...(own ? [own] : [])])) lines.push(`    \u200b ^${anchor}`);
        for (const x of nested) lines.push(...this.listing(x, name(x) === 'ol').split('\n').map(l => '    ' + l));
      }
      return lines.join('\n')+this.detachedImages.splice(imageStart).map(tag=>'\n\n'+tag).join('');
    }
    table(c) {
      const rows = [], anchors = [],carry=new Map();
      const imageStart=this.detachedImages.length;
      let hasHeader=false;
      for (const tr of c.querySelectorAll('tr')) {
        if (tr.closest('table') !== c) continue;
        const cells = [];let column=0;
        const fill=()=>{while(carry.has(column)){cells[column]='';const left=carry.get(column)-1;if(left)carry.set(column,left);else carry.delete(column);column++;}};
        for (const cell of tr.children) {
          if (!['th', 'td'].includes(name(cell))) continue;
          // A head is a first row of column heads only; a th beside a td labels its row.
          if(!rows.length)hasHeader=(column===0||hasHeader)&&name(cell)==='th';
          fill();
          const flattened = this.flattened(this.blocks(cell).join(' '));
          anchors.push(...flattened.anchors);
          const own = this.options.anchor?.(cell);
          if (own) anchors.push(own);
          cells[column]=squeeze(flattened.text).trim().replace(/\|/g, '\\|');
          const span = Number(cell.getAttribute('colspan') || 1) || 1;
          const rowspan=Math.max(1,Number(cell.getAttribute('rowspan'))||1);
          for(let k=0;k<span;k++){if(k)cells[column+k]='';if(rowspan>1)carry.set(column+k,rowspan-1);}
          column+=span;
        }
        if (cells.some(Boolean)) rows.push(cells);
        const own = this.options.anchor?.(tr);
        if (own) anchors.push(own);
      }
      if (!rows.length) return '';
      const width = Math.max(...rows.map(r => r.length));
      const full = rows.map(r => Array.from({length:width},(_,i)=>r[i]||''));
      if(!hasHeader)full.unshift(Array(width).fill(''));
      const caption=c.querySelector('caption'),label=caption?squeeze(this.inline(caption)).trim():'';
      return (label?'*'+label+'*\n\n':'')+[
        '| ' + full[0].join(' | ') + ' |',
        '|' + Array(width).fill('---').join('|') + '|',
        ...full.slice(1).map(r => '| ' + r.join(' | ') + ' |'),
      ].join('\n') + (anchors.length ? '\n\n' + [...new Set(anchors)].map(id => '\u200b ^' + id).join('\n\n') : '')+this.detachedImages.splice(imageStart).map(tag=>'\n\n'+tag).join('');
    }
  }

  function toMarkdown(node, resolve, skipClasses = [], options = {}) {
    if (!node) return '';
    const converter = new Converter(resolve, skipClasses, options);
    const blocks = converter.marked(converter.blocks(node), node);
    const text = [...blocks, ...converter.detachedImages].join('\n\n').trim();
    // What a site leaves of its own markup in the text, it tidies itself.
    return options.tidy ? options.tidy(text) : text;
  }
  const inline = (node, resolve, options = {}) => { const text = new Converter(resolve).inline(node); return options.tidy ? options.tidy(text) : text; };

  globalThis.AWMarkdown = Object.freeze({ toMarkdown, inline, Converter });
})();
