/* The sync tab controls capture for AnotherWorldbuilder.

   The crawl itself lives in the service worker, so this tab may be closed and
   reopened at any time; it asks for the current state on load and then follows
   the worker's broadcasts. Captured data stays in browser storage until the
   user sends it to a world through the extension popup. */
"use strict";
const $ = id => document.getElementById(id);
LWLI18n.apply();
const ui = (en, de) => (LWLI18n.isGerman ? de : en);
const t = key => LWLI18n.t(key);

const send = msg => chrome.runtime.sendMessage({ target: "background", ...msg });

async function command(msg) {
  const res = await send(msg).catch(e => ({ ok: false, error: String(e.message || e) }));
  if (res && !res.ok && res.error) actionNotice(res.error);
  return res;
}

/* ---------- run state ---------- */
let latestState = null, stateReceivedAt = 0, lastWorkerStatus = null;
const UI_VERSION = "4.4.0";
const needsReload = chrome.runtime.getManifest().version !== UI_VERSION;
function actionNotice(message) { $("actionNotice").textContent=message;$("actionNotice").hidden=!message; }
const statusLabels = () => ({idle:ui("Ready","Bereit"),running:ui("Synchronizing","Läuft"),
  paused:ui("Paused","Pausiert"),stopped:ui("Stopped","Gestoppt"),complete:ui("Complete","Abgeschlossen"),
  error:ui("Needs attention","Aktion erforderlich"),interrupted:ui("Interrupted","Unterbrochen"),partial:ui("Partially captured","Teilweise erfasst")});
function renderActivity() {
  const state=latestState;if(!state)return;
  const tasks=state.activeTasks||[],oldest=tasks.reduce((a,b)=>a.startedAt<b.startedAt?a:b,tasks[0]);
  const seconds=oldest?Math.max(0,Math.floor((Date.now()-oldest.startedAt)/1000)):0;
  const stages={loading:ui("Loading page","Seite laden"),extracting:ui("Reading content","Inhalt auslesen"),saving:ui("Saving content and resources","Inhalt und Ressourcen sichern")};
  let activity=state.running?(oldest?`${stages[oldest.stage]||oldest.stage} · ${seconds} s`:statusLabels()[state.status]||state.status):ui("Start a sync to update your library.","Starte einen Sync, um deine Bibliothek zu aktualisieren.");
  if(state.paused)activity=ui("Paused. Pages already in progress may finish saving.","Pausiert. Bereits geöffnete Seiten werden noch fertig gesichert.");
  else if(state.status==='complete')activity=ui("The task has finished.","Der Vorgang ist abgeschlossen.");
  else if(state.status==='partial')activity=ui("The run has finished with gaps. Retry incomplete sources when you choose.","Der Lauf ist mit Lücken beendet. Du kannst unvollständige Quellen gezielt erneut versuchen.");
  else if(['stopped','interrupted','error'].includes(state.status))activity=ui("Captured data is retained. Waiting for you to continue.","Erfasste Daten bleiben erhalten. Der Sync wartet auf dein Fortsetzen.");
  if(state.running&&Date.now()-stateReceivedAt>15000)activity=ui("No response from the background process. Waiting for reconnection…","Keine Antwort vom Hintergrundprozess. Warte auf erneute Verbindung …");
  $('activity').textContent=activity;
  $('activity').hidden=activity===$('phase').textContent;
  $('activity').classList.toggle('waiting',Boolean(state.running&&!state.paused&&seconds>=30));
}

