<p align="center"><img src="extension/icons/icon128.png" width="96" alt=""></p>

<h1 align="center">DiceFox</h1>

<p align="center">A browser extension that brings the D&amp;D content <b>your D&amp;D Beyond account unlocks</b> into a world of
<a href="https://github.com/dicefoxcreations/AnotherWorldbuilder">AnotherWorldbuilder</a> — monsters, spells,
items, classes, books — as linked documents.</p>

> **Unofficial.** DiceFox is not affiliated with, endorsed, sponsored or approved by D&D
> Beyond or Wizards of the Coast. It reads only what your own D&D Beyond account opens in
> your own browser, and sends it to the app on the same computer — nothing goes to the
> author or anyone else. The content stays the property of its rights holders and is
> licensed to you under D&D Beyond's terms; you are responsible for using it within them.
> Do not share it.

## What it does

- Lists what you can open on D&D Beyond — classes with their subclasses, backgrounds,
  species, feats, spells, equipment, magic items, monsters, the rules glossary and the
  books of your library — and lets you check whole categories, single books or single
  entries.
- Imports the selection into a world you are the GM of, entry by entry: stat blocks,
  properties, pictures and the links between entries. Books keep their chapters, tables
  and contents.
- Checks the world's types before it starts and adds what is missing — the D&D 5e
  template of the app.
- Leaves what is there alone: a second import adds only what is new — unless you choose
  *Update existing entries*.

## Install

1. Install [AnotherWorldbuilder](https://github.com/dicefoxcreations/AnotherWorldbuilder/releases/latest)
   0.2.18 or later and turn on *Options → Browser → Browser extension*.
2. Download this repository (*Code → Download ZIP*) and unpack it.
3. In Chrome or another Chromium browser (130 or later) open `chrome://extensions`,
   turn on *Developer mode*, choose *Load unpacked* and pick the `extension` folder.
4. Pin DiceFox in the browser's extension menu.

## Use

1. Sign in to D&D Beyond and open it. Click DiceFox: its side panel opens and reads the
   category lists.
2. Check what you want — a category, a book or single entries.
3. Choose **Export…**, pick the app and the world, look at the template check and choose
   **Export now**.

The export goes on while the side panel is closed. **Pause** stops it; reopening DiceFox
offers to resume in the same world.

## Privacy

The extension talks only to D&D Beyond (as you, in your browser) and to the app on this
computer (`127.0.0.1`). Article texts and pictures stay in memory only until the app
confirms them. Your browser keeps names, links and the work queue — no second copy of
the content.

## License

The code: MIT — see [LICENSE](LICENSE). It gives no rights to any content you import.
D&D Beyond and Dungeons & Dragons are trademarks of Wizards of the Coast LLC.
