/* Offscreen catalog parser and capture-session keeper.

   Content is sent only to AnotherWorldbuilder. This document performs DOM
   parsing and holds a port open to the worker. A service
   worker is torn down after ~30 s without events, which would otherwise kill a
   crawl during a slow page load; port traffic resets that timer. */
(() => {
  "use strict";

  const KEEPALIVE_MS = 20000;
  let port = null;
  let timer = null;
  let serial = Promise.resolve();
  const enqueue = fn => { const next = serial.then(fn); serial = next.catch(() => {}); return next; };

  function connect() {
    try {
      /* Opening the port IS the readiness signal: the worker cannot send a
         request before this line has run, so there is no window in which a
         message arrives with no listener attached. */
      port = chrome.runtime.connect({ name: "lwl-offscreen" });
      port.onMessage.addListener(msg => {
        if (typeof msg?.reqId !== "number") return;
        (async () => {
          let result;
          try { result = msg.type==='AW_LIVE_CANCEL'?(AWLive.cancel(),{ok:true}):/^CATALOG_(MEMBERSHIP|PREVIEW|ROWS)$/.test(msg.type)?await LWLCatalogCapture.capture(msg):await enqueue(() => handle(msg)); }
          catch (e) { result = { ok: false, error: String(e.message || e) }; }
          try { port?.postMessage({ reqId: msg.reqId, result }); } catch { /* worker gone */ }
        })();
      });
      port.onDisconnect.addListener(() => {
        port = null;
        clearInterval(timer);
        timer = null;
        setTimeout(connect, 1000);
      });
      clearInterval(timer);
      timer = setInterval(() => {
        try { port?.postMessage({ type: "PING", at: Date.now() }); } catch { /* reconnects via onDisconnect */ }
      }, KEEPALIVE_MS);
    } catch {
      setTimeout(connect, 2000);
    }
  }

  async function handle(msg) {
    const live={AW_LIVE_OPEN:'open',AW_LIVE_INDEX:'index',AW_LIVE_RECORD:'record',AW_LIVE_EXISTING:'existing',AW_LIVE_FINISH:'finish',AW_LIVE_DROP:'drop'}[msg.type];
    if(live)return (await AWLive[live](msg))||{ok:true};
    const pages={AW_PAGE_READ:'read',AW_PAGE_KEPT:'kept',AW_PAGE_KEEP:'keep',AW_PAGES_COUNT:'count',AW_PAGES_FORGET:'forget'}[msg.type];
    if(pages)return await AWPages[pages](msg);
    // Payloads left by older versions may be discarded explicitly, never
    // replayed into the former Reader or export folder.
    if (msg.type === "FS_DROP_WRITES") {
      await LWLIdb.deleteWrites(msg.ids);
      return { ok:true };
    }
    if (String(msg.type).startsWith("FS_")) {
      return { ok:false, error:"File output is retired. Send content to AnotherWorldbuilder." };
    }
    return { ok:false, error:`Unknown offscreen request: ${msg.type}` };
  }

  connect();
  // Starting this document never writes a file or replays a legacy queue.
})();