function renderState(state) {
  if (!state) return;
  latestState=state;stateReceivedAt=Date.now();
  const labels=statusLabels();
  $("phase").textContent = labels[state.status] || state.status || labels.idle;
  $("status").textContent = state.paused?labels.paused:labels[state.status]||(state.running?labels.running:state.status);
  $("status").dataset.state=state.lastError?'error':state.running?'running':state.status;
  $("profile").textContent = state.profileName || "–";
  $("source").textContent = state.source || "–";
  $("page").textContent = state.page || "–";
  $("count").textContent = String(state.count ?? 0);
  $("captured").textContent=String(state.captured??0);
  $("sourcesDone").textContent=`${state.status==='complete'?state.sourceTotal||0:new Set([...(state.completedSourceIds||[]),...(state.processedSourceIds||[])]).size} / ${state.sourceTotal||'–'}`;
  const completeSources=state.status==='complete'?state.sourceTotal||0:new Set(state.completedSourceIds||[]).size;
  $("sourceSummary").hidden=!state.sourceTotal;
  $("sourceSummary").textContent=ui(
    `${completeSources} of ${state.sourceTotal||0} sources fully captured. “Processed” also includes sources with gaps.`,
    `${completeSources} von ${state.sourceTotal||0} Quellen vollständig erfasst. „Durchlaufen“ zählt auch Quellen mit Lücken.`);
  const tasks=$("activeTasks");tasks.replaceChildren();
  for(const task of state.activeTasks||[]){const li=document.createElement('li');li.textContent=`${task.url} · ${new Date(task.startedAt).toLocaleTimeString()}`;tasks.append(li);}
  renderActivity();
  /* "error" with an empty box tells the user nothing. Anything that failed
     before the reason was persisted still gets an explanation and a next step. */
  const err = $("lastError");
  const failed = state.status === "error" || Boolean(state.lastError);
  err.hidden = !failed;
  err.textContent = state.lastError || (failed ? t("errorNoDetail") : "");
  $("progress").max = state.progressMax || 1;
  if(!state.running||state.paused||state.progress>0||state.progressMax>1)$("progress").value=state.progress||0;
  else $("progress").removeAttribute('value');
  $("progressText").textContent=state.progressMax>1?`${state.progress||0} / ${state.progressMax}`:ui("Total not known yet","Umfang noch nicht bekannt");
  $("pause").textContent = state.paused ? ui("Resume", "Fortsetzen") : t("pause");
  const running = Boolean(state.running);
  $("reloadExtension").disabled=running;
  const resumable=['interrupted','stopped','error','partial'].includes(state.status);
  $("resumeRun").textContent=state.status==='partial'?t('retryIncompleteSources'):state.status==='error'?ui('Retry sync','Sync erneut versuchen'):t('resumeRun');
  $("resumeRun").hidden = running || !resumable;
  $("start").hidden=running||resumable;
  $("pause").hidden=!running;
  $("stop").hidden=!running;
  $("start").disabled = running||needsReload;
  $("resumeRun").disabled = running||needsReload;
  $("pause").disabled = !running;
  $("stop").disabled = !running;
  for (const id of ["refreshCatalogViews", "completeCatalogs", "dependencyCheck", "fetchMissingDeps", "reset", "fullRefresh"]) {
    $(id).disabled = running;
  }
  if(failed&&lastWorkerStatus!==state.status)$("detailsPanel").open=true;
  lastWorkerStatus=state.status;
  const log = $("log");
  const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
  const text = (state.logLines || []).join("\n");
  if (log.textContent !== text) {
    log.textContent = text;
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.target === "runner" && msg.type === "STATE") renderState(msg.state);
});

async function pullState() {
  const res = await send({ type: "GET_STATE" }).catch(() => null);
  if (res?.ok) renderState(res.state);
}

