/* Service worker: owns the crawl.

   Everything that used to live in the runner tab runs here, so closing the tab
   no longer throws a sync away. Closing Chrome stops work; restarting it only
   restores the checkpoint until the user presses Continue. Three pieces make
   that work:

   - a dedicated, normally minimised crawl window holds a small pool of reused
     tabs, so pages are never opened in the window the user is browsing in;
   - an offscreen document parses captured catalog HTML and holds the capture
     connection open; content is sent only to AnotherWorldbuilder;
   - run state is persisted after every source, so an interrupted run resumes.

   Resume granularity is one source: discovery for the interrupted source runs
   again, but every page and detail record already in storage is skipped, so
   the repeated work is list pages, not article pages. */
"use strict";

importScripts("reader/presentation.js", "reader/model.js", "reader/references.js", "url_utils.js", "providers/registry.js", "providers/dndbeyond.js", "profile_manager.js", "core/catalog_state.js", "core/library_model.js", "core/dependency_index.js", "core/export.js", "sync/catalog.js", "sync/numeric_filters.js", "sync/documents.js", "sync/targets.js", "core/selection_catalog.js", "core/live_export.js", "mhtml_resources.js", "reader_build.js", "i18n.js", "lwl_idb.js", "storage_maintenance.js", "capture_backup.js", "site_action.js");

const ui = (en, _de) => en;
const sleep = ms => new Promise(r => setTimeout(r, ms));
/* A reader's pace: one page at a time, never quicker than PACE_MIN_MS, each
   pause a little different. The library is read the way a person would read
   it, not hammered. */
const PACE_MIN_MS = 1500, PACE_DEFAULT_MS = 2000;
const pace = () => { const base = Math.max(PACE_MIN_MS, Number(config?.delayMs) || PACE_DEFAULT_MS); return Math.round(base * (0.75 + Math.random() * 0.6)); };

const RUN_STATE_KEY = "lwl_run_state";
const CRAWL_WINDOW_KEY = "lwl_crawl_window";
const IDLE_URL = chrome.runtime.getURL("crawl_idle.html");
const MAX_LOG_LINES = 400;

let profile = null, sources = [], config = {};
let running = false, paused = false, stopRequested = false, resuming = false;
let browserStopRequested = false;
const pageMem = new Map();
const PAGE_MEMORY_LIMIT = 16;

const state = {
  running: false, paused: false, status: "idle",
  profileName: "–", source: "–", page: "–",
  count: 0, progress: 0, progressMax: 1,
  logLines: [], startedAt: null, finishedAt: null,
  completedSourceIds: [], processedSourceIds: [], currentSourceId: null,
  force: false, lastError: null, windowMode: "minimized",
  captured: 0, diskCount: 0, diskPath: null, lastWriteAt: null,
  sourceTotal: 0, activityAt: null, activeTasks: [], backupEnabled: false, runKey: null, exportId:null, profileId:null, sourceIds:[]
};

/* ---------- state broadcast ---------- */

let broadcastTimer = null, persistTimer = null;

function broadcast() {
  if (broadcastTimer) return;
  broadcastTimer = setTimeout(() => {
    broadcastTimer = null;
    chrome.runtime.sendMessage({ target: "runner", type: "STATE", state }).catch(() => {});
  }, 400);
}

function persist(immediate = false) {
  const write = () => {
    persistTimer = null;
    return chrome.storage.local.set({
      [RUN_STATE_KEY]: {
        running: state.running && !stopRequested, status: state.status, force: state.force,
        completedSourceIds: state.completedSourceIds, currentSourceId: state.currentSourceId,
        processedSourceIds: state.processedSourceIds,
        source:state.source,page:state.page,progress:state.progress,progressMax:state.progressMax,
        startedAt: state.startedAt, updatedAt: Date.now(), windowMode: state.windowMode,
        /* A failure that is only in the worker's memory is lost the moment the
           worker is torn down, which is exactly when it is needed. */
        lastError: state.lastError, logTail: state.logLines.slice(-60),
        profileName:state.profileName,sourceTotal:state.sourceTotal,captured:state.captured,
        diskCount:state.diskCount,diskPath:state.diskPath,lastWriteAt:state.lastWriteAt,
        backupEnabled:state.backupEnabled,finishedAt:state.finishedAt,runKey:state.runKey,exportId:state.exportId,profileId:state.profileId,sourceIds:state.sourceIds
      }
    }).catch(() => {});
  };
  if (immediate) { clearTimeout(persistTimer); return write(); }
  if (!persistTimer) persistTimer = setTimeout(write, 2000);
}

function log(s) {
  const line = `[${new Date().toLocaleTimeString()}] ${s}`;
  state.logLines.push(line);
  if (state.logLines.length > MAX_LOG_LINES) state.logLines.splice(0, state.logLines.length - MAX_LOG_LINES);
  broadcast();
}
function status(s) { state.status = s; broadcast(); persist(); }
function setField(key, value) { state[key] = String(value ?? "–"); broadcast(); }
function setProgress(value, max) {
  if (Number.isFinite(max)) state.progressMax = Math.max(1, max);
  if (Number.isFinite(value)) state.progress = value;
  broadcast();
}

/* Bound browser calls that can leave a renderer or snapshot queue waiting
   forever. Deadlines only wrap individual calls, never a callback that may
   still persist content after a retry has started. */
