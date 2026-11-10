/* D&D Beyond, as the library holds it, as AnotherWorldbuilder documents —
   the port of the app's private converter (ddb_blueprint.py): the same types,
   names, ids and texts, so a world built by either recognises the other's.

   Every compendium entry becomes a document — monsters, spells, magic items,
   equipment, feats, backgrounds, species, classes with their subclasses — and
   every rule of the glossary. Links between entries become links between
   documents. Where several books hold an entry of the same name, the most
   current book keeps the name; the others carry their book in brackets.

   Only what the user owns goes: entries whose book is not among the user's
   own library books stay out (the free rules always come along). */
(() => {
  'use strict';
  const { articleId, link } = AWIds;
  const { toMarkdown, inline } = AWMarkdown;

  const KINDS = ['classes', 'backgrounds', 'species', 'feats', 'spells', 'equipment', 'magic-items', 'monsters'];
  const TYPE_OF = { backgrounds: 'background', species: 'species', feats: 'feat', spells: 'spell', equipment: 'item', 'magic-items': 'item', monsters: 'monster' };
  const VALUES = {
    Size: ['Tiny', 'Small', 'Medium', 'Large', 'Huge', 'Gargantuan'],
    'Creature type': ['Aberration', 'Beast', 'Celestial', 'Construct', 'Dragon', 'Elemental', 'Fey', 'Fiend', 'Giant', 'Humanoid', 'Monstrosity', 'Ooze', 'Plant', 'Undead'],
    Alignment: ['Lawful good', 'Neutral good', 'Chaotic good', 'Lawful neutral', 'Neutral', 'Chaotic neutral', 'Lawful evil', 'Neutral evil', 'Chaotic evil', 'Unaligned'],
    'Spell school': ['Abjuration', 'Conjuration', 'Divination', 'Enchantment', 'Evocation', 'Illusion', 'Necromancy', 'Transmutation'],
    Rarity: ['Common', 'Uncommon', 'Rare', 'Very rare', 'Legendary', 'Artifact'],
    'Feat category': ['Origin', 'General', 'Fighting style', 'Epic boon'],
    Environment: ['Arctic', 'Coastal', 'Desert', 'Forest', 'Grassland', 'Hill', 'Mountain', 'Swamp', 'Underdark', 'Underwater', 'Urban'],
  };
  const SHORT = {
    'Player’s Handbook': 'PHB', 'Player’s Handbook (2014)': 'PHB 2014', 'Monster Manual': 'MM', 'Monster Manual (2014)': 'MM 2014',
    'Dungeon Master’s Guide': 'DMG', 'Dungeon Master’s Guide (2014)': 'DMG 2014', 'Basic Rules (2014)': 'BR 2014',
    'D&D Beyond Basic Rules': 'Basic Rules', "Xanathar's Guide to Everything": 'XGtE', 'Tasha’s Cauldron of Everything': 'TCoE',
    "Volo's Guide to Monsters": 'VGtM', 'Mordenkainen’s Tome of Foes': 'MToF', 'Mordenkainen Presents: Monsters of the Multiverse': 'MPMM',
    "Fizban's Treasury of Dragons": 'FToD', 'Bigby Presents: Glory of the Giants': 'BPGotG', "Explorer's Guide to Wildemount": 'EGtW',
    "Sword Coast Adventurer's Guide": 'SCAG', "Elemental Evil Player's Companion": 'EEPC', 'Van Richten’s Guide to Ravenloft': 'VRGtR',
    'Forgotten Realms: Heroes of Faerûn': 'HoF', 'Eberron: Rising from the Last War': 'ERLW', 'Guildmasters’ Guide to Ravnica': 'GGR',
    'Mythic Odysseys of Theros': 'MOoT', 'The Book of Many Things': 'BoMT', 'Tal’Dorei Campaign Setting Reborn': 'TCSR',
  };
  const CORE_2024 = ['Player’s Handbook', 'Monster Manual', 'Dungeon Master’s Guide', 'D&D Beyond Basic Rules', 'Forgotten Realms: Heroes of Faerûn', 'Eberron: Forge of the Artificer'];
  const OLD = ['Basic Rules (2014)', 'Player’s Handbook (2014)', 'Monster Manual (2014)', 'Dungeon Master’s Guide (2014)'];
  /* Free to everyone — they need no book of one's own. */
  const FREE = ['D&D Beyond Basic Rules', 'Basic Rules (2014)', 'Free Rules', 'System Reference Document 5.1', 'System Reference Document 5.2'];
  const ORIGIN = 'https://www.dndbeyond.com';

  const squeeze = s => String(s || '').replace(/\s+/g, ' ').trim();
  /* The site's own markup left in its text, [kind attr]Name;Shown[/kind] or
     [kind]Name[kind]: what it shows. */
  const tidy = text => text.replace(/\[([a-z]+)(?:\s[^\]]*)?\]([^\[\]\n]*?)\[\/?\1\]/gi, (_, _kind, body) => body.includes(';') ? body.slice(body.indexOf(';') + 1) : body);

  /* Text as BeautifulSoup's get_text(" ", strip=True) gives it: pieces apart. */
  function textOf(node) {
    if (!node) return '';
    const out = [];
    const walk = n => { for (const c of n.childNodes) { if (c.nodeType === 3) { const t = c.nodeValue.trim(); if (t) out.push(t); } else if (c.nodeType === 1) walk(c); } };
    walk(node);
    return squeeze(out.join(' '));
  }
  const bookKey = s => String(s || '').toLowerCase().replace(/[’']/g, "'").replace(/[^a-z0-9]+/g, ' ').trim();
  const capFirst = s => (s ? s[0].toUpperCase() + s.slice(1) : s);
  /* Python's str.title(): a letter after a non-letter starts a word. */
  const title = s => s.toLowerCase().replace(/(^|[^\p{L}])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
  const isLower = s => s === s.toLowerCase() && s !== s.toUpperCase();
  function number(text) { const m = /-?\d[\d,]*/.exec(text || ''); return m ? parseInt(m[0].replace(/,/g, ''), 10) : null; }
  function rolls(text) {
    return text
      .replace(/(Attack Roll:\*?\s*)([+−-]\d+)/g, (_, a, b) => `${a}[[${b.replace('−', '-')}]]`)
      .replace(/(Weapon Attack:\*?\s*|Spell Attack:\*?\s*)([+−-]\d+)(\s+to hit)/g, (_, a, b, c) => `${a}[[${b.replace('−', '-')}]]${c}`);
  }
  const unlink = s => s.replace(/@@art:[^|@]+\|([^@]+)@@/g, '$1');

  function normUrl(url) {
    let u = String(url || '').split('?')[0].trim().toLowerCase().replace(/\/+$/, '');
    return u.replace('/sources/dnd/free-rules', '/sources/dnd/br-2024');
  }
  function listedSource(entry) {
    const raw = squeeze(Array.isArray(entry.m?.source) ? entry.m.source[0] : entry.m?.source);
    const m = /^(.*?)(?:,\s*pg\.?\s*(\d+))?\s*$/.exec(raw);
    return m ? [m[1].trim(), m[2] ? parseInt(m[2], 10) : null] : [raw, null];
  }
  // The list marks an older version of an entry.
  const legacyOf = e => e.m?.legacy === 'true' ? 1 : 0;
  function rank(book) {
    if (CORE_2024.includes(book)) return CORE_2024.indexOf(book);
    if (OLD.includes(book)) return 1000 + OLD.indexOf(book);
    return 100;
  }
  const short = book => SHORT[book] || book;
  const dataTypeId = kind => kind.toLowerCase().replace(/ /g, '-');
  const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const part = (section, text = '', fields = {}) => ({ section, title: '', text, fields, view: 'all', edit: 'gm', level: 'open' });

  /* The converter over one library: `entries` with s (kind), u, t, m, a;
     `glossary` with term, url, definition; `types` the world's (or the
     template's); `owned` the user's library books. `parse(html)` gives a
     document. `keep(node)` reads a creature set in an entry's text as a book
     does (`AWBooks.layoutOf`). Documents come out as built, with images asked
     for by URL. */
  function create({ entries, glossary = [], types, owned = [], bookNames = [], selectedUrls = [], parse, resolveExtra = () => null, bindings = {}, pending = [], keep = () => null }) {
    const byType = new Map(types.map(t => [t.id, t]));
    const ownedKeys = new Set(owned.map(bookKey));
    /* A book as the library spells it: the lists write some in another case
       ("Tome Of Foes"), which would miss its short name and its rank. One the
       library does not name keeps its small words small. */
    const spelled = new Map([...Object.keys(SHORT), ...CORE_2024, ...OLD, ...FREE, ...owned, ...bookNames].map(b => [bookKey(b), b]));
    const small = book => book.replace(/(?<!^|:)(\s)(Of|The|To|From|And|In|On|For|A|An|At|With)(?=\s)/g, (_, space, word) => space + word.toLowerCase());
    const sourceOf = e => {
      const [book, page] = listedSource(e);
      return [spelled.get(bookKey(book)) ?? small(book), page];
    };
    const free = new Set(FREE.map(bookKey));
    // The selection UI names captured, accessible records explicitly. A partial
    // local list of book titles must not silently remove those selections.
    // Other callers retain the original owned-books filter by default.
    const selected = new Set(selectedUrls.map(normUrl));
    const later = new Set(pending.filter(kind => kind !== 'classes'));
    const mine = e => [e.u,...(e.a || [])].some(url=>selected.has(normUrl(url))) || !ownedKeys.size || free.has(bookKey(sourceOf(e)[0])) || ownedKeys.has(bookKey(sourceOf(e)[0])) || !sourceOf(e)[0];
    const byKind = Object.fromEntries(KINDS.map(k => [k, []]));
    let left = 0;
    for (const e of entries) {
      if (!byKind[e.s] || !e.has) continue;
      if (!mine(e)) { left++; continue; }
      byKind[e.s].push(e);
    }
    const books = new Set([...KINDS.flatMap(k => byKind[k].map(e => sourceOf(e)[0])), ...Object.keys(SHORT), ...CORE_2024, ...OLD]);

    const byUrl = new Map();
    const docs = new Map();
    const dataDocs = new Map();
    let fresh = []; // value documents made since the last take

    /* A value as a document of its own — of `type` where it is a kind of the
       list (`weapon-category` for Equipment category), else of the list's
       type. A value no list has yet is made: content beyond the core rules
       (a weapon property of a third party's book) comes in with it. */
    function dataDoc(kind, name, type = dataTypeId(kind)) {
      name = squeeze(name).replace(/^,+|,+$/g, '').trim();
      if (!name) return null;
      const key = name.toLowerCase();
      const k = kind + '\0' + key;
      if (!dataDocs.has(k)) {
        const id = articleId(kind, key);
        dataDocs.set(k, id);
        fresh.push({ id, type: byType.has(type) ? type : dataTypeId(kind), slug: slug(name), name: capFirst(name), view: 'all', edit: 'gm', fields: {}, parts: [] });
      }
      return dataDocs.get(k);
    }
    /* A field of a type as the world has it, inherited too — a world whose
       weapon still writes its damage type as text gets text. */
    function fieldOf(typeId, label) {
      for (let t = byType.get(typeId), n = 0; t && n < 20; t = byType.get(t.supertype), n++) {
        const f = (t.properties || []).find(x => x.label === label);
        if (f) return f;
      }
      return null;
    }
    const listed = (typeId, label) => fieldOf(typeId, label)?.kind === 'reference';
    /* A creature's type as one of the list: `Swarm of Tiny Beasts` is beasts,
       a sentence about it names one. */
    function creatureType(raw) {
      const s = squeeze(raw).replace(/\.$/, '');
      const swarm = /^swarm of \w+ (.+)$/i.exec(s);
      const words = (swarm ? swarm[1] : s).toLowerCase();
      const known = VALUES['Creature type'];
      const plural = k => (k.endsWith('y') ? k.slice(0, -1) + 'ies' : k.endsWith('s') || k === 'Undead' || k === 'Fey' ? k : k + 's');
      const exact = known.find(k => words === k.toLowerCase() || words === plural(k).toLowerCase());
      if (exact) return exact;
      if (s.split(' ').length > 3) {
        const named = known.find(k => new RegExp(`\\b(${k}|${plural(k)})\\b`, 'i').test(s));
        if (named) return named;
      }
      return isLower(s) ? title(s) : s;
    }
    function sourceFields(e) {
      const [book, page] = sourceOf(e);
      const out = {};
      if (book) out.Source = dataDoc('Source', book);
      if (page) out.Page = page;
      return out;
    }

    // Names first: who keeps the plain name, who carries a book.
    const plainTitle = e => squeeze(e.t).replace(/^[“”"]+|[“”"]+$/g, '');
    const planned = [];
    const plannedNames = new Set();
    for (const kind of KINDS) {
      if (kind === 'classes') continue;
      const groups = new Map();
      for (const e of byKind[kind]) {
        const k = plainTitle(e).toLowerCase();
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(e);
      }
      for (const same of groups.values()) {
        // The current version keeps the plain name; an older one, or one from
        // another book, carries its book — or "Legacy" where the list names no book.
        same.sort((a, b) => legacyOf(a) - legacyOf(b) || rank(sourceOf(a)[0]) - rank(sourceOf(b)[0]) || String(a.i).localeCompare(String(b.i)));
        same.forEach((e, i) => {
          const plain = plainTitle(e);
          let name = plain, later = false;
          if (i > 0) {
            const book = sourceOf(e)[0];
            name = book ? `${plain} (${short(book)})` : legacyOf(e) ? `${plain} (Legacy)` : plain;
            // Its book is known once its page is read: named then.
            later = !book;
            if (plannedNames.has(name)) name = `${name} ${i + 1}`;
          }
          plannedNames.add(name);
          planned.push({ kind, e, name, plain, later });
        });
      }
    }
    for (const { kind, e, name } of planned) {
      const id = articleId(kind, e.u);
      for (const url of [e.u, ...(e.a || [])]) byUrl.set(normUrl(url), id);
      docs.set(id, { type: TYPE_OF[kind], name });
    }
    // Classes: the current one keeps the name, the old one is “(Legacy)”.
    const classes = byKind.classes.map(e => {
      const t = squeeze(e.t);
      const legacy = ` ${t} `.includes(' Legacy ') || legacyOf(e);
      const name = t.replace(/\s*(Legacy.*|Class Details)$/, '').replace(' Class Details', '').trim() + (legacy ? ' (Legacy)' : '');
      const id = articleId('classes', e.u);
      byUrl.set(normUrl(e.u), id);
      docs.set(id, { type: 'class', name });
      return { e, name, id };
    });
    // Value documents are created only when an exported field uses them.

    // The glossary: rules to link to.
    const rules = glossary.map(g => {
      const id = articleId('rule', g.term);
      byUrl.set(normUrl(g.url), id);
      docs.set(id, { type: 'rule', name: g.term });
      return { id, type: 'rule', slug: slug(g.term), name: g.term, view: 'all', edit: 'gm', fields: {}, parts: [part('description', g.definition)] };
    });

    function resolve(href, text) {
      let abs = href;
      try { abs = new URL(href, ORIGIN).href; } catch { /* as written */ }
      let target = byUrl.get(normUrl(abs));
      if (!target && abs.includes('#')) target = byUrl.get(normUrl(abs.split('#')[0]));
      if (!target) target = promised(abs);
      return target ? link(target, text) : null;
    }
    // A list still to be read: its entries' ids follow from their addresses,
    // so a link to one is made now and leads there once it is imported.
    function promised(abs) {
      if (!later.size) return null;
      let u;
      try { u = new URL(abs); } catch { return null; }
      if (u.origin !== ORIGIN) return null;
      const path = u.pathname.replace(/\/+$/, '');
      const m = /^\/([a-z-]+)\/[0-9]+-[^/]+$/.exec(path);
      return m && later.has(m[1]) ? articleId(m[1], ORIGIN + path) : null;
    }
    const markdown = (node, skip = []) => toMarkdown(node, (href, text) => resolve(href, text) || resolveExtra(href, text), skip, { tidy, replace: keep });

    // Images: a page's own — not the icon every spell shares.
    const imageUses = new Map();
    const mainImage = soup => {
      const img = soup.querySelector('.details-aside img, .image img, .image-container img, .content-image img, img.monster-image, img.magic-item-image');
      const src = img && (img.getAttribute('data-lwl-src') || img.getAttribute('src'));
      if (!src || src.startsWith('data:')) return null;
      try { return new URL(src, ORIGIN).href; } catch { return null; }
    };
    const imageField = (src, name) => (src && (imageUses.get(src) || 0) <= 3 ? { image: src, name } : null);

    // --- The kinds -------------------------------------------------------------------

    function monster(e, name, soup) {
      const block = soup.querySelector('.mon-stat-block-2024, .mon-stat-block');
      const p = block && block.classList.contains('mon-stat-block-2024') ? 'mon-stat-block-2024' : 'mon-stat-block';
      const fields = sourceFields(e);
      const meta = block ? textOf(block.querySelector(`.${p}__meta`)) : '';
      let m = /^(\w+(?: or \w+)?)\s+([^,(]+?)(?:\s*\(([^)]*)\))?,\s*(.+)$/i.exec(meta);
      if (m) {
        fields.Size = dataDoc('Size', m[1].replace(/ Or /, ' or '));
        fields['Creature type'] = dataDoc('Creature type', creatureType(m[2]));
        // A swarm says what it is a swarm of, beside its type.
        const swarm = /^swarm of .+$/i.exec(m[2].trim());
        if (m[3] || swarm) fields.Tags = [swarm?.[0].toLowerCase(), m[3]].filter(Boolean).join(', ');
        fields.Alignment = dataDoc('Alignment', title(m[4]));
      }
      const attributes = {};
      if (block) for (const a of block.querySelectorAll(`.${p}__attribute`)) {
        const labels = a.querySelectorAll(`.${p}__attribute-label`), values = a.querySelectorAll(`.${p}__attribute-data-value`), extras = a.querySelectorAll(`.${p}__attribute-data-extra`);
        labels.forEach((label, i) => { attributes[textOf(label)] = [i < values.length ? textOf(values[i]) : '', i < extras.length ? textOf(extras[i]) : '']; });
      }
      const ac = attributes.AC || attributes['Armor Class'];
      if (ac) { fields['Armor class'] = number(ac[0]); if (ac[1]) fields.Armor = ac[1].replace(/^\(+|\)+$/g, ''); }
      const hp = attributes.HP || attributes['Hit Points'];
      if (hp) { fields['Hit points'] = number(hp[0]); if (hp[1]) fields['Hit dice'] = hp[1].replace(/^\(+|\)+$/g, ''); }
      if (attributes.Speed) fields.Speed = attributes.Speed[0];
      if (attributes.Initiative) fields.Initiative = attributes.Initiative[0];
      const names = { STR: 'Strength', DEX: 'Dexterity', CON: 'Constitution', INT: 'Intelligence', WIS: 'Wisdom', CHA: 'Charisma' };
      // The 2024 block prints each save beside the modifier; one that differs is proficient.
      const saves = [];
      if (block) {
        for (const row of block.querySelectorAll('table.stat-table tbody tr')) {
          const th = row.querySelector('th'), tds = row.querySelectorAll('td');
          if (!th || !tds.length || !names[textOf(th)]) continue;
          fields[names[textOf(th)]] = number(textOf(tds[0]));
          if (tds.length > 2 && textOf(tds[2]) !== textOf(tds[1])) saves.push(`${title(textOf(th))} ${textOf(tds[2])}`);
        }
        for (const tile of block.querySelectorAll('.ability-block__stat')) {
          const head = textOf(tile.querySelector('.ability-block__heading'));
          if (names[head]) fields[names[head]] = number(textOf(tile.querySelector('.ability-block__score')));
        }
      }
      const tidbits = {};
      if (block) for (const t of block.querySelectorAll(`.${p}__tidbit`)) {
        const label = textOf(t.querySelector(`.${p}__tidbit-label`)), data = t.querySelector(`.${p}__tidbit-data`);
        if (label && data) tidbits[label] = inline(data, resolve, { tidy }).trim();
      }
      if (saves.length && !('Saving Throws' in tidbits)) tidbits['Saving Throws'] = saves.join(', ');
      const simple = { 'Saving Throws': 'Saving throws', Skills: 'Skills', 'Damage Vulnerabilities': 'Vulnerabilities', Vulnerabilities: 'Vulnerabilities',
        'Damage Resistances': 'Resistances', Resistances: 'Resistances', 'Damage Immunities': 'Immunities', Immunities: 'Immunities',
        'Condition Immunities': 'Condition immunities', Gear: 'Gear', Senses: 'Senses', Languages: 'Languages' };
      const lines = [];
      for (const [label, field] of Object.entries(simple)) {
        if (label in tidbits && !(field in fields)) {
          fields[field] = unlink(tidbits[label]);
          lines.push(`**${label}** ${tidbits[label]}`);
        }
      }
      const cr = tidbits.CR || tidbits.Challenge;
      // A creature with a lair is worth more there: "10 (XP 5,900, or 7,200 in lair; PB +4)".
      let lair = '';
      if (cr) {
        m = /^([\d/]+)\s*\((?:XP\s*)?(\d+(?:,\d{3})*)(?:\s*XP)?(?:,\s*or\s*(\d+(?:,\d{3})*)\s*in lair)?(?:[;,]\s*PB\s*\+?(\d+))?/.exec(cr.replace(/\*/g, ''));
        if (m) {
          fields['Challenge rating'] = m[1];
          fields.Experience = parseInt(m[2].replace(/,/g, ''), 10);
          if (m[3]) lair = m[3].replace(/,/g, '');
          if (m[4]) fields['Proficiency bonus'] = parseInt(m[4], 10);
        }
      }
      if ('Proficiency Bonus' in tidbits) fields['Proficiency bonus'] = number(tidbits['Proficiency Bonus']);
      for (const env of soup.querySelectorAll('.environment-tag')) (fields.Environment ||= []).push(dataDoc('Environment', title(textOf(env))));

      // The stat block, written as the book prints it — values read from the
      // properties, so the infobox and the block never disagree.
      const sb = [];
      sb.push(`*%%Size%% %%Creature type%%${'Tags' in fields ? ' (%%Tags%%)' : ''}${'Alignment' in fields ? ', %%Alignment%%' : ''}*`);
      sb.push('---');
      const head = [];
      if ('Armor class' in fields) head.push('**Armor Class** %%Armor class%%' + ('Armor' in fields ? ' (%%Armor%%)' : ''));
      if ('Initiative' in fields) head.push('**Initiative** %%Initiative%%');
      if ('Hit points' in fields) head.push('**Hit Points** %%Hit points%%' + ('Hit dice' in fields ? ' (%%Hit dice%%)' : ''));
      if ('Speed' in fields) head.push('**Speed** %%Speed%%');
      sb.push(head.join('\n'));
      if (Object.values(names).every(n => n in fields)) sb.push('<abilities show=Abilities with=mod short="STR, DEX, CON, INT, WIS, CHA">');
      sb.push('---');
      if ('Challenge rating' in fields) {
        let extra = 'Experience' in fields ? '%%Experience%% XP' + (lair ? `, or ${lair} in lair` : '') : '';
        if ('Proficiency bonus' in fields) extra += '; PB +%%Proficiency bonus%%';
        lines.push('**Challenge** %%Challenge rating%%' + (extra ? ` (${extra})` : ''));
      }
      if (lines.length) sb.push(lines.join('\n'));
      if (block) for (const d of block.querySelectorAll(`.${p}__description-block`)) {
        const heading = textOf(d.querySelector(`.${p}__description-block-heading`));
        const content = d.querySelector(`.${p}__description-block-content`);
        const body = content ? rolls(markdown(content)) : '';
        if (heading) sb.push(`## ${heading}`);
        if (body) sb.push(body);
      }
      const stat = sb.filter(s => s.trim()).join('\n\n');
      const lore = soup.querySelector('.more-info-content');
      const description = (lore ? markdown(lore) : '').replace(/^#+ Description\s*\n+/, '');
      const image = imageField(mainImage(soup), name);
      if (image) fields.Image = image;
      return [fields, { 'Stat block': stat, Description: description }];
    }

    function spell(e, name, soup) {
      const fields = sourceFields(e);
      const items = {};
      for (const item of soup.querySelectorAll('.ddb-statblock-item')) items[textOf(item.querySelector('.ddb-statblock-item-label'))] = textOf(item.querySelector('.ddb-statblock-item-value'));
      fields.Level = items.Level || '';
      if (items.School) fields.School = dataDoc('Spell school', items.School);
      fields['Casting time'] = items['Casting Time'] || '';
      fields.Range = (items['Range/Area'] || '').replace(/\( /g, '(').replace(/ \)/g, ')');
      fields.Components = items.Components || '';
      fields.Duration = items.Duration || '';
      if (items['Attack/Save']) fields['Attack or save'] = items['Attack/Save'];
      if (items['Damage/Effect']) fields['Damage or effect'] = items['Damage/Effect'];
      for (const tag of soup.querySelectorAll('.class-tag')) {
        const t = textOf(tag);
        if (t.includes(' - ')) (fields._subclasses ||= []).push(t.split(' - ').slice(1).join(' - ').replace(/\s*\([A-Za-z]+\)$/, '').trim());
        else (fields._classes ||= []).push(t);
      }
      // The material the components name, once and labelled: the page has it as "* - (…)".
      const material = soup.querySelector('.components-blurb');
      const blurb = material ? textOf(material).replace(/^[*\s]*-\s*/, '').replace(/\*$/, '').trim() : '';
      material?.remove();
      const body = soup.querySelector('.more-info-content');
      let text = body ? markdown(body) : '';
      if (blurb) text += '\n\n*Material:* ' + blurb;
      return [fields, { Description: text }];
    }

    // A thing's kind is its type: a magic item's by what its line says, a piece
    // of equipment's by its category.
    const MAGIC_KINDS = { weapon: 'weapon', armor: 'armor', potion: 'potion', ring: 'ring', rod: 'rod', scroll: 'scroll', staff: 'staff', wand: 'wand', 'wondrous item': 'wondrous-item' };
    const CATEGORY_OF = { weapon: 'weapon-category', armor: 'armor-category', gear: 'gear-category' };
    const MASTERIES = ['Cleave', 'Graze', 'Nick', 'Push', 'Sap', 'Slow', 'Topple', 'Vex'];
    /* Equipment of the library by its name — `Armor (plate)` names Plate
       Armor. The current edition's where both have it, as names go. */
    const equipmentNamed = name => {
      const want = [name, name + ' armor'].map(n => n.toLowerCase());
      const found = byKind.equipment.filter(e => want.includes(String(e.t).toLowerCase())).sort((a, b) => legacyOf(a) - legacyOf(b));
      return found.length ? byUrl.get(normUrl(found[0].u)) ?? null : null;
    };
    function kindOfEquipment(category) {
      if (category.includes('Weapon')) return 'weapon';
      if (['Armor', 'Light Armor', 'Medium Armor', 'Heavy Armor', 'Shield'].includes(category)) return 'armor';
      return category === 'Potion' ? 'potion' : 'gear';
    }

    function magicItem(e, name, soup) {
      const fields = sourceFields(e);
      const details = textOf(soup.querySelector('.item-info .details'));
      const m = /^([^,(]+?)(?:\s*\(([^)]*)\))?,\s*([^(]+?)(?:\s*\((requires attunement[^)]*)\))?\s*$/.exec(details);
      const kind = (m ? m[1] : details.split(',')[0]).trim().toLowerCase();
      fields._type = MAGIC_KINDS[kind] || 'wondrous-item';
      // The weapon or armor it is made of — where the line names one, not `any sword`.
      const label = { weapon: 'Base weapon', armor: 'Base armor' }[fields._type];
      if (label && m?.[2] && !/^any\b/i.test(m[2].trim()) && fieldOf(fields._type, label)) {
        const base = equipmentNamed(m[2].trim());
        if (base) fields[label] = [base];
      }
      if (m) {
        const r = m[3].trim();
        fields.Rarity = dataDoc('Rarity', r[0].toUpperCase() + r.slice(1).toLowerCase());
        if (m[4]) fields.Attunement = m[4][0].toUpperCase() + m[4].slice(1);
      }
      const body = soup.querySelector('.more-info-content');
      const image = imageField(mainImage(soup), name);
      if (image) fields.Image = image;
      return [fields, { Description: body ? markdown(body) : '' }];
    }

    function equipment(e, name, soup) {
      const fields = sourceFields(e);
      const root = soup.querySelector('.details-container-content-description, .more-info-content, .primary-content');
      let text = root ? markdown(root, ['tags', 'source', 'item-source', 'details-container-content-footer']) : '';
      const m = /Type:\s*(.+?)\s+Cost:\s*(.+?)\s+Weight:\s*(.+?)$/.exec(text.split('\n')[0]);
      const kind = m ? kindOfEquipment(m[1]) : 'gear';
      if (m) {
        // Each kind its own list of categories — a weapon's, an armor's, gear's.
        fields.Category = dataDoc('Equipment category', m[1], CATEGORY_OF[kind] || 'equipment-category');
        fields.Cost = m[2];
        fields.Weight = m[3];
        text = text.split('\n').slice(1).join('\n').trim();
      }
      // Values read as shown: links in a table cell or a heading are only their text.
      const plain = text.replace(/@@(?:[^@\\|]|\\(?!\|))*\\?\|([^@]*)@@/g, '$1').replace(/@@[^@:]*:([^@|#]*)@@/g, '$1');
      const table = cells => {
        const at = plain.split('\n').findIndex(l => /^\| Name \|/.test(l));
        if (at < 0) return null;
        const split = l => l.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.replace(/\\\|/g, '|').trim());
        const head = split(plain.split('\n')[at]), row = split(plain.split('\n')[at + 2] || '');
        return Object.fromEntries(cells.map(c => [c, row[head.indexOf(c)]]).filter(([, v]) => v));
      };
      const weapon = table(['Damage', 'Properties']);
      if (weapon?.Damage) {
        const damage = /^(.*?)\s+(Acid|Bludgeoning|Cold|Fire|Force|Lightning|Necrotic|Piercing|Poison|Psychic|Radiant|Slashing|Thunder)$/i.exec(weapon.Damage);
        fields.Damage = damage ? damage[1] : weapon.Damage;
        if (damage) {
          const type = damage[2][0].toUpperCase() + damage[2].slice(1).toLowerCase();
          fields['Damage type'] = listed('weapon', 'Damage type') ? [dataDoc('Damage type', type)] : type;
        }
      }
      const mastery = /mastery property[^\n]*\n+\*\*\*([\w ]+?)\.\*\*\*/.exec(plain);
      if (mastery) fields.Mastery = mastery[1];
      if (weapon?.Properties) {
        if (listed('weapon', 'Properties')) {
          // Each its own value: `Thrown (range 20/60)` is Thrown, its range
          // beside it; a mastery the table lists with them is the mastery.
          const picked = [];
          for (const raw of weapon.Properties.split(/,(?![^(\[]*[)\]])/)) {
            const p = /^\s*([^([]+?)\s*(?:[([]\s*([^)\]]*?)\s*[)\]])?\s*$/.exec(raw);
            if (!p) continue;
            const name = p[1].replace(/\b\p{L}/gu, c => c.toUpperCase());
            if (MASTERIES.includes(name)) {
              fields.Mastery ||= name;
              continue;
            }
            if (/^versatile$/i.test(name) && p[2]) fields.Versatile = p[2];
            const range = /^(thrown|ammunition|range)$/i.test(name) && /(\d+\s*\/\s*\d+)/.exec(p[2] || '');
            if (range) fields.Range = range[1].replace(/\s/g, '');
            picked.push(dataDoc('Weapon property', name));
          }
          fields.Properties = picked.filter(Boolean);
        } else fields.Properties = weapon.Properties;
      }
      if (fields.Mastery && listed('weapon', 'Mastery')) fields.Mastery = dataDoc('Weapon mastery', fields.Mastery);
      const ac = table(['Armor Class', 'Armor Class (AC)']);
      const armorClass = ac && (ac['Armor Class'] || ac['Armor Class (AC)']);
      fields._type = kind;
      if (fields._type !== 'weapon') for (const label of ['Damage', 'Damage type', 'Properties', 'Mastery', 'Versatile', 'Range']) delete fields[label];
      if (fields._type === 'armor' && armorClass) fields['Armor class'] = armorClass;
      text = text.replace(/\n+Tags:\n*(?:.+\n*)*$/, '').trim();
      return [fields, { Description: text }];
    }

    function feat(e, name, soup) {
      const fields = sourceFields(e);
      const root = soup.querySelector('.details-container-content-description');
      let text = root ? markdown(root) : '';
      const m = /^\*(.+?) Feat(?: \(Prerequisite: (.+?)\))?\*\s*/.exec(text);
      if (m) {
        fields.Category = dataDoc('Feat category', m[1]);
        if (m[2]) fields.Prerequisite = m[2];
        text = text.slice(m[0].length);
      } else {
        const prereq = /\*?Prerequisite:?\*?\s*([^\n]+)/.exec(text);
        if (prereq) fields.Prerequisite = prereq[1].replace(/^[ *]+|[ *]+$/g, '');
      }
      return [fields, { Description: text.trim() }];
    }

    function background(e, name, soup) {
      const fields = sourceFields(e);
      const root = soup.querySelector('.details-container-content-description');
      const text = root ? markdown(root) : '';
      const labels = { 'Ability Scores': 'Ability scores', 'Skill Proficiencies': 'Skill proficiencies', 'Tool Proficiencies': 'Tool proficiencies', 'Tool Proficiency': 'Tool proficiencies', Languages: 'Languages', Equipment: 'Equipment' };
      for (const [label, field] of Object.entries(labels)) {
        const m = new RegExp('\\*\\*' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ':\\*\\*\\s*(.+)').exec(text);
        if (m) fields[field] = unlink(m[1]).replace(/^[ *]+|[ *]+$/g, '');
      }
      const m = /\*\*Feat:\*\*\s*(@@(art:[^|@]+)\|[^@]+@@)?([^\n]*)/.exec(text);
      if (m && m[2]) fields.Feat = m[2];
      const image = imageField(mainImage(soup), name);
      if (image) fields.Image = image;
      return [fields, { Description: text }];
    }

    function species(e, name, soup) {
      const fields = sourceFields(e);
      const root = soup.querySelector('.static-container .content-container, .content-container');
      if (root) for (const h of root.querySelectorAll('h1')) h.remove();
      let text = root ? markdown(root, ['sidebar-menu', 'source', 'content-image']) : '';
      const book = sourceOf(e)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp('\\n*' + book + '(, pg\\. \\d+)?\\s*$'), '').trim();
      for (const [label, field] of [['Creature Type', 'Creature type'], ['Size', 'Size'], ['Speed', 'Speed']]) {
        const m = new RegExp('\\*\\*' + label + ':\\*\\*\\s*([^\\n]+)').exec(text);
        if (m) {
          const value = unlink(m[1]).trim();
          fields[field] = field === 'Creature type' ? dataDoc('Creature type', creatureType(value)) : value;
        }
      }
      const image = imageField(mainImage(soup), name);
      if (image) fields.Image = image;
      return [fields, { Description: text }];
    }

    function klass(e, name, soup) {
      const fields = sourceFields(e);
      const root = soup.querySelector('.static-container .content-container, .primary-content');
      if (root) for (const junk of root.querySelectorAll('h1, .sidebar-menu, .compendium-image-center img')) junk.remove();
      // The core traits table: Primary Ability, Hit Point Die …
      const table = root && root.querySelector('table');
      if (table) {
        const mapping = { 'Primary Ability': 'Primary ability', 'Hit Point Die': 'Hit point die', 'Saving Throw Proficiencies': 'Saving throws',
          'Skill Proficiencies': 'Skill proficiencies', 'Weapon Proficiencies': 'Weapon proficiencies', 'Armor Training': 'Armor training' };
        for (const row of table.querySelectorAll('tr')) {
          const cells = [...row.children].filter(c => /^t[hd]$/i.test(c.tagName));
          if (cells.length === 2) {
            const label = textOf(cells[0]);
            if (mapping[label]) fields[mapping[label]] = unlink(inline(cells[1], resolve, { tidy }).trim());
          }
        }
      }
      // An older class has no traits table: its features name the same, line by line.
      if (root && !Object.keys(fields).some(k => k !== 'Source' && k !== 'Page')) {
        const lines = { 'Hit Dice': 'Hit point die', 'Saving Throws': 'Saving throws', Skills: 'Skill proficiencies', Weapons: 'Weapon proficiencies', Armor: 'Armor training' };
        for (const strong of root.querySelectorAll('p strong, p b')) {
          const label = textOf(strong).replace(/:$/, '');
          if (!lines[label] || fields[lines[label]]) continue;
          const rest = [];
          for (let n = strong.nextSibling; n && !(n.nodeType === 1 && /^(strong|b|br)$/i.test(n.tagName)); n = n.nextSibling) rest.push(n.textContent);
          const value = squeeze(rest.join('')).replace(/^:\s*/, '');
          if (value) fields[lines[label]] = value;
        }
      }
      // The subclasses stand in boxes of their own: one document each. The
      // first line names the book, set in italics — also one no list read
      // so far has named (classes come first).
      const subclasses = [];
      if (root) for (const item of root.querySelectorAll('.subitems-list-details-item')) {
        const h2 = item.querySelector('h2');
        const heading = textOf(h2);
        if (h2) h2.remove();
        const first = item.querySelector('p');
        let book = null;
        const italic = first?.children.length === 1 && /^(em|i)$/i.test(first.firstElementChild.tagName) && textOf(first) === textOf(first.firstElementChild);
        if (first && (italic || books.has(textOf(first)))) { book = textOf(first); first.remove(); }
        subclasses.push([heading, book, markdown(item)]);
      }
      if (root) for (const box of root.querySelectorAll('.subitems-list-details')) box.remove();
      // The rest: the class as it begins, then its features.
      const sections = { Description: [], Features: [] };
      let current = 'Description';
      if (root) for (const node of [...root.childNodes]) {
        if (node.nodeType === 1 && node.tagName.toLowerCase() === 'h2') {
          const t = textOf(node);
          if (/Subclasses?$/.test(t)) continue;
          if (/Features$/.test(t)) current = 'Features';
        }
        sections[current].push(node);
      }
      const md = nodes => { const holder = soup.createElement('div'); for (const n of nodes) holder.append(n.cloneNode(true)); return markdown(holder); };
      const image = imageField(mainImage(soup), name);
      if (image) fields.Image = image;
      const texts = { Description: md(sections.Description), Features: md(sections.Features), Subclasses: '<list type=Subclass below=self>' };
      const out = subclasses.map(([heading, book, text]) => {
        let sub = heading.replace(/\s*Legacy This doesn.t reflect.*$/, '');
        sub = sub.replace(/\s*\((?:Legacy|[A-Za-z]{2,6})\)$/, '').trim();
        return [sub, book, text];
      });
      return [fields, texts, out];
    }

    const BUILD = { monsters: monster, spells: spell, 'magic-items': magicItem, equipment, feats: feat, backgrounds: background, species };

    // --- Writing ---------------------------------------------------------------------

    function section(typeId, heading) {
      let t = byType.get(typeId);
      while (t) {
        const b = (t.blocks || []).find(x => x.title === heading);
        if (b) return b.key;
        t = byType.get(t.supertype || '');
      }
      throw Error(`${typeId}: no section ${heading}`);
    }
    function effectiveFields(typeId) {
      const out = [], seen = new Set(), todo = [typeId];
      while (todo.length) {
        const id = todo.pop();
        if (seen.has(id) || !byType.has(id)) continue;
        seen.add(id);
        const t = byType.get(id);
        for (const f of t.properties || []) { out.push(f); if (f.kind === 'group') todo.push(f.group); }
        if (t.supertype) todo.push(t.supertype);
      }
      return out;
    }
    const keysOf = new Map();
    const missing = new Set();
    function keyed(typeId, fields) {
      if (!keysOf.has(typeId)) keysOf.set(typeId, new Map(effectiveFields(typeId).map(f => [f.label, f.key])));
      const keys = keysOf.get(typeId), out = {};
      for (const [label, value] of Object.entries(fields)) {
        if (label.startsWith('_') || value == null || value === '' || (Array.isArray(value) && !value.length)) continue;
        // The world's own type of that id may lack it: the value stays out.
        if (!keys.has(label)) { missing.add(`${typeId}: ${label}`); continue; }
        out[keys.get(label)] = value;
      }
      return out;
    }
    function emit(typeId, id, name, fields, texts) {
      const parts = [];
      const props = keyed(typeId, fields);
      if (Object.keys(props).length) parts.push(part('properties', '', props));
      for (const [heading, text] of Object.entries(texts)) if (text.trim()) parts.push(part(section(typeId, heading), text));
      return { id, type: typeId, slug: slug(name), name, view: 'all', edit: 'gm', fields: {}, parts };
    }

    // What the library uses again and again is an icon, not the entry's picture.
    function countIcons(htmlOf) {
      for (const { kind, e } of planned) {
        if (!['spells', 'feats', 'backgrounds', 'equipment'].includes(kind)) continue;
        const html = htmlOf(e);
        if (!html) continue;
        const src = mainImage(parse(html));
        if (src) imageUses.set(src, (imageUses.get(src) || 0) + 1);
      }
    }

    const classByName = new Map(bindings.classes || []);
    const subclassByName = new Map(bindings.subclasses || []);

    /* The work, in the order it has to happen: classes first (spells link to
       them), then everything else. Each step is a list of entries; `build`
       turns one into documents. */
    const steps = [...classes.map(c => ({ ...c, kind: 'classes' })), ...planned];
    function build(step, html) {
      const soup = parse(html);
      const made = [];
      if (step.kind === 'classes') {
        const [fields, texts, subs] = klass(step.e, step.name, soup);
        made.push(emit('class', step.id, step.name, fields, texts));
        classByName.set(step.name, step.id);
        const legacy = step.name.endsWith('(Legacy)');
        for (const [sub, book, text] of subs) {
          const shown = sub + (legacy ? ' (Legacy)' : '');
          const subId = articleId('subclass', step.e.u, sub);
          docs.set(subId, { type: 'subclass', name: shown });
          // The same subclass in the current and the legacy class: both kept.
          const slot = subclassByName.get(sub.toLowerCase()) || {};
          slot[legacy ? 'legacy' : 'current'] ||= subId;
          subclassByName.set(sub.toLowerCase(), slot);
          const source = book ? { Source: dataDoc('Source', book) } : sourceFields(step.e);
          made.push(emit('subclass', subId, shown, { Class: step.id, ...source }, { Description: text }));
        }
        return made;
      }
      const id = articleId(step.kind, step.e.u);
      if (step.later && sourceOf(step.e)[0]) {
        const named = `${step.plain} (${short(sourceOf(step.e)[0])})`;
        if (!plannedNames.has(named)) { plannedNames.add(named); step.name = named; docs.get(id).name = named; }
        step.later = false;
      }
      const [fields, texts] = BUILD[step.kind](step.e, step.name, soup);
      const typeId = fields._type || TYPE_OF[step.kind];
      delete fields._type;
      if (typeId === 'spell') {
        fields.Classes = [...new Set((fields._classes || []).map(c => classByName.get(c)).filter(Boolean))].sort();
        // A 2014 book's spell names the legacy subclass, any other the current one.
        const old = OLD.includes(sourceOf(step.e)[0]);
        const pick = slot => slot && (old ? slot.legacy || slot.current : slot.current || slot.legacy);
        fields.Subclasses = [...new Set((fields._subclasses || []).map(s => pick(subclassByName.get(s.toLowerCase()))).filter(Boolean))].sort();
      }
      made.push(emit(typeId, id, step.name, fields, texts));
      return made;
    }
    /* Value documents made since the last call — they go with what names them. */
    const take = () => { const out = fresh; fresh = []; return out; };

    return { steps, rules, build, take, countIcons, left, missing, resolve,
      checkpoint:()=>({classes:[...classByName],subclasses:[...subclassByName]}),
      types: [...new Set(['rule', 'abilities', ...Object.keys(VALUES).map(dataTypeId), 'source', ...Object.values(TYPE_OF), ...Object.values(MAGIC_KINDS), 'gear', 'class', 'subclass'])] };
  }

  globalThis.AWDndBeyond = Object.freeze({ create, KINDS, tidy });
})();