const humanBytes = n => {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(0)} KiB`;
  return `${(v / 1024 / 1024).toFixed(1)} MiB`;
};

let storageRefreshing = false;
async function renderStorage() {
  if(storageRefreshing)return;
  storageRefreshing=true;
  try {
  const res = await send({ type: "STORAGE_USAGE" }).catch(() => null);
  if (!res?.ok) return;
  $("storageProfile").textContent = humanBytes(res.profileBytes);
  $("storageRecords").textContent = String(res.profileKeys ?? 0);
  $("storageAll").textContent = humanBytes(res.bytes);
  } finally { storageRefreshing=false; }
}

/* ---------- crawl window options ---------- */

async function renderOptions() {
  const st = await chrome.storage.local.get("lwl_run_config");
  const config = st.lwl_run_config || {};
  $("windowMode").value = config.windowMode === "visible" ? "visible" : "minimized";
  $("mode").textContent = t(config.syncMode === "verify_all" ? "syncVerify" : "syncNew");
  $("workers").textContent = "1";
}

$("windowMode").onchange = async () => { await command({ type: "SET_WINDOW_MODE", mode: $("windowMode").value }); };

/* ---------- actions ---------- */

async function startSync(type) {
  if(needsReload)return;
  actionNotice("");
  try {
    await command({type,force:false});
    await pullState();
  } catch(error) {if(error.name!=="AbortError")actionNotice(String(error.message||error));}
}
$("start").onclick = () => startSync("START");
$("resumeRun").onclick = () => startSync("RESUME_RUN");
$("reloadExtension").onclick = () => {if(!latestState?.running)chrome.runtime.reload();};
$("pause").onclick = () => command({ type: "PAUSE" });
$("stop").onclick = () => command({ type: "STOP" });

$("fullRefresh").onclick = () => {
  if (!confirm(ui("Fully re-read all selected sources and overwrite current local records?", "Alle ausgewählten Quellen vollständig neu einlesen und lokale Datensätze überschreiben?"))) return;
  return command({ type: "START", force: true });
};

$("refreshCatalogViews").onclick = () => command({ type: "REFRESH_CATALOG_VIEWS" });
$("completeCatalogs").onclick = () => command({ type: "COMPLETE_CATALOGS" });

$("dependencyCheck").onclick = async () => {
  const res = await command({ type: "DEPENDENCY_CHECK" });
  if (res?.ok) alert(JSON.stringify(res.stats, null, 2));
};

$("fetchMissingDeps").onclick = async () => {
  const preview = await command({ type: "FETCH_MISSING_PREVIEW" });
  if (!preview?.ok) return;
  if (!preview.count) return alert(ui("No known missing targets", "Keine bekannten fehlenden Ziele"));
  if (!confirm(`${preview.count} ${ui("known target(s) will be fetched. Continue?", "bekannte Ziele werden geholt. Fortfahren?")}`)) return;
  await command({ type: "FETCH_MISSING" });
};


$("reset").onclick = async () => {
  if (!confirm(ui("Delete captured browser data, resources and pending writes for this profile? Profile rules and files in the library folder remain.", "Erfasste Browserdaten, Ressourcen und ausstehende Schreibaufträge dieses Profils löschen? Profilregeln und Dateien im Bibliotheksordner bleiben erhalten."))) return;
  const res = await command({ type: "RESET" });
  if (res?.ok) alert(`${res.removed} ${ui("record(s) deleted.", "Datensätze gelöscht.")}`);
  await renderStorage();
};

/* The broadcast covers everything that happens while this tab is open; the
   poll only catches the gap between opening the tab and the first message. */
/* Printed so a report like "it still fails" can be tied to a build; twice now a
   fix was tested against a version that was not the one loaded. */
$("buildVersion").textContent = `v${chrome.runtime.getManifest().version}`;
$("versionNotice").hidden=!needsReload;
$("versionMessage").textContent=ui("An extension update is ready. Stop the current sync, then reload the extension to use matching program files.","Ein Update ist bereit. Stoppe den laufenden Sync und lade die Extension neu, damit alle Programmteile zusammenpassen.");
$("reloadExtension").textContent=ui("Reload extension","Extension neu laden");
// Status stays live while optional settings or storage checks are pending.
setInterval(pullState, 4000);
setInterval(renderActivity, 1000);
const refreshDetails=()=>Promise.allSettled([renderOptions(),renderStorage()]);
setInterval(refreshDetails,10000);
refreshDetails();pullState();
send({type:"COUNT"}).then(res=>{if(res?.ok)pullState();}).catch(()=>{});