function deadline(work, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timeout (${Math.round(ms/1000)}s)`)), ms);
    Promise.resolve().then(work).then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
const activeSteps = new Map();
function taskActivity(tabId, stage, url) {
  if (stage) activeSteps.set(tabId, {stage, url, startedAt:Date.now()});
  else activeSteps.delete(tabId);
  state.activeTasks = [...activeSteps.values()];
  state.activityAt = Date.now();
  broadcast();
}

let captureBackup = null, backupFailure = null;
async function saveCapture(key, record) {
  if (!captureBackup) return;
  try { await captureBackup.save(key, record); }
  catch (error) {
    if (browserStopRequested) throw new Error("Stopped");
    backupFailure = new Error(ui("Content backup failed: ", "Inhaltssicherung fehlgeschlagen: ") + (error.message || error));
    stopRequested = true;
    throw backupFailure;
  }
}
async function beginCaptureBackup() {
  const root = `${profileFolder()}/Data/${new Date().toISOString().replace(/[:.]/g,"-")}-${crypto.randomUUID().slice(0,8)}`;
  await writeFile(`${root}/session.json`, new Blob([JSON.stringify({
    format:"lwl-capture-session", version:1, profile, startedAt:new Date().toISOString(),
    description:"Incremental content backup. Images, fonts and Reader output are stored separately."
  })], {type:"application/json"}));
  captureBackup = LWLCaptureBackup.create({root, profileId:profile.id, write:writeFile,
    onCommit:({count,path,at}) => { state.diskCount=count;state.diskPath=path;state.lastWriteAt=at;broadcast();persist(); }
  });
  state.backupEnabled = true; state.diskPath = root;
  status(ui("Backing up existing content", "Vorhandene Inhalte sichern"));
  // Recover existing browser captures before navigating even the first page.
  const keys=(await localKeys()).filter(k=>k.startsWith(`${prefix()}page:`)||k.startsWith(`${prefix()}detail:`));
  setProgress(0,Math.max(1,keys.length));let backedUp=0;
  for (let offset=0;offset<keys.length;offset+=25) {
    while(paused&&!stopRequested)await sleep(250);
    if (stopRequested) break;
    const batch=keys.slice(offset,offset+25),records=await chrome.storage.local.get(batch);
    await captureBackup.saveMany(batch.filter(key=>records[key]).map(key=>[key,records[key]]));
    backedUp+=batch.length;setProgress(backedUp);
  }
  log(`Backed up ${backedUp} existing record(s). Source synchronization follows.`);
}

/* ---------- offscreen writer ---------- */

let offscreenCreating = null;

async function ensureOffscreen({allowStopped=false}={}) {
  if (!allowStopped && stopRequested && (running || busy || pageTasksActive)) throw new Error("Stopped");
  if (running || busy) await chrome.alarms.create("lwl-heartbeat", { periodInMinutes: 0.5 });
  if (await chrome.offscreen.hasDocument()) return;
  if (!offscreenCreating) {
    offscreenCreating = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS", "DOM_PARSER"],
      justification: "Parses captured catalog HTML and keeps the capture session alive for transfer to AnotherWorldbuilder."
    }).finally(() => { offscreenCreating = null; });
  }
  try {
    await offscreenCreating;
    if (!allowStopped && stopRequested && (running || busy || pageTasksActive)) {
      await chrome.alarms.clear("lwl-heartbeat");
      await chrome.offscreen.closeDocument().catch(() => {});
      throw new Error("Stopped");
    }
  } catch (e) {
    /* A parallel createDocument won the race; that is fine. */
    if (!/single offscreen/i.test(String(e.message || e))) throw e;
  }
}

/* Requests travel down a port the offscreen document opens, not through
   runtime.sendMessage. createDocument() resolves once the document exists, but
   its script may not have installed a message listener yet - a message sent in
   that gap is answered by nobody and fails with "Receiving end does not exist".
   A port cannot exist before the script runs, so waiting for it removes the
   race instead of papering over it with a delay. */
let offscreenPort = null;
const offscreenPortWaiters = [];
const offscreenRequests = new Map();
let offscreenRequestSeq = 0;

function settleOffscreenPort(port) {
  offscreenPort = port;
  const waiters = offscreenPortWaiters.splice(0);
  for (const w of waiters) w();
}

function failAllOffscreenRequests(reason) {
  for (const [id, req] of [...offscreenRequests]) {
    offscreenRequests.delete(id);
    req.reject(new Error(reason));
  }
}

async function waitForOffscreenPort(timeoutMs = 8000) {
  if (offscreenPort) return offscreenPort;
  return await new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); resolve(offscreenPort); };
    const timer = setTimeout(() => {
      const i = offscreenPortWaiters.indexOf(done);
      if (i >= 0) offscreenPortWaiters.splice(i, 1);
      reject(new Error("The background writer did not report ready"));
    }, timeoutMs);
    offscreenPortWaiters.push(done);
  });
}

async function askOffscreen(message, { retry = true } = {}) {
  await ensureOffscreen({allowStopped:/^AW_LIVE_(CANCEL|DROP)$/.test(message.type)});
  if (!/^AW_LIVE_(CANCEL|DROP)$/.test(message.type) && stopRequested && (running || busy || pageTasksActive)) throw new Error("Stopped");
  let port;
  try {
    port = await waitForOffscreenPort();
  } catch (e) {
    if (!/^AW_LIVE_(CANCEL|DROP)$/.test(message.type) && stopRequested && (running || busy || pageTasksActive)) throw new Error("Stopped");
    if (!retry) throw e;
    /* A document that exists but never connected is unusable; replace it. */
    await chrome.offscreen.closeDocument().catch(() => {});
    offscreenPort = null;
    return await askOffscreen(message, { retry: false });
  }
  if (!/^AW_LIVE_(CANCEL|DROP)$/.test(message.type) && stopRequested && (running || busy || pageTasksActive)) throw new Error("Stopped");
  const reqId = ++offscreenRequestSeq;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      offscreenRequests.delete(reqId);
      reject(new Error(`The background writer did not answer (${message.type})`));
    }, message.type.startsWith("AW_LIVE_") ? 12*60*1000 : 180000);
    offscreenRequests.set(reqId, {
      resolve: v => { clearTimeout(timer); resolve(v); },
      reject: e => { clearTimeout(timer); reject(e); }
    });
    try {
      port.postMessage({ reqId, ...message });
    } catch (e) {
      offscreenRequests.delete(reqId);
      clearTimeout(timer);
      reject(new Error(`Could not reach the background writer: ${e.message || e}`));
    }
  });
}

/* Explicit backstop for any legacy code path that still asks to write a file. */
async function writeFile(path, blob) {
  throw new Error(ui("Content is sent only to AnotherWorldbuilder. File output is retired.", "Inhalte werden ausschließlich an AnotherWorldbuilder gesendet. Die Dateiausgabe ist eingestellt."));
}

async function flushPendingWrites() {
  const pending = await LWLIdb.pendingWrites().catch(() => []);
  if (!pending.length) return;
  log(`Flushing ${pending.length} unfinished file write(s) from the previous run.`);
  const res = await askOffscreen({ type: "FS_FLUSH" }).catch(e => ({ ok: false, error: String(e.message || e) }));
  if (res?.failed?.length) for (const f of res.failed.slice(0, 10)) log(`Write failed: ${f.path}: ${f.error}`);
  if (!res?.ok) throw new Error(res?.error || "Unfinished file writes could not be completed. Reconnect the folder or discard them in Storage & files.");
}

async function storeStatus() {
  return await askOffscreen({ type: "FS_STATUS" }).catch(e => ({ ok: false, reason: "unavailable", error: String(e.message || e) }));
}

/* ---------- crawl window and tab pool ---------- */

/* Recycle long-lived site renderers regularly. A failed tab is always closed,
   including on the last retry; it must never re-enter the idle pool. */
const TAB_MAX_NAVIGATIONS = 5;
const TASK_ATTEMPTS = 3;

/* keeperTabId is the window's own tab. It is never handed out and never
   recycled, because a window whose last tab is closed is closed by Chrome -
   which is exactly what happened at page 43: recycling took the last tab, the
   window died, and every later tab landed in the user's window instead. */
const crawl = { windowId: null, keeperTabId: null, tabs: new Set(), idle: [], waiters: [], navCount: new Map() };

function windowMode() { return config.windowMode === "visible" ? "visible" : "minimized"; }
function tabLimit() { return 1; }

function resetCrawlWindow() {
  crawl.windowId = null;
  crawl.keeperTabId = null;
  crawl.tabs.clear();
  crawl.navCount.clear();
  crawl.idle.length = 0;
  const waiters = crawl.waiters.splice(0);
  for (const w of waiters) w();
}

async function ensureCrawlWindow() {
  await requireBrowserWindow();
  if (crawl.windowId != null) {
    const win = await chrome.windows.get(crawl.windowId).catch(() => null);
    if (stopRequested) throw new Error("Stopped");
    if (win) return crawl.windowId;
    await stopForBrowserClose("Crawl window was closed. Press Continue to resume.");
    throw new Error("Stopped");
  }
  /* type "normal", not "popup": a popup window holds exactly one tab, so every
     further tab of the pool would silently be placed in the user's own window.
     Desktop-sized on purpose - the extraction selectors were written against a
     desktop layout, and a narrow window would yield mobile markup. */
  let win;
  try {
    win = await chrome.windows.create({ type: "normal", url: IDLE_URL, focused: false, width: 1280, height: 1024 });
  } catch (error) {
    if (!/bounds|visible screen/i.test(String(error.message || error))) throw error;
    // A disconnected display can leave Chrome's remembered placement outside
    // the desktop. Let Chrome choose valid bounds instead of failing every item.
    await requireBrowserWindow();
    win = await chrome.windows.create({ type: "normal", url: IDLE_URL, focused: false });
  }
  if (typeof win?.id !== "number") throw new Error("Chrome did not return a crawl window");
  crawl.windowId = win.id;
  crawl.keeperTabId = (win.tabs || [])[0]?.id ?? null;   /* holds the window open; not part of the pool */
  // The last user window may have closed while create() was pending.
  if (stopRequested) { await closeCrawlWindow(); throw new Error("Stopped"); }
  await requireBrowserWindow();
  state.windowMode = windowMode();
  if (windowMode() === "minimized") await chrome.windows.update(win.id, { state: "minimized" }).catch(() => {});
  await chrome.storage.local.set({ [CRAWL_WINDOW_KEY]: win.id });
  log(`Crawl window ${win.id} opened (${windowMode()}), pool limit ${tabLimit()} tab(s).`);
  return crawl.windowId;
}

/* Adding a tab can restore a minimised window; put it back. */
async function reassertWindowMode() {
  if (crawl.windowId == null || windowMode() !== "minimized") return;
  const win = await chrome.windows.get(crawl.windowId).catch(() => null);
  if (win && win.state !== "minimized") await chrome.windows.update(crawl.windowId, { state: "minimized" }).catch(() => {});
}

async function closeCrawlWindow() {
  const id = crawl.windowId;
  resetCrawlWindow();
  await chrome.storage.local.remove(CRAWL_WINDOW_KEY).catch(() => {});
  if (id != null) await chrome.windows.remove(id).catch(() => {});
}

async function closeOrphanCrawlWindow() {
  // Window IDs are session-local and may be reused after a browser restart.
  // Identify restored crawler windows by their dedicated keeper page instead.
  const windows = await chrome.windows.getAll({populate:true,windowTypes:["normal"]});
  for (const win of windows) {
    if (win.tabs?.some(tab => tab.url === IDLE_URL || tab.pendingUrl === IDLE_URL)) {
      await chrome.windows.remove(win.id).catch(() => {});
    }
  }
  await chrome.storage.local.remove(CRAWL_WINDOW_KEY).catch(() => {});
}

async function hasBrowserWindow() {
  const windows = await chrome.windows.getAll({windowTypes:["normal"]});
  return windows.some(win => win.id !== crawl.windowId);
}

async function stopForBrowserClose(message) {
  browserStopRequested = true;
  if (!stopRequested) {
    stopRequested = true;
    paused = false; state.paused = false;
    status("stopped");
    log(message);
  }
  // Persist before closing our last window, which may let Chrome exit.
  await persist(true);
  await chrome.alarms.clear("lwl-heartbeat");
  // Cancel background HTML requests and leave unfinished disk writes queued.
  // They are only flushed by the next explicit run.
  failAllOffscreenRequests("Stopped");
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument().catch(() => {});
  await closeCrawlWindow();
}

async function requireBrowserWindow() {
  if (stopRequested) throw new Error("Stopped");
  if (!await hasBrowserWindow()) {
    await stopForBrowserClose("Browser closed. Progress saved; press Continue to resume.");
  }
  if (stopRequested) throw new Error("Stopped");
}

async function tabAlive(id) { return Boolean(await chrome.tabs.get(id).catch(() => null)); }

async function editBrowserTabs(work){
  for(let attempt=0;;attempt++){
    if(stopRequested)throw Error("Stopped");
    try{return await work();}
    catch(error){
      if(attempt>=4||!/Tabs cannot be edited right now/i.test(String(error.message||error)))throw error;
      if(!attempt)log("Chrome is temporarily busy moving tabs; retrying the current page.");
      await sleep(500*(attempt+1));
    }
  }
}

let acquiringTab = Promise.resolve();
function acquireTab() {
 const next=acquiringTab.then(acquireTabSlot);acquiringTab=next.catch(()=>{});return next;
}
async function acquireTabSlot() {
  while (true) {
    if (stopRequested) throw new Error("Stopped");
    while (crawl.idle.length) {
      const id = crawl.idle.pop();
      if (await tabAlive(id)) return id;
      crawl.tabs.delete(id);
    }
    if (crawl.tabs.size < tabLimit()) {
      const windowId = await ensureCrawlWindow();
      let tab = await editBrowserTabs(()=>chrome.tabs.create({ windowId, url: IDLE_URL, active: false }));
      /* Chrome can place a new tab somewhere else than asked. Never leave one
         behind in the window the user is browsing in. */
      if (tab.windowId !== windowId) {
        log(`Chrome placed a crawl tab in window ${tab.windowId} instead of ${windowId}; moving it.`);
        const moved = await editBrowserTabs(()=>chrome.tabs.move(tab.id, { windowId, index: -1 })).catch(() => null);
        if (moved) tab = Array.isArray(moved) ? moved[0] : moved;
        else { await chrome.tabs.remove(tab.id).catch(() => {}); throw new Error("Chrome refused to open the page in the crawl window"); }
      }
      crawl.tabs.add(tab.id);
      await reassertWindowMode();
      return tab.id;
    }
    await new Promise(resolve => crawl.waiters.push(resolve));
  }
}

function wakeOneWaiter() {
  const waiter = crawl.waiters.shift();
  if (waiter) waiter();
}

/* Drops a tab from the pool and closes it; the freed slot lets a waiter create
   a fresh one. Used for worn-out tabs and for tabs that failed to navigate. */
async function retireTab(id) {
  if (id === crawl.keeperTabId) return;    /* closing it would close the window */
  crawl.tabs.delete(id);
  crawl.navCount.delete(id);
  const i = crawl.idle.indexOf(id);
  if (i >= 0) crawl.idle.splice(i, 1);
  await chrome.tabs.remove(id).catch(() => {});
  wakeOneWaiter();
}

function releaseTab(id) {
  if (!crawl.tabs.has(id)) return;
  if ((crawl.navCount.get(id) || 0) >= TAB_MAX_NAVIGATIONS) {
    log(`Recycling a crawl tab after ${TAB_MAX_NAVIGATIONS} page loads.`);
    retireTab(id);
    return;
  }
  crawl.idle.push(id);
  wakeOneWaiter();
}

chrome.tabs.onRemoved.addListener(tabId => {
  crawl.navCount.delete(tabId);
  if (tabId === crawl.keeperTabId) crawl.keeperTabId = null;
  if (!crawl.tabs.delete(tabId)) return;
  const i = crawl.idle.indexOf(tabId);
  if (i >= 0) crawl.idle.splice(i, 1);
  wakeOneWaiter();
});

chrome.windows.onRemoved.addListener(async windowId => {
  try {
    if (windowId === crawl.windowId) {
      resetCrawlWindow();
      await stopForBrowserClose("Crawl window was closed. Press Continue to resume.");
    } else if ((running || busy || pageTasksActive || pageCommandsActive) && !await hasBrowserWindow()) {
      await stopForBrowserClose("Browser closed. Progress saved; press Continue to resume.");
    }
  } catch (error) { log(`Could not finish stopping the crawler: ${error.message || error}`); }
});

/* Only resolves on a load that finished after this listener was attached, so a
   tab still showing the previous page is never mistaken for a finished load. */
async function navigateTab(tabId, url, timeout = 45000) {
  const current = await deadline(()=>chrome.tabs.get(tabId),10000,"Inspect page").catch(() => null);
  if (current?.url === url) await deadline(()=>editBrowserTabs(()=>chrome.tabs.update(tabId, { url: IDLE_URL })),10000,"Reset page");
  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error(`Page load timeout: ${url}`)), timeout);
    /* A freshly created pool tab is still loading the idle page. Its "complete"
       arrives after this listener is attached and would otherwise be taken for
       the navigation we just asked for - which is how a stylesheet capture ended
       up reading crawl_idle.html. The idle page is therefore never a valid
       completion here. */
    const onUpdated = (id, info, tab) => {
      if (id !== tabId || info.status !== "complete") return;
      if (tab?.url === IDLE_URL) return;
      crawl.navCount.set(tabId, (crawl.navCount.get(tabId) || 0) + 1);
      finish(resolve, tab);
    };
    const onRemoved = id => { if (id === tabId) finish(reject, new Error("Crawl tab was closed")); };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
    editBrowserTabs(()=>chrome.tabs.update(tabId, { url }))
      .then(async () => {
        /* Covers the other end of the race: a page that finished loading
           between attaching the listener and this point. */
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab?.status === "complete" && tab.url && tab.url !== IDLE_URL) finish(resolve, tab);
      })
      .catch(e => finish(reject, e));
  });
}

async function ensureInjected(tabId) {
  await deadline(()=>chrome.scripting.executeScript({ target: { tabId }, files: ["reader/presentation.js", "content.js"] }),15000,"Prepare page extraction");
}

/* One page, opened in the crawl window and handed back.

   The profile editor's pagination scan used to create and rotate its own tabs
   in the user's window. It now borrows this instead, so detection and sync open
   pages in exactly one place. It deliberately does not require a saved run
   profile: during detection there may not be one yet, so the origin to enforce
   is passed in. */
let pageTasksActive = 0;

async function pageTask({ url, message, origin = null, settleMs = 450, timeoutMs = 45000, attempt = 1 }) {
  pageTasksActive++;
  try {
    await ensureOffscreen();
    const tabId = await acquireTab();
    let retired = false;
    try {
      taskActivity(tabId,"loading",url);
      await navigateTab(tabId, url, timeoutMs);
      await sleep(Math.max(0, settleMs));
      const tab = await deadline(()=>chrome.tabs.get(tabId),10000,"Inspect loaded page");
      const finalUrl = tab?.url || url;
      if (origin && !finalUrl.startsWith(origin)) {
        return { ok: false, offOrigin: true, error: `Left the profile origin: ${finalUrl}`, finalUrl };
      }
      await ensureInjected(tabId);
      taskActivity(tabId,"extracting",url);
      const result = await deadline(()=>chrome.tabs.sendMessage(tabId, message),60000,"Read page content");
      return { ok: true, result, finalUrl, tabTitle: tab?.title || null, tabStatus: tab?.status || null };
    } catch (e) {
      retired = true;
      await retireTab(tabId);
      if (attempt < TASK_ATTEMPTS && !stopRequested) {
        await sleep(2000 * attempt);
        return await pageTask({ url, message, origin, settleMs, timeoutMs, attempt: attempt + 1 });
      }
      throw e;
    } finally {
      taskActivity(tabId,null);
      if (!retired) releaseTab(tabId);
    }
  } finally {
    pageTasksActive--;
  }
}

/* Where a page ended up that is not to be read: the answer for it, or null. */
function pageRefusal(finalUrl, message) {
  if (!LWLUrl.sameOrigin(finalUrl, profile)) return { ok: false, unavailable: true, error: `Redirect outside profile origin: ${finalUrl}`, finalUrl };
  if (shouldSkipUrl(finalUrl)) return { ok: false, unavailable: true, error: `Skipped by profile rule: ${finalUrl}`, finalUrl };
  if (message?.source && !LWLProviders.allows(profile, message.source, finalUrl)) return { ok: false, unavailable: true, error: 'Redirect outside supported export scope: ' + finalUrl, finalUrl };
  return null;
}
async function openTask(url, message, callback = null, attempt = 1) {
  while(paused&&!stopRequested)await sleep(250);
  if(stopRequested)throw new Error("Stopped");
  if(message?.source&&!LWLProviders.allows(profile,message.source,url))throw Error('Page outside supported export scope: '+url);
  const tabId = await acquireTab();
  let retired = false;
  try {
    taskActivity(tabId,"loading",url);
    await navigateTab(tabId, url);
    await sleep(pace());
    const final = await deadline(()=>chrome.tabs.get(tabId),10000,"Inspect loaded page");
    const finalUrl = final.url || url;
    const refused = pageRefusal(finalUrl, message);
    if (refused) return refused;
    await ensureInjected(tabId);
    taskActivity(tabId,"extracting",url);
    let result = await deadline(()=>chrome.tabs.sendMessage(tabId, message),60000,"Read page content");
    taskActivity(tabId,"saving",url);
    if (callback) result = await callback({ id: tabId }, result, finalUrl);
    return result;
  } catch (e) {
    /* A tab that failed here is suspect - a stalled renderer stops firing load
       events for every later page too. Replace it rather than reuse it. */
    retired = true;
    await retireTab(tabId);
    if (attempt < TASK_ATTEMPTS && !stopRequested) {
      log(`${e.message || e} - retrying in a fresh tab (attempt ${attempt + 1}/${TASK_ATTEMPTS}).`);
      await sleep(2000 * attempt);
      return await openTask(url, message, callback, attempt + 1);
    }
    throw e;
  } finally {
    taskActivity(tabId,null);
    if (!retired) releaseTab(tabId);
  }
}

/* ---------- library paths ----------
   The chosen folder is the root; nothing is prefixed with a fixed directory
   name any more, because the user already decided where this lives. */

function readerRoot() { return `${profileFolder()}/Reader`; }
function exportRoot() { return `${profileFolder()}/Exports`; }

async function downloadBlob(blob, filename) {
  const path = `${exportRoot()}/${filename}`;
  await writeFile(path, blob);
  log(`Export written: ${path}`);
  return path;
}

/* ---------- crawl engine (moved out of the runner tab unchanged) ---------- */

function safeId(text){let h=0x811c9dc5;for(const ch of String(text||"")){h^=ch.charCodeAt(0);h=Math.imul(h,0x01000193);}return(h>>>0).toString(16).padStart(8,"0");}
function safePart(v,f="item"){let s=String(v||f).normalize("NFKC").replace(/[<>:"/\\|?*\x00-\x1F]/g,"-").replace(/[. ]+$/g,"").replace(/\s+/g," ").trim()||f;return s.slice(0,80);}
function prefix(){return `lwl:${profile.id}:`;}
function pageKey(url){return `${prefix()}page:${safeId(LWLUrl.canonicalUrl(url,profile)||url)}`;}
function sourceKey(id){return `${prefix()}source:${id}`;}
function metaKey(){return `${prefix()}meta`;}
function manifestKey(){return `${prefix()}manifest`;}
function dependencyKey(){return `${prefix()}dependencies`;}
function glossaryKey(){return `${prefix()}glossary`;}
function detailKey(url){return `${prefix()}detail:${safeId(LWLUrl.canonicalUrl(url,profile)||url)}`;}
function previewKey(url){return `${prefix()}preview:${safeId(LWLUrl.canonicalUrl(url,profile)||url)}`;}
function stylesKey(sourceId){return `${prefix()}styles:${sourceId}`;}
function profileFolder(){return safePart(profile.name||profile.id,"site");}
function hashText(s){let h=0x811c9dc5;for(const ch of String(s||"")){h^=ch.charCodeAt(0);h=Math.imul(h,0x01000193);}return(h>>>0).toString(16).padStart(8,"0");}
function stableJson(value){return JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0)):item);}
function canonical(url){return LWLUrl.canonicalUrl(url,profile)||url;}
function canonicalWithHash(url){
 try{const u=new URL(url,profile?.origin||undefined),hash=u.hash||"";const base=canonical(u.href);return base?`${base}${hash}`:u.href;}
 catch{return canonical(url);}
}
function shouldSkipUrl(url){return LWLUrl.matchesAny(url,profile.skipUrlPatterns)||LWLUrl.matchesAny(url,profile.unavailableUrlPatterns)||(profile.provider&&!LWLProviders.sourceFor(profile,url));}
// Enumerating keys and sizes must never deserialize the entire captured library.
async function localKeys() { return chrome.storage.local.getKeys(); }
async function readLocal(keys) {
 const result={};
 for(let i=0;i<keys.length;i+=16)Object.assign(result,await chrome.storage.local.get(keys.slice(i,i+16)));
 return result;
}
function rememberPage(url,record) {
 pageMem.delete(url);pageMem.set(url,record);
 while(pageMem.size>PAGE_MEMORY_LIMIT || [...pageMem.values()].reduce((n,p)=>n+(p.html?.length||0)+(p.markdown?.length||0),0)>4*1024*1024)pageMem.delete(pageMem.keys().next().value);
}
async function getPage(url){const u=canonical(url);if(pageMem.has(u)){const rec=pageMem.get(u);rememberPage(u,rec);return rec;}const st=await chrome.storage.local.get(pageKey(u));const rec=st[pageKey(u)]||null;if(rec)rememberPage(u,rec);return rec;}
async function putPage(rec){const u=canonical(rec.url);rec.url=u;rec.id=safeId(u);await chrome.storage.local.set({[pageKey(u)]:rec});rememberPage(u,rec);await saveCapture(pageKey(u),rec);}
async function allPages(){return Object.values(await readLocal((await localKeys()).filter(k=>k.startsWith(`${prefix()}page:`)))).filter(Boolean);}
async function readerData({captureStyles=true}={}){
 const keys=(await localKeys()).filter(k=>k.startsWith(prefix()));
 const all=await readLocal(keys.filter(k=>/^(page|detail|preview|source):/.test(k.slice(prefix().length))));
 const styles=new Set((profile.sources||[]).map(src=>stylesKey(src.id)));
 if(captureStyles)for(const record of Object.values(all))if(record?.styleId)styles.add(stylesKey(`capture-${record.styleId}`));
 Object.assign(all,await readLocal([...styles]));return all;
}
async function countPages(){
 if(!profile)return 0;
 const keys=await localKeys();
 const sourceKeys=(profile.sources||[]).filter(src=>src.type==="catalog").map(src=>sourceKey(src.id));
 const catalogs=await readLocal(sourceKeys);
 const total=keys.filter(k=>k.startsWith(`${prefix()}page:`)).length+Object.values(catalogs).reduce((n,m)=>n+(m?.items?.length||0),0);
 state.count=total;
 state.captured=keys.filter(k=>k.startsWith(`${prefix()}page:`)||k.startsWith(`${prefix()}detail:`)).length;
 broadcast();return total;
}
let presentationQueue = Promise.resolve();
function storePresentation(captured,tabId) {
 const task=presentationQueue.then(()=>capturePresentation(captured,tabId));
 presentationQueue=task.catch(()=>{});return task;
}
async function capturePresentation(captured,tabId) {
 const styles=captured.styles;
 // Chrome's snapshot is only an in-memory transport for loaded CSS, images and
 // fonts. Never write it to the library; only extracted resources enter the cache.
 if(tabId && config.assets!==false){
  try{
   const snapshot=await deadline(()=>chrome.pageCapture.saveAsMHTML({tabId}),30000,"Capture page resources");
   const pendingUrls=new Set((styles?.pending||[]).map(item=>item.url)),byUrl=new Map();
   const resourceDeadline=Date.now()+60000;
   await LWLMhtmlResources.forEach(snapshot,async resource=>{
    await LWLIdb.putResource(profile.id,resource.url,resource.blob);
    if(pendingUrls.has(resource.url))byUrl.set(resource.url,resource);
   },{maxResourceBytes:Number(config.maxAssetBytes)||6*1024*1024,stopped:()=>Date.now()>resourceDeadline});
   for(const pending of styles?.pending||[]){
    const resource=byUrl.get(pending.url);
    if(resource){
     let css=await resource.blob.text();
     css=css.replace(/url\(\s*(['"]?)([^'"\)]+)\1\s*\)/gi,(all,q,raw)=>/^(data:|#)/i.test(raw)?all:`url("${new URL(raw,pending.url).href}")`);
     css=css.replace(/@import\s+(['"])([^'"]+)\1/gi,(all,q,url)=>`@import "${new URL(url,pending.url).href}"`);
     styles.css=styles.css.replace(pending.marker,css);
    }else styles.warnings.push(`Stylesheet unavailable: ${pending.url}`);
   }
  }catch(error){styles?.warnings?.push(`Loaded resource capture failed: ${error.message||error}`);}
 }
 if(styles?.pending)for(const pending of styles.pending)if(styles.css.includes(pending.marker)){
  styles.css=styles.css.replace(pending.marker,"");
  const warning=`Stylesheet unavailable: ${pending.url}`;if(!styles.warnings.includes(warning))styles.warnings.push(warning);
 }
 if(!styles?.css){for(const warning of styles?.warnings||[])log(warning);return null;}
 const id=safeId(styles.css),key=stylesKey(`capture-${id}`);
 await chrome.storage.local.set({[key]:{...styles,capturedAt:new Date().toISOString()}});
 for(const warning of styles.warnings||[])log(warning);
 return id;
}
function captureRules(source){return JSON.stringify([source.detailSelector||null,source.detailTitleSelector||null,source.excludeSelectors||[],source.detailExcludeSelectors||[],source.keepPattern||null,source.providerId||null,source.previewSelector||null,source.glossary||null]);}
function capturedSource(source) { return {...source, pageSelector:source.detailPageSelector||source.pageSelector, captureVersion:5,captureRules:captureRules(source)}; }
function reusableCapture(record,source) {
 if(record&&!LWLProviders.allows(profile,source,record.url))return false;
 if(source.type==='collection'&&record?.contentBoundaryVersion!==2)return false;
 if((record?.captureRules||source.detailSelector||source.detailTitleSelector||source.detailExcludeSelectors?.length)&&record?.captureRules!==captureRules(source))return false;
 return Boolean(record?.html && !record.resourceCapturePending && record.captureVersion>=5 && (record.presentation?.mode||"article")===(source.captureMode||"article") && (source.captureMode!=="page"||(record.presentation?.pageSelector||null)===(source.detailPageSelector||source.pageSelector||null)));
}
function reuseDuringSync(record,source,force) {
 return reusableCapture(record,source) && ((!force && config.syncMode!=="verify_all") ||
  (resuming && Date.parse(record.updatedAt)>=Date.parse(state.startedAt)));
}
async function syncPage(source,url,context={},force=false){
 while(paused&&!stopRequested)await sleep(250);
 if(stopRequested)return null;
 const c=canonical(url);
 if(!c||!LWLUrl.sameOrigin(c,profile)||shouldSkipUrl(c)||!LWLProviders.allows(profile,source,c))return null;
 const existing=await getPage(c);
 if(reuseDuringSync(existing,source,force)){
  existing.sourceIds=[...new Set([existing.sourceId,...(existing.sourceIds||[]),source.id])];
  existing.contexts={...(existing.contexts||{}),[source.id]:{sourceId:source.id,sourceName:source.name,sourceType:source.type,...context}};
  await putPage(existing);return existing;
 }
 setField("source",source.name);setField("page",context.title||LWLUrl.slugFromUrl(c,c));
 return await openTask(c,{type:"EXTRACT_PAGE",source:capturedSource(source)},async(tab,res,finalUrl)=>{
  if(!res?.ok)throw new Error(res?.error||`Extraction failed: ${c}`);
  const p=res.page||{},finalCanonical=canonical(finalUrl),contentHash=hashText(p.markdown||"");
  if(!p.html?.trim())throw new Error(`Empty page extraction: ${c}`);
  const changed=!existing||existing.contentHash!==contentHash;
  const rec={...(existing||{}),id:safeId(finalCanonical),sourceId:source.id,sourceName:source.name,sourceType:source.type,
   collectionId:context.collectionId||existing?.collectionId||null,collectionTitle:context.collectionTitle||existing?.collectionTitle||null,collectionCover:context.collectionCover||existing?.collectionCover||null,
   title:p.title||context.title||existing?.title||finalCanonical,url:finalCanonical,requestedUrl:c,
   markdown:p.markdown||"",html:p.html||"",detailMeta:p.meta||{},
   navIndex:Number.isFinite(context.navIndex)?context.navIndex:(existing?.navIndex??null),
   headings:p.headings||[],links:(p.links||[]).map(x=>({...x,url:canonicalWithHash(x.url)})).filter(x=>x.url),
   characterCount:p.characterCount||0,contentHash,updatedAt:new Date().toISOString(),changed,glossaryEntries:res.glossary?.length?res.glossary:(existing?.glossaryEntries||[]),
   sourceIds:[...new Set([existing?.sourceId,...(existing?.sourceIds||[]),source.id].filter(Boolean))],contexts:{...(existing?.sourceId?{[existing.sourceId]:{sourceId:existing.sourceId,sourceName:existing.sourceName,sourceType:existing.sourceType,collectionId:existing.collectionId,collectionTitle:existing.collectionTitle,navIndex:existing.navIndex}}:{}),...(existing?.contexts||{}),[source.id]:{sourceId:source.id,sourceName:source.name,sourceType:source.type,...context}},
   captureVersion:p.captureVersion,contentBoundaryVersion:p.contentBoundaryVersion,captureRules:p.captureRules,presentation:p.presentation,styleId:null,theme:p.theme,resourceCapturePending:true,
   captureWarnings:[...(p.styles?.warnings||[]),"Resource capture is unfinished. Resume synchronization to capture page styling and media."]};
  delete rec.offline;
  delete rec.offlineError;
  // Content is durable even if the subsequent resource snapshot stalls.
  await putPage(rec);await countPages();
  rec.styleId=await storePresentation(p,tab.id);
  rec.resourceCapturePending=false;
  rec.captureWarnings=p.styles?.warnings||[];
  await putPage(rec);return rec;
 });
}
async function pool(items,limit,worker){let i=0;const out=[];async function one(){while(true){if(stopRequested)return;const idx=i++;if(idx>=items.length)return;try{out[idx]=await worker(items[idx],idx);}catch(e){out[idx]=null;if(!stopRequested)log(`ERROR: ${e.message||e}`);}}}await Promise.all(Array.from({length:Math.min(limit,items.length||1)},one));return out;}
function pageUrlFor(source,pageNo){try{const u=new URL(source.startUrl),param=source.pagination?.pageParam;if(param){if(pageNo<=1)u.searchParams.delete(param);else u.searchParams.set(param,String(pageNo));return u.href;}}catch{}return source.startUrl;}
async function autoConfigureSource(source){
  const res=await openTask(source.startUrl,{type:"DETECT_PAGE_STRUCTURE"}).catch(e=>({ok:false,error:String(e.message||e)}));
  if(!res?.ok)return source;
  const suggestions=(res.suggestions||[]).filter(x=>["collection","catalog","glossary","section"].includes(x.kind));
  const sameType=suggestions.filter(x=>x.kind===source.type);
  const pool=sameType;
  const best=pool.sort((a,b)=>(b.confidence||0)-(a.confidence||0)||(b.itemCount||0)-(a.itemCount||0))[0];
  if(!best)return source;
  const effective={...source,type:best.kind,contentSelector:source.contentSelector||res.contentSelector||"main, article, [role='main'], body"};
  if(!source.itemUrlPatterns?.length&&best.itemUrlPatterns?.length){effective.itemUrlPatterns=best.itemUrlPatterns;if(best.kind==="catalog"||best.kind==="collection")effective.discoveryMode="configured";}
  if(best.metrics?.structuralContainerSelector)effective.itemContainerSelector=best.metrics.structuralContainerSelector;
  if(!source.catalogView&&best.catalogView){effective.catalogView=best.catalogView;effective.pageSelector=source.pageSelector||best.pageSelector;}
  if(!source.navigationSelector&&best.navigationSelector)effective.navigationSelector=best.navigationSelector;
  if(!source.pageUrlPatterns?.length&&best.pageUrlPatterns?.length)effective.pageUrlPatterns=best.pageUrlPatterns;
  if(best.kind==="glossary"&&(best.termSelector||best.definitionSelector))effective.glossary={termSelector:best.termSelector||"dt",definitionSelector:best.definitionSelector||"dd"};
  if(res.pagination?.detected){const detectedLast=Number(res.pagination.lastPage||0),existingMax=Number(source.pagination?.maxPages||0);effective.pagination={mode:"auto",selector:res.pagination.selector||null,pageParam:res.pagination.pageParam||source.pagination?.pageParam||null};const maxPages=Math.max(Number.isFinite(existingMax)?existingMax:0,Number.isFinite(detectedLast)?detectedLast:0);if(maxPages>0)effective.pagination.maxPages=maxPages;}
  log(`Auto-detected ${source.name} as ${effective.type} (${Math.round((best.confidence||0)*100)}%).`);
  return effective;
}
function targetedSource(source){return Boolean(config.targets?.length)&&!(config.wholeSourceIds||[]).includes(source.id);}
async function syncSource(source,force=false){if(targetedSource(source))return syncTargets(source,force);const effective=source.discoveryMode==="auto"?await autoConfigureSource(source):source;if(effective.type==="collection")return syncCollection(effective,force);if(effective.type==="catalog")return syncCatalog(effective,force);if(effective.type==="glossary")return syncGlossary(effective,force);return syncSection(effective,force);}
function belongsToSource(url,source){const c=canonical(url);if(!c)return false;if(source.itemUrlPatterns?.length&&LWLUrl.matchesAny(c,source.itemUrlPatterns))return true;if(source.pageUrlPatterns?.length&&LWLUrl.matchesAny(c,source.pageUrlPatterns))return true;if(source.type==="section"){try{const a=new URL(c),b=new URL(source.startUrl);return a.origin===b.origin&&a.pathname.startsWith(b.pathname.replace(/[^/]*$/,""));}catch{}}return false;}
/* Catalog content mode: walk the list pages for item URLs, then read every
   item's own page and keep its sanitized article for local reader navigation. */
/* ---------- reader v4 output ---------- */

async function buildReader({checkpoint=false}={}){
 const {records,readerSources}=await collectReaderModel(null,{lazyStyles:true});
 if(!records.length){log("Nothing to build: no local records yet.");return null;}
 const root=readerRoot();
 const begin=await askOffscreen({type:"FS_READER_BEGIN",root,profileId:profile.id});
 if(!begin?.ok)throw new Error(begin?.error||"Could not check the reader file inventory");
 const files=new Map();let writeFailed=false;
 const catalogStylesPath=LWLProviders.forProfile(profile)?.catalogStylesPath;
 let catalogCss='';
 if(catalogStylesPath){
  const response=await fetch(chrome.runtime.getURL(catalogStylesPath));
  if(!response.ok)throw new Error('Bundled catalog styling unavailable');
  catalogCss=await response.text();
 }
 const ctx={
  root,profile,catalogCss,
  assetsEnabled:config.assets!==false,
  assetParallelism:3,
  maxAssets:Number(config.maxAssets)>0?Number(config.maxAssets):Number.MAX_SAFE_INTEGER,
  maxAssetBytes:Number(config.maxAssetBytes)||6*1024*1024,
  canonical,hash:safeId,log,status,
  getResource:url=>LWLIdb.getResource(profile.id,url),
  loadStyle:async id=>{const key=stylesKey(`capture-${id}`);return (await chrome.storage.local.get(key))[key]?.css||null;},
  cacheResource:(url,blob)=>LWLIdb.putResource(profile.id,url,blob),
  stopped:()=>stopRequested,
  download:async(blob,name)=>{
   try{
    await writeFile(name,blob);
    const sha256=[...new Uint8Array(await crypto.subtle.digest("SHA-256",await blob.arrayBuffer()))].map(n=>n.toString(16).padStart(2,"0")).join("");
    files.set(name,{path:name.slice(root.length+1),bytes:blob.size,sha256});
   }catch(error){writeFailed=true;throw error;}
  }
 };
 const stats=await LWLReaderBuild.build(records,readerSources,ctx);
 records.length=0;readerSources.length=0;
 if(writeFailed)throw new Error("Reader output was incomplete. Previous file inventory and cached resources were retained.");
 if(!stopRequested){
  const registered=await askOffscreen({type:'FS_LIBRARY_REGISTER',root,profile:{id:profile.id,name:profile.name}});
  if(!registered?.ok)throw Error(registered?.error||'Could not update library navigation');
 }
 if(!stopRequested && stats.complete){
  const clean=await askOffscreen({type:"FS_READER_COMMIT",root,profileId:profile.id,files:[...files.values()],autoCleanup:!checkpoint&&config.autoCleanup!==false});
  if(!clean?.ok)throw new Error(clean?.error||"Could not save the completed reader file inventory");
  await chrome.storage.local.set({[`${prefix()}reader-output`]:{root,bytes:[...files.values()].reduce((n,f)=>n+f.bytes,0),files:files.size,builtAt:new Date().toISOString()}});
  if(clean.removed)log(`Removed ${clean.removed} obsolete reader file(s), ${clean.bytes} bytes.`);
  if(!checkpoint&&config.autoCleanup!==false)await pruneStoredCache(profile.id).catch(error=>log(`Cache cleanup skipped: ${error.message}`));
 }else log("Reader resources are incomplete or the build was stopped; automatic cleanup was skipped.");
 log(`Reader built: ${stats.entryCount} entr(ies), ${stats.withContent} with content, ${stats.chunkCount} chunk(s), ${stats.assetCount} asset(s), ${stats.termCount} search term(s).`);
 log(`Open ${root}/index.html inside the library folder.`);
 return stats;
}

/* ---------- run control ---------- */
let busy = false;

/* Page tasks need configuration even when no profile has been selected yet. */
async function loadConfigOnly() {
  const st = await chrome.storage.local.get("lwl_run_config");
  config = st.lwl_run_config || {};
  if (Object.hasOwn(config, "archiveMhtml") || config.offline !== false || config.output !== "anotherworldbuilder") {
    delete config.archiveMhtml;
    config.offline = false;
    config.output = "anotherworldbuilder";
    await chrome.storage.local.set({ lwl_run_config: config });
  }
  state.windowMode = windowMode();
  return config;
}

async function loadRunContext() {
  await loadConfigOnly();
  const list = await LWLProfiles.list();
  profile = list.find(p => p.id === config.profileId) || null;
  if (!profile) throw new Error("No profile selected. Pick one in the extension popup and start a sync there.");
  LWLProviders.validate(profile);
  sources = LWLProfiles.resolveSources(profile,config.sourceIds || []);
  state.profileName = profile.name;
  state.sourceTotal = sources.length;
  state.windowMode = windowMode();
  pageMem.clear();
  return { profile, sources, config };
}

function syncRunKey(value) {
 return stableJson({profileId:value.profileId,sourceIds:[...(value.sourceIds||[])].sort(),syncMode:value.syncMode||"new_only",targets:value.targets||[],wholeSourceIds:value.wholeSourceIds||[]});
}
const resumableStatus = value => ["stopped","interrupted","error","partial"].includes(value);
function sourceComplete(meta) {
 return meta?.complete!==false && !meta?.detailFailed && !meta?.detailUnavailable &&
  meta?.previewCapture?.complete!==false && !(meta?.items||[]).some(item=>['error','unavailable','empty'].includes(item.captureStatus)) &&
  (!(meta?.type==='catalog'||meta?.mode==='content')||meta.detailStored===meta.items?.length);
}

/* Configure and reserve a run in one worker command. Opening another popup
   must never change the configuration underneath an active crawl. */
async function configureSync(request) {
 if(running){
  if(request?.exportId && request.exportId!==state.exportId)throw new Error(ui("Another capture is running. Finish or stop it first.","Eine andere Erfassung läuft. Beende oder stoppe sie zuerst."));
  return {ok:true,alreadyRunning:true};
 }
 if(busy||pageTasksActive||pageCommandsActive)throw new Error(ui("Finish the current task first.","Beende zuerst den laufenden Vorgang."));
 busy=true;
 let resume=false,force=false;
 try {
  const previous=(await chrome.storage.local.get("lwl_run_config")).lwl_run_config||{};
  const selected=(await LWLProfiles.list()).find(p=>p.id===request?.profileId);
  if(!selected)throw new Error(ui("Choose a profile first.","Wähle zuerst ein Profil."));
  const selectedSources=LWLProfiles.resolveSources(selected,request.sourceIds||[]);
  if(!selectedSources.length)throw new Error(ui("Select at least one source.","Wähle mindestens eine Quelle."));
  const next={...previous,profileId:selected.id,sourceIds:selectedSources.map(s=>s.id),
   syncMode:request.syncMode==="verify_all"?"verify_all":"new_only",offline:false,output:"anotherworldbuilder",
   assets:request.assets!==false,parallelism:1,exportId:request.exportId || null,
   targets:validateExportTargets(selected,request.targets || [],selectedSources.map(s=>s.id)),
   wholeSourceIds:validateWholeSources(selected,request.wholeSourceIds || [],selectedSources.map(s=>s.id)),
   delayMs:Math.max(PACE_MIN_MS,Math.min(10000,Number(request.delayMs)||PACE_DEFAULT_MS))};
  delete next.archiveMhtml;
  resume=resumableStatus(state.status)&&(state.runKey||syncRunKey(previous))===syncRunKey(next);
  force=resume&&state.force;
  await chrome.storage.local.set({lwl_run_config:next});
  state.exportId=next.exportId;state.profileId=next.profileId;state.sourceIds=next.sourceIds;
 } finally { busy=false; }
 run({resume,force});
 return {ok:true,started:true,resumed:resume};
}

/* App-only capture never requires a disk output folder. */
function writesFiles() { return false; }

async function requireStore() {
  const s = await storeStatus();
  if (s?.ok) {
    const probe=await askOffscreen({type:"FS_SELFTEST"});
    if(!probe?.ok)throw new Error(ui("Writing to the library folder failed: ","Schreiben in den Bibliotheksordner fehlgeschlagen: ")+(probe?.error||"unknown error"));
    log(ui("Library folder write verified: ","Schreibzugriff auf Bibliotheksordner geprüft: ")+(s.folderName||""));
    return s;
  }
  if (s?.reason === "no-folder") throw new Error(ui("Choose a library folder to continue. Press Continue in this tab to select it.","Wähle einen Bibliotheksordner. Klicke hier auf Fortsetzen, um ihn auszuwählen."));
  if (s?.reason === "no-permission") throw new Error(ui("Reconnect the library folder to continue. Press Continue and allow folder access in Chrome.","Verbinde den Bibliotheksordner erneut. Klicke auf Fortsetzen und erlaube den Ordnerzugriff in Chrome."));
  if (s?.reason === "unavailable") throw new Error(`The background writer did not answer: ${s.error || "unknown reason"}. Reload the extension and try again.`);
  throw new Error(s?.error || "The library folder is not reachable.");
}

async function closeOffscreenIfIdle() {
  if (running || busy || pageTasksActive > 0) return;
  await chrome.alarms.clear("lwl-heartbeat");
  if (offscreenRequests.size) return;
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument().catch(() => {});
}

async function run({ force = false, resume = false } = {}) {
  if (running || busy) return;
  awModel = null;
  // A finished partial run is an explicit retry. An interrupted run must first
  // reach its remaining sources, including when earlier sources had gaps.
  const continueInterrupted = resume && state.status !== "partial";
  running = true; paused = false; stopRequested = false;
  browserStopRequested = false;
  state.running = true; state.paused = false; state.force = force; state.lastError = null;
  if (!resume) {
    state.completedSourceIds = [];
    state.processedSourceIds = [];
    state.currentSourceId = null;
    state.logLines = [];
    state.startedAt = new Date().toISOString();
  }
  state.finishedAt = null;
  if(!continueInterrupted)state.processedSourceIds=[];
  state.source = "–";
  state.page = "–";
  captureBackup = null; backupFailure = null;
  state.diskCount=0;state.diskPath=null;state.lastWriteAt=null;state.backupEnabled=false;
  state.sourceTotal=0;state.activeTasks=[];activeSteps.clear();
  persist(true);
  try {
    status("running");
    setProgress(0, 1);
    await requireBrowserWindow();
    await loadRunContext();
    state.exportId=config.exportId || null;state.profileId=profile.id;state.sourceIds=sources.map(s=>s.id);
    const key=syncRunKey(config);
    if(resume&&state.runKey&&state.runKey!==key){
      resume=false;force=false;state.force=false;state.completedSourceIds=[];
      state.processedSourceIds=[];
      state.startedAt=new Date().toISOString();
    }
    state.runKey=key;resuming=resume;
    state.sourceTotal=sources.length;
    await countPages();
    if (!sources.length) throw new Error("No sources selected for this profile.");
    /* Always up, even for a run that writes nothing: this document holds the
       port that stops Chrome from tearing the worker down mid-crawl. */
    await ensureOffscreen();
    if (writesFiles()) await requireStore();
    // Old pending file writes remain inspectable/discardable in Storage. Never
    // replay them after switching to app-only output.
    if(writesFiles())await beginCaptureBackup();
    const sourceRecords=resume?await readLocal(sources.map(s=>sourceKey(s.id))):{};
    // Older versions marked a stopped catalog complete. Its own capture status
    // is authoritative, so a resume must revisit the unfinished source.
    const done = new Set(resume&&!config.targets?.length ? state.completedSourceIds.filter(id=>sources.some(s=>s.id===id)&&sourceComplete(sourceRecords[sourceKey(id)])) : []);
    state.completedSourceIds=[...done];
    const processed=new Set(state.processedSourceIds.filter(id=>sources.some(s=>s.id===id)));
    for (const s of sources) {
      if (stopRequested) break;
      if (done.has(s.id)) { log(`Skipping ${s.name}: finished before the interruption.`); continue; }
      if (!config.targets?.length && processed.has(s.id)) { log(`Skipping ${s.name}: already processed in this run; remaining gaps stay visible.`); continue; }
      state.currentSourceId = s.id;
      setField("source",s.name);
      persist(true);
      log(`=== ${s.name} (${s.type}) ===`);
      let targetComplete=false;
      try { targetComplete=await syncSource(s, force); }
      catch(error) {
        if(backupFailure)throw backupFailure;
        if(stopRequested)break;
        const key=sourceKey(s.id),previous=(await chrome.storage.local.get(key))[key];
        await chrome.storage.local.set({[key]:{...previous,complete:false,error:String(error.message||error)}});
        log(`Source failed: ${s.name}: ${error.message||error}. Continuing with the remaining sources.`);
      }
      if(backupFailure)throw backupFailure;
      // Release loaded site renderers before building the local output.
      await closeCrawlWindow();
      // Content and resources are durable in browser storage. The app is the
      // only output; there is no per-source Reader or file backup to rebuild.
      if(stopRequested)break;
      const captured=(await chrome.storage.local.get(sourceKey(s.id)))[sourceKey(s.id)];
      if(targetedSource(s)?targetComplete===true:sourceComplete(captured))done.add(s.id);
      else log(`Incomplete source retained for retry: ${s.name}`);
      state.completedSourceIds = [...done];
      processed.add(s.id);state.processedSourceIds=[...processed];
      state.currentSourceId = null;
      persist(true);
    }
    if (!stopRequested && !config.targets?.length && config.autoCleanup !== false) await pruneStoredCache(profile.id).catch(error => log(`Cache cleanup skipped: ${error.message}`));
    await chrome.storage.local.set({
      [metaKey()]: {
        profileId: profile.id, profileVersion: profile.profileVersion,
        lastSyncAt: new Date().toISOString(), sourceIds: sources.map(s => s.id)
      }
    });
    const incomplete=sources.some(s=>!done.has(s.id));
    if (!stopRequested&&!incomplete) state.completedSourceIds = [];
    status(stopRequested ? "stopped" : incomplete ? "partial" : "complete");
    if (stopRequested && state.completedSourceIds.length) log(`${state.completedSourceIds.length} source(s) finished; Continue picks up from there.`);
    log(stopRequested ? "Stopped." : incomplete ? "Saved available content. Some sources are incomplete; Continue retries them." : "Synchronization complete.");
  } catch (e) {
    if (stopRequested && !backupFailure) status("stopped");
    else {
      state.lastError = String(e.message || e);
      status("error");
      log(`FATAL: ${e.stack || e}`);
    }
  } finally {
    captureBackup = null;
    resuming = false;
    running = false;
    state.running = false;
    state.paused = false;
    state.currentSourceId = null;
    state.activeTasks = []; activeSteps.clear();
    state.finishedAt = new Date().toISOString();
    await countPages().catch(() => {});
    await closeCrawlWindow();
    await persist(true);
    broadcast();
    await closeOffscreenIfIdle();
  }
}

/* Long jobs answer their message immediately and report through the state
   broadcast; a reply held open for minutes would be dropped by the channel. */
async function runJob(label, fn) {
  if (running || busy) throw new Error("Another job is still running.");
  awModel = null;
  busy = true;
  paused = false;
  stopRequested = false;
  browserStopRequested = false;
  state.paused = false;
  state.running = true;
  state.paused = false;
  state.lastError = null;
  state.finishedAt = null;
  status(label);
  broadcast();
  (async () => {
    try {
      await requireBrowserWindow();
      await fn();
      status(stopRequested ? "stopped" : "complete");
    } catch (e) {
      if (stopRequested) status("stopped");
      else {
        state.lastError = String(e.message || e);
        status("error");
        log(`FATAL: ${e.stack || e}`);
      }
    } finally {
      busy = false;
      state.running = false;
      state.finishedAt = new Date().toISOString();
      persist(true);
      broadcast();
      await closeOffscreenIfIdle();
    }
  })();
  return { ok: true, started: true };
}

async function missingTargets() {
  const all=await readerData({captureStyles:false}),idx=await buildIndexes(all);
  // A catalog row is itself a known target, even when no saved article links
  // to it. Include old partial captures so book repairs can restore anchors.
  const missing=Object.entries(idx.manifest.targets).filter(([,entry])=>!entry.available).map(([url])=>url);
  const stale=Object.values(all).filter(record=>record?.html&&record.url).filter(record=>{
    const source=profile.sources.find(s=>s.id===record.sourceId);
    return source&&!reusableCapture(record,source);
  }).map(record=>record.requestedUrl||record.url);
  const targets=[...new Set([...missing,...stale,...idx.report.dependencies.filter(d=>!d.resolved&&d.reason!=="missing-anchor").map(d=>d.to)].map(canonical))];
  const configured=profile.sources||[];
  return targets.map(url=>({url,source:configured.find(s=>{
    if(!LWLUrl.sameOrigin(url,profile)||shouldSkipUrl(url))return false;
    if(canonical(s.startUrl)===url||belongsToSource(url,s))return true;
    return s.type==="collection"&&(all[sourceKey(s.id)]?.items||[]).some(item=>url.startsWith(canonical(item.url).replace(/\/$/,"")+"/"));
  })})).filter(x=>x.source);
}

async function fetchMissing() {
  const known=await missingTargets();
  if(!known.length){log("No known missing or outdated pages; missing anchors require checking the source capture.");return;}
  setProgress(0,known.length);let done=0;
  await pool(known,1,async x=>{
    if(x.source.type==="catalog"){
      const item={url:x.url,title:LWLUrl.slugFromUrl(x.url)};
      const rec=await syncDetail(x.source,item,false);
      if(rec?.html){
        const key=sourceKey(x.source.id),meta=(await chrome.storage.local.get(key))[key]||{sourceId:x.source.id,name:x.source.name,type:"catalog",mode:"content",items:[]};
        if(!meta.items.some(i=>canonical(i.url)===x.url))meta.items.push({...item,title:rec.title,meta:rec.meta});
        meta.itemCount=meta.items.length;await chrome.storage.local.set({[key]:meta});
      }
    }else{
      const meta=(await chrome.storage.local.get(sourceKey(x.source.id)))[sourceKey(x.source.id)];
      const book=x.source.type==="collection"?(meta?.items||[]).find(i=>x.url===canonical(i.url)||x.url.startsWith(canonical(i.url).replace(/\/$/,"")+"/")):null;
      await syncPage(book?{...x.source,collectionRoot:book.url}:x.source,x.url,book?{collectionId:safeId(canonical(book.url)),collectionTitle:book.title,collectionCover:book.cover}: {},false);
    }
    setProgress(++done);
  });
  await closeCrawlWindow();
}

/* ---------- commands from the runner tab ---------- */

let storageSnapshot = null, storageSnapshotAt = 0, storageInspecting = null, pageCommandsActive = 0;
async function inspectStorage() {
  const [keys, resources, rawWrites] = await Promise.all([localKeys(), LWLIdb.resourceEntries(), LWLIdb.writeEntries()]);
  // The placeholder values are only used for ownership/key enumeration. Read
  // control metadata separately; captured HTML and CSS stay in Chrome's store.
  const all = Object.fromEntries(keys.map(key => [key, null]));
  Object.assign(all, await readLocal([LWLProfiles.PROFILE_LIST_KEY,LWLProfiles.ACTIVE_KEY,"lwl_run_config","lwl_detection_scan_debug_meta_v1",...keys.filter(key=>key.endsWith(":reader-output"))]));
  const profiles = all[LWLProfiles.PROFILE_LIST_KEY] || [];
  const writes = rawWrites.map(row => {
    if (row.profileId) return row;
    const matches = profiles.filter(p => row.path?.startsWith(`${safePart(p.name || p.id,"site")}/`));
    return matches.length === 1 ? { ...row, profileId: matches[0].id } : row;
  });
  const localBytes = await chrome.storage.local.getBytesInUse(null);
  const usage = LWLStorage.summarize(all, resources, writes, profiles, localBytes);
  for (const row of usage.profiles) {
    row.localBytes = await chrome.storage.local.getBytesInUse(keys.filter(key=>key.startsWith(LWLStorage.prefix(row.id))));
    row.totalBytes = row.localBytes + row.resourceBytes + row.writeBytes;
  }
  usage.temporaryBytes = await chrome.storage.local.getBytesInUse(keys.filter(key=>key==="lwl_pending_detection"||key.startsWith("lwl_detection_scan_")));
  for (const row of usage.profiles) row.output = all[`${LWLStorage.prefix(row.id)}reader-output`] || null;
  usage.activeProfileId = all.lwl_run_config?.profileId || all[LWLProfiles.ACTIVE_KEY] || null;
  usage.autoCleanup = all.lwl_run_config?.autoCleanup !== false;
  return { all, resources, writes, profiles, usage };
}
async function storageOverview(force = false) {
  if (force || !storageSnapshot || Date.now() - storageSnapshotAt > 15000) {
    if (!storageInspecting) storageInspecting = inspectStorage().then(snapshot => {
      storageSnapshot = snapshot.usage; storageSnapshotAt = Date.now();
    }).finally(() => { storageInspecting = null; });
    await storageInspecting;
  }
  return { ...storageSnapshot, ...maintenanceState() };
}
function maintenanceState() {
 const locked=running||busy||pageCommandsActive>0||pageTasksActive>0;
 return {busy:locked,canStop:running,busyReason:!locked?null:running
  ?ui("Synchronization is running. Stop it before deleting browser data.","Die Synchronisierung läuft. Stoppe sie, bevor du Browserdaten löschst.")
  :ui("A task is using the saved data. Wait until it finishes.","Ein Vorgang verwendet die gespeicherten Daten. Warte, bis er beendet ist.")};
}
async function pruneStoredCache(profileId) {
  const snapshot = await inspectStorage();
  if (snapshot.writes.length) throw new Error("Unfinished writes must be completed or discarded before cache cleanup");
  const own = await readLocal(Object.keys(snapshot.all).filter(key=>key==="lwl_pending_detection"||key.startsWith("lwl_detection_scan_")));
  const plan = await LWLStorage.planKeys(Object.keys(snapshot.all), profileId, snapshot.resources,
    async key=>(await chrome.storage.local.get(key))[key], LWLIdb.getResource,
    keys=>chrome.storage.local.getBytesInUse(keys));
  await LWLIdb.deleteResources(plan.resourceKeys);
  const expired = LWLStorage.expiredTemporaryKeys(own);
  const keys = [...plan.localKeys, ...expired];
  if (keys.length) await chrome.storage.local.remove(keys);
  storageSnapshot = null;
  const freed = plan.bytes + expired.reduce((n, key) => n + LWLStorage.bytes(key, own[key]), 0);
  if (keys.length || plan.resourceKeys.length) log(`Cache cleanup: ${plan.resourceKeys.length} resource(s), ${keys.length} record(s), ${freed} bytes freed.`);
  return { removed: keys.length + plan.resourceKeys.length, bytes: freed };
}
async function maintainStorage(msg) {
  if (running || busy || pageTasksActive || pageCommandsActive) throw new Error(ui("Wait until the current task has finished.","Warte, bis der laufende Vorgang beendet ist."));
  awModel = null;
  busy = true; state.running = true; broadcast();
  try {
    const snapshot = await inspectStorage();
    if (LWLStorage.detectionBusy(snapshot.all)) throw new Error(ui("Finish or cancel the running page detection first.","Beende oder stoppe zuerst die laufende Seitenerkennung."));
    const id = msg.profileId, row = snapshot.usage.profiles.find(p => p.id === id);
    if (!["discard","temporary"].includes(msg.action) && !row) throw new Error("Unknown storage profile");
    let result = { removed: 0, bytes: 0 };
    if (msg.action === "discard") {
      const rows = snapshot.writes.filter(row => !id || row.profileId === id);
      const res = rows.length?await askOffscreen({type:"FS_DROP_WRITES",ids:rows.map(row=>row.id)}):{ok:true};
      if (!res?.ok) throw new Error(res?.error || "Could not discard pending writes");
      result = { removed: rows.length, bytes: rows.reduce((n,row)=>n+row.bytes,0) };
    } else if (msg.action === "temporary") {
      const keys = Object.keys(snapshot.all).filter(k => k === "lwl_pending_detection" || k.startsWith("lwl_detection_scan_"));
      await chrome.storage.local.remove(keys);
      result = { removed: keys.length, bytes: snapshot.usage.temporaryBytes };
    } else if (msg.action === "unused") {
      result = await pruneStoredCache(id);
      if (writesFiles() && row.output?.root) {
        const cleaned = await askOffscreen({type:"FS_READER_CLEAN",root:row.output.root,profileId:id});
        if (cleaned?.ok) { result.files = cleaned.removed; result.fileBytes = cleaned.bytes; result.keptFiles = cleaned.kept; }
        else result.folderNotice = cleaned?.error || "Folder cleanup unavailable; browser cache was cleaned";
      }
    } else if (msg.action === "resources") {
      if (snapshot.writes.some(row=>!row.profileId||row.profileId===id)) throw new Error(ui("Complete or discard this profile's pending writes before clearing its cache.","Schließe die ausstehenden Schreibvorgänge dieses Profils ab oder verwirf sie, bevor du seinen Cache leerst."));
      await LWLIdb.clearResources(id);
      result = { removed: row.resources, bytes: row.resourceBytes };
    } else if (msg.action === "reset" || msg.action === "delete") {
      const rows = snapshot.writes.filter(row => row.profileId === id);
      const res = rows.length?await askOffscreen({type:"FS_DROP_WRITES",ids:rows.map(row=>row.id)}):{ok:true};
      if (!res?.ok) throw new Error(res?.error || "Could not discard profile writes");
      await LWLIdb.clearResources(id);
      const keys = Object.keys(snapshot.all).filter(k => k.startsWith(LWLStorage.prefix(id)));
      await chrome.storage.local.remove(keys);
      if (msg.action === "delete" && !row.orphan) await LWLProfiles.removeDefinition(id);
      if (snapshot.all.lwl_run_config?.profileId === id) {
        if (msg.action === "delete") {
          const next = { ...snapshot.all.lwl_run_config, sourceIds: [] }; delete next.profileId;
          await chrome.storage.local.set({lwl_run_config:next});
        }
        Object.assign(state,{completedSourceIds:[],processedSourceIds:[],currentSourceId:null,count:0,captured:0,
          status:"idle",lastError:null,source:"–",page:"–",progress:0,progressMax:1,
          backupEnabled:false,diskCount:0,diskPath:null,lastWriteAt:null,runKey:null,force:false,sourceTotal:0});
        await chrome.storage.local.set({[RUN_STATE_KEY]:{running:false,completedSourceIds:[],status:"idle",updatedAt:Date.now()}});
      }
      pageMem.clear();
      result = { removed: keys.length + row.resources + rows.length, bytes: row.totalBytes };
    } else throw new Error("Unknown storage action");
    storageSnapshot = null;
    return { ok: true, ...result };
  } finally {
    busy = false; state.running = false; broadcast();
    await closeOffscreenIfIdle();
  }
}

async function setupProvider(id,profileId=null){
 if(running||busy||pageTasksActive||pageCommandsActive)throw Error(ui('Finish the current task first.','Beende zuerst den laufenden Vorgang.'));
 awModel = null;
 busy=true;
 try{
  const adapter=LWLProviders.get(id);if(!adapter)throw Error('Unknown export provider: '+id);
  const profiles=await LWLProfiles.list();
  const previous=profileId?profiles.find(p=>p.id===profileId):profiles.find(p=>p.provider?.id===id)||profiles.find(p=>p.origin===adapter.origin);
  const next=LWLProfiles.normalizeProfile(await LWLProviders.createProfile(id,previous||null));
  const backups=(await chrome.storage.local.get('lwl_provider_migrations_v1')).lwl_provider_migrations_v1||[];
  await chrome.storage.local.set({lwl_provider_migrations_v1:[...backups.slice(-4),{at:new Date().toISOString(),provider:id,profile:previous||null}]});
  const updates={};
  for(const source of next.sources){
   const key=`lwl:${next.id}:source:${source.id}`,meta=(await chrome.storage.local.get(key))[key];
   if(meta?.catalog&&source.catalogView)updates[key]={...meta,catalog:{...meta.catalog,config:{...meta.catalog.config,...source.catalogView}}};
  }
  const oldIndex=profiles.findIndex(p=>p.id===next.id);if(oldIndex<0)profiles.push(next);else profiles[oldIndex]=next;
  // One storage transaction publishes profile and matching catalog rules.
  await chrome.storage.local.set({...updates,[LWLProfiles.PROFILE_LIST_KEY]:profiles,[LWLProfiles.ACTIVE_KEY]:next.id});
  return {ok:true,profile:next,migrated:Boolean(previous),sources:next.sources.length};
 }finally{busy=false;}
}

/* ---------- AnotherWorldbuilder: the library, read for sending ---------- */

/* The library as the send page needs it: an index without the pages' HTML,
   the glossary and the user's own books — read once, kept a few minutes.
   The pages themselves come by id (`AW_HTML`), a batch at a time. */
let awModel = null;
async function awModelFor(profileId, token = null) {
  if (busy) throw new Error(ui("A sync is running — send when it is done.", "Ein Sync läuft – sende, wenn er fertig ist."));
  if (running) throw new Error(ui("A sync is running — send when it is done.", "Ein Sync läuft – sende, wenn er fertig ist."));
  if (awModel?.profileId === profileId && ((token && token === awModel.token) || Date.now() - awModel.at < 10 * 60 * 1000)) {
    awModel.at = Date.now();
    return awModel;
  }
  const chosen = (await LWLProfiles.list()).find(p => p.id === profileId);
  if (!chosen) throw new Error(ui("Choose a profile first.", "Wähle zuerst ein Profil."));
  profile = chosen;
  const { records, readerSources } = await collectReaderModel(null, { lazyStyles: true });
  const kindOf = new Map((profile.sources || []).map(s => [s.id, s.providerSource || s.id]));
  const books = readerSources.filter(s => s.type === "book").map(s => ({ id:s.id, name:s.name, url:s.url, cover:s.cover || null, sourceId:s.captureSourceId }));
  const bookIds = new Set(books.map(b => b.id));
  const pageUrl = value => String(value).split(/[?#]/)[0].replace(/\/+$/, '').replace('/sources/dnd/free-rules', '/sources/dnd/br-2024');
  const incoming = new Map();
  for (const r of records) for (const l of r.links || []) {
    try {
      const u = new URL(typeof l === 'string' ? l : l.url, r.url);
      if (!u.hash) continue;
      const key = pageUrl(u.href);
      if (!incoming.has(key)) incoming.set(key, new Set());
      let id; try { id = decodeURIComponent(u.hash.slice(1)); } catch { id = u.hash.slice(1); }
      incoming.get(key).add(id);
    } catch { /* malformed saved link */ }
  }
  awModel = {
    profileId, at: Date.now(), records, token:crypto.randomUUID(),
    index: records.map((r, i) => ({ i, sourceId:books.find(b => b.id===r.sourceId)?.sourceId || r.sourceId, id:r.id, s:kindOf.get(r.sourceId) || r.sourceId, u:r.url, t:r.title, m:r.meta || {}, a:r.aliases || [], has:Boolean(r.html) && r.captureStatus !== "unavailable", book:bookIds.has(r.sourceId)?r.sourceId:null, order:r.order ?? 0, anchors:bookIds.has(r.sourceId)?[...new Set([r.url,...(r.aliases || [])].flatMap(u => [...(incoming.get(pageUrl(u)) || [])]))]:[], captureStatus:r.captureStatus || null })),
    glossary: LWLReferences.glossaryEntries(records, readerSources).map(g => ({ term: g.term, url: g.url, definition: g.definition })),
    books,
  };
  return awModel;
}

async function handleCommand(msg) {
  switch (msg.type) {
    case "AW_STREAM_GET":return liveSnapshot();
    case "AW_STREAM_START":return liveStart(msg);
    case "AW_STREAM_STOP":return liveStop(msg.exportId);
    case "AW_PAGES":return livePages(msg.forget===true);
    case "AW_SELECTION_PROFILE":return selectionProfile();
    case "AW_CATALOG_GET":return selectionCatalogGet(msg.profileId,msg.sourceId);
    case "AW_CATALOG_START":return selectionCatalogStart(msg.profileId,msg.sourceId,msg.refresh===true);
    case "AW_CATALOG_STOP":return selectionCatalogStop(msg.jobId);
    case "AW_EXPORT_DRAFT":return selectionExportDraft(msg);
    case "AW_EXPORT_CANCEL":
      if(msg.exportId&&(liveStartingId===msg.exportId||liveActive&&liveJob?.id===msg.exportId))return liveStop(msg.exportId);
      if(!msg.exportId||state.exportId!==msg.exportId||!state.running)return {ok:true,stopped:false};
      stopRequested=true;paused=false;await closeCrawlWindow();return {ok:true,stopped:true};
    case "AW_EXPORT_PLAN": {
      const selected = (await LWLProfiles.list()).find(p => p.id === msg.profileId);
      if (!selected) throw new Error(ui("Choose a profile first.","Wähle zuerst ein Profil."));
      const ids = msg.sourceIds || selected.sources.map(s => s.id);
      if (!ids.length || ids.some(id => !selected.sources.some(s => s.id === id))) throw new Error(ui("Select valid sources first.","Wähle zuerst gültige Quellen."));
      const chosen = LWLProfiles.exportSources(selected,ids);
      const targets=validateExportTargets(selected,msg.targets || [],chosen.map(s=>s.id));
      const wholeSourceIds=validateWholeSources(selected,msg.wholeSourceIds || [],chosen.map(s=>s.id));
      return {ok:true,profile:{id:selected.id,name:selected.name},sources:chosen.map(s => ({id:s.id,name:s.name,kind:s.providerSource || s.id,type:s.type})),sourceIds:chosen.map(s => s.id),targets,wholeSourceIds};
    }
    case "AW_LIBRARY": {
      const m = await awModelFor(msg.profileId);
      const ids = msg.sourceIds ? new Set(msg.sourceIds) : null;
      const index = ids ? m.index.filter(e => ids.has(e.sourceId)) : m.index;
      const bookIds = new Set(index.map(e => e.book).filter(Boolean));
      const glossarySelected = !ids || index.some(e => e.s === 'rules-glossary');
      return { ok:true,token:m.token,index,glossary:glossarySelected?m.glossary:[],books:ids?m.books.filter(b => bookIds.has(b.id)):m.books,ownedBooks:m.books.map(b=>b.name) };
    }
    case "AW_HTML": {
      const m = await awModelFor(msg.profileId, msg.token);
      if (msg.token !== m.token) throw new Error(ui("Captured data changed. Reopen Send before transferring it.", "Die erfassten Daten haben sich geändert. Öffne Senden erneut."));
      return { ok: true, html: (msg.indexes || []).map(i => m.records[i]?.html || "") };
    }
    case "GET_STATE":
      return { ok: true, state, maintenance:maintenanceState(),version:chrome.runtime.getManifest?.().version||null };

    case "CONFIGURE_SYNC":
      return configureSync(msg.config);

    case "SETUP_PROVIDER":return setupProvider(msg.providerId,msg.profileId);
    case "START":
      if (running || busy) return { ok: false, error: "A job is already running." };
      run({ force: msg.force?true:resumableStatus(state.status)?state.force:false, resume: !msg.force&&resumableStatus(state.status) });
      return { ok: true, started: true };

    case "RESUME_RUN":
      if (running || busy) return { ok: false, error: "A job is already running." };
      run({ force: state.force, resume: true });
      return { ok: true, started: true };

    case "PAUSE":
      if (!running && !busy) return { ok: false, error: "Nothing is running." };
      paused = !paused;
      state.paused = paused;
      status(paused ? "paused" : "running");
      persist(true);
      return { ok: true, paused };

    case "STOP":
      stopRequested = true;
      paused = false;
      state.paused = false;
      log("Stop requested; finishing the pages already in flight.");
      await closeCrawlWindow();
      return { ok: true };

    case "REFRESH_CATALOG_VIEWS":
      await loadRunContext();
      return await runJob("refreshing catalog views", refreshCatalogViews);

    case "COMPLETE_CATALOGS":
      await loadRunContext();
      return await runJob("completing catalog previews and filters", completeCatalogs);

    case "REBUILD_READER":
      throw new Error(ui("The Offline Reader is retired. Send content to AnotherWorldbuilder.", "Der Offline-Reader ist eingestellt. Sende Inhalte an AnotherWorldbuilder."));

    case "DEPENDENCY_CHECK": {
      await loadRunContext();
      const x = await buildIndexes();
      return { ok: true, stats: x.report.stats };
    }

    case "FETCH_MISSING_PREVIEW": {
      await loadRunContext();
      const known = await missingTargets();
      return { ok: true, count: known.length };
    }

    case "FETCH_MISSING":
      await loadRunContext();
      return await runJob("fetching missing pages", fetchMissing);

    case "EXPORT":
      throw new Error(ui("Content is sent only to AnotherWorldbuilder. JSON and ZIP exports are retired.", "Inhalte werden ausschließlich an AnotherWorldbuilder gesendet. JSON- und ZIP-Exporte sind eingestellt."));

    case "RESET": {
      const st = await chrome.storage.local.get("lwl_run_config");
      return maintainStorage({action:"reset",profileId:st.lwl_run_config?.profileId});
    }

    /* Captured pages live in chrome.storage.local, inside the browser profile
       and invisible from the file manager. Report what that costs so it can be
       judged and cleared, rather than growing unnoticed. */
    case "STORAGE_USAGE": {
      const usage = await storageOverview();
      const row = usage.profiles.find(p=>p.id===usage.activeProfileId);
      return {ok:true,bytes:usage.totalBytes,profileBytes:row?.totalBytes||0,profileKeys:row?.records||0};
    }
    case "STORAGE_OVERVIEW": return {ok:true,...await storageOverview(Boolean(msg.force))};
    case "STORAGE_MAINTAIN": return maintainStorage(msg);
    case "DELETE_PROFILE": return maintainStorage({action:"delete",profileId:msg.profileId});
    case "SET_STORAGE_OPTIONS": {
      const st = await chrome.storage.local.get("lwl_run_config");
      const next = {...(st.lwl_run_config||{}),autoCleanup:msg.autoCleanup!==false};
      await chrome.storage.local.set({lwl_run_config:next});config.autoCleanup=next.autoCleanup;storageSnapshot=null;
      return {ok:true};
    }

    case "COUNT": {
      if (!running && !busy) await loadRunContext();
      return { ok: true, count: await countPages() };
    }

    case "STORE_DIAGNOSE": {
      const writer = await askOffscreen({ type: "FS_DIAGNOSE" }).catch(e => ({ error: String(e.message || e), unreachable: true }));
      await closeOffscreenIfIdle();
      return { ok: true, writer };
    }

    case "STORE_CHECK": {
      const probe = await askOffscreen({ type: "FS_SELFTEST" });
      await closeOffscreenIfIdle();
      return probe?.ok ? { ok: true } : { ok: false, error: probe?.error || "The writer could not use the folder." };
    }

    case "SET_WINDOW_MODE": {
      const st = await chrome.storage.local.get("lwl_run_config");
      const next = { ...(st.lwl_run_config || {}), windowMode: msg.mode === "visible" ? "visible" : "minimized" };
      await chrome.storage.local.set({ lwl_run_config: next });
      config = next;
      state.windowMode = windowMode();
      broadcast();
      return { ok: true, windowMode: state.windowMode };
    }

    case "SET_AUTO_RESUME": {
      const st = await chrome.storage.local.get("lwl_run_config");
      // Older open tabs can still send this command. Never re-enable autostart.
      const next = { ...(st.lwl_run_config || {}), autoResume: false };
      await chrome.storage.local.set({ lwl_run_config: next });
      config = next;
      return { ok: true, autoResume: next.autoResume };
    }

    case "PAGE_TASK": {
      if (running || busy) return { ok: false, error: "A sync is running; stop it before scanning." };
      pageCommandsActive++;
      stopRequested = false;
      browserStopRequested = false;
      try {
        await loadConfigOnly();
        return await pageTask(msg.task || {});
      } catch (e) {
        return { ok: false, error: String(e.message || e) };
      } finally {
        pageCommandsActive--;
      }
    }

    case "CRAWL_WINDOW_CLOSE":
      await closeCrawlWindow();
      await closeOffscreenIfIdle();
      return { ok: true };

    case "DISCARD_PENDING_WRITES":
      return maintainStorage({action:"discard"});

    default:
      return { ok: false, error: `Unknown command: ${msg.type}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "background") return false;
  (async () => {
    try { await bootstrap("command"); sendResponse(await handleCommand(msg)); }
    catch (e) { sendResponse({ ok: false, error: String(e.message || e) }); }
  })();
  return true;
});

/* ---------- worker lifetime ---------- */

/* A service worker is torn down after ~30 s without events. The offscreen
   document holds this port open and pings it, which keeps the worker alive
   through slow page loads; the alarm is the second net if the port is lost. */
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== "lwl-offscreen") return;
  settleOffscreenPort(port);
  port.onMessage.addListener(msg => {
    if (typeof msg?.reqId !== "number") return;   /* keepalive traffic */
    const req = offscreenRequests.get(msg.reqId);
    if (!req) return;
    offscreenRequests.delete(msg.reqId);
    req.resolve(msg.result);
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    if (offscreenPort === port) offscreenPort = null;
    failAllOffscreenRequests("The background writer disconnected");
  });
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== "lwl-heartbeat") return;
  if ((running || busy) && !stopRequested) {
    try { await requireBrowserWindow(); await ensureOffscreen(); } catch (_) {}
  } else await chrome.alarms.clear("lwl-heartbeat");
});

let bootstrapTask = null;
function bootstrap(reason) {
  if(!bootstrapTask)bootstrapTask=restoreWorker(reason);
  return bootstrapTask;
}

async function restoreWorker(reason) {
  try {
    const st = await chrome.storage.local.get([RUN_STATE_KEY, "lwl_run_config"]);
    await chrome.alarms.clear("lwl-heartbeat");
    const saved = st[RUN_STATE_KEY];
    const savedConfig = st.lwl_run_config || {};
    if (st.lwl_run_config && savedConfig.autoResume !== false) {
      await chrome.storage.local.set({lwl_run_config:{...savedConfig,autoResume:false}});
    }
    state.windowMode = savedConfig.windowMode === "visible" ? "visible" : "minimized";
    if (saved) {
      if (saved.lastError) state.lastError = saved.lastError;
      if (saved.logTail?.length && !state.logLines.length) state.logLines = saved.logTail.slice();
      if (saved.status) state.status = saved.status;
      state.completedSourceIds = saved.completedSourceIds || [];
      state.processedSourceIds = saved.processedSourceIds || [];
      state.currentSourceId = saved.currentSourceId || null;
      state.force = Boolean(saved.force);
      state.startedAt = saved.startedAt || null;
      for(const key of ["profileName","sourceTotal","source","page","progress","progressMax","captured","diskCount","diskPath","lastWriteAt","backupEnabled","finishedAt","runKey","exportId","profileId","sourceIds"]){
        if(saved[key]!==undefined)state[key]=saved[key];
      }
    }
    await closeOrphanCrawlWindow();
    // Merely opening storage management must not start writing its queue.
    // A resumed run takes the worker lock and flushes it in run().
    if (!saved?.running) return;
    // A terminal status can have been saved just before the worker exited its
    // finally block. Preserve it even if the old running flag is still true.
    if (!["complete","partial","stopped","error"].includes(state.status)) state.status = "interrupted";
    state.running = false; state.paused = false;
    log(`Restored saved progress (${reason}). Waiting for an explicit Start or Continue.`);
    await persist(true);
  } catch (error) {
    state.status = "error";
    state.lastError = String(error.message || error);
    log(`Startup could not restore saved progress: ${state.lastError}`);
  } finally {
    await closeOffscreenIfIdle().catch(() => {});
  }
}

chrome.runtime.onStartup.addListener(() => bootstrap("browser start"));
chrome.runtime.onInstalled.addListener(() => bootstrap("install"));
bootstrap("worker start");
