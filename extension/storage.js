"use strict";
const $ = id => document.getElementById(id), ui = (en,de) => LWLI18n.isGerman ? de : en;
LWLI18n.apply();
const send = msg => chrome.runtime.sendMessage({target:"background",...msg});
const formatBytes = value => {
  let n = Number(value)||0, unit=0;const units=["B","KiB","MiB","GiB","TiB"];
  while(n>=1024&&unit<units.length-1){n/=1024;unit++;}
  return `${n.toLocaleString(undefined,{maximumFractionDigits:unit?1:0})} ${units[unit]}`;
};
let overview=null,working=false,initialScope=new URLSearchParams(location.search).get("profile");
const notice=(text,error=false)=>{$("notice").textContent=text;$("notice").classList.toggle("error",error);};
function cell(row,text){const td=document.createElement("td");td.textContent=text;row.append(td);return td;}
function emptyRow(host,columns,text){const row=document.createElement("tr");const td=cell(row,text);td.colSpan=columns;host.append(row);}
function controls(){
  const busy=working||overview?.busy,scope=overview?.profiles.find(p=>p.id===$("scope").value);
  for(const id of ["unused","resources","reset","discardProfile"])$(id).disabled=Boolean(busy||!scope);
  $("resources").disabled ||= !scope?.resourceBytes;
  $("discardProfile").disabled ||= !scope?.writes;
  for(const id of ["temporary","discardAll"])$(id).disabled=Boolean(busy);
  $("temporary").disabled ||= !overview?.temporaryBytes;
  $("discardAll").disabled ||= !overview?.writes.length;
  $("refresh").disabled=working;$("scope").disabled=working;
  $("busyNotice").hidden=!overview?.busy;
  $("busyReason").textContent=overview?.busyReason||ui("A task is running. Stop synchronization or wait until it finishes to delete browser data.","Ein Vorgang läuft. Stoppe die Synchronisierung oder warte auf das Ende, um Browserdaten zu löschen.");
  $("stopSync").hidden=!overview?.canStop;
  $("stopSync").disabled=working;
  $("scopeInfo").textContent=scope?(scope.orphan?ui("This profile was removed; its captured browser data is still present.","Dieses Profil wurde entfernt; seine erfassten Browserdaten sind noch vorhanden."):ui("Captured data and cached resources for ","Erfasste Daten und Ressourcen-Cache für ")+scope.name)+" · "+formatBytes(scope.totalBytes):ui("No captured profiles.","Keine erfassten Profile.");

}
async function refresh(force=true){
  const result=await send({type:"STORAGE_OVERVIEW",force});
  if(!result?.ok)throw new Error(result?.error||"Storage unavailable");
  overview=result;
  for(const field of ["localBytes","resourceBytes","writeBytes","totalBytes"])$(field).textContent=formatBytes(result[field]);
  $("autoCleanup").checked=result.autoCleanup;
  const selection=$("scope").value||initialScope||result.activeProfileId;initialScope=null;$("scope").replaceChildren();$("profiles").replaceChildren();
  for(const p of result.profiles){
    const option=document.createElement("option");option.value=p.id;option.textContent=p.name+(p.orphan?ui(" (removed profile)"," (entferntes Profil)"):"");$("scope").append(option);
    const row=document.createElement("tr");cell(row,option.textContent).classList.toggle("orphan",p.orphan);
    for(const value of [p.localBytes,p.resourceBytes,p.writeBytes,p.totalBytes])cell(row,formatBytes(value));$("profiles").append(row);
  }
  if(result.profiles.some(p=>p.id===selection))$("scope").value=selection;
  if(!result.profiles.length)emptyRow($("profiles"),5,ui("No captured data.","Keine erfassten Daten."));
  $("writes").replaceChildren();
  for(const write of result.writes){const row=document.createElement("tr");cell(row,write.path);cell(row,result.profiles.find(p=>p.id===write.profileId)?.name||ui("Unassigned","Nicht zugeordnet"));cell(row,write.folderName||ui("Previously selected folder","Bisher gewählter Ordner"));cell(row,formatBytes(write.bytes));$("writes").append(row);}
  if(!result.writes.length)emptyRow($("writes"),4,ui("No unfinished writes.","Keine ausstehenden Schreibvorgänge."));
  $("temporaryInfo").textContent=ui("Detection and diagnostic data: ","Erkennungs- und Diagnosedaten: ")+formatBytes(result.temporaryBytes)+ui(". Inactive data expires after 7 days when automatic cleanup runs.",". Inaktive Daten werden bei der automatischen Bereinigung nach 7 Tagen entfernt.");
  controls();
}
async function perform(action,global=false){
  const profileId=global?null:$("scope").value;
  const name=overview?.profiles.find(p=>p.id===profileId)?.name||"";
  const warnings={
    resources:ui(`Clear all cached images, fonts and resource files for '${name}'? Captured text remains. Sending pictures again may require loading the websites.`,`Alle zwischengespeicherten Bilder, Schriften und Ressourcendateien für „${name}“ löschen? Erfasste Texte bleiben erhalten. Für das erneute Senden von Bildern kann ein Laden der Webseiten nötig sein.`),
    reset:ui(`Delete all captured browser data and pending writes for '${name}'? The profile rules and files in your library folder remain.`,`Alle erfassten Browserdaten und ausstehenden Schreibaufträge für „${name}“ löschen? Die Profilregeln und Dateien im Bibliotheksordner bleiben erhalten.`),
    discard:ui("Discard these unfinished writes? They will no longer be written automatically. Captured browser data remains.","Diese ausstehenden Schreibaufträge verwerfen? Sie werden danach nicht mehr automatisch geschrieben. Erfasste Browserdaten bleiben erhalten."),
    temporary:ui("Clear detection and diagnostic data, including unfinished detection checkpoints? Saved profiles and library content remain.","Erkennungs- und Diagnosedaten einschließlich unterbrochener Erkennungsfortschritte löschen? Gespeicherte Profile und Bibliotheksinhalte bleiben erhalten.")
  };
  if(warnings[action]&&!confirm(warnings[action]))return;
  working=true;controls();notice(ui("Cleaning…","Bereinigung läuft…"));
  try{
    const result=await send({type:"STORAGE_MAINTAIN",action,profileId});
    if(!result?.ok)throw new Error(result?.error||"Cleanup failed");
    let text=ui("Removed: ","Entfernt: ")+result.removed+ui(" entries · "," Einträge · ")+formatBytes(result.bytes);
    if(result.files!=null)text+=ui("\nReader files: ","\nReader-Dateien: ")+result.files+" · "+formatBytes(result.fileBytes);
    if(result.keptFiles)text+=ui("\nModified or unavailable files retained: ","\nGeänderte oder nicht zugängliche Dateien beibehalten: ")+result.keptFiles;
    if(result.folderNotice)text+="\n"+result.folderNotice;
    notice(text);await refresh();
  }catch(error){notice(error.message,true);}
  finally{working=false;controls();}
}
$("scope").onchange=controls;
$("refresh").onclick=()=>refresh().catch(error=>notice(error.message,true));
$("stopSync").onclick=async()=>{
  try{
    $("stopSync").disabled=true;
    const result=await send({type:"STOP"});
    if(!result?.ok)throw new Error(result?.error||"Could not stop synchronization");
    notice(ui("Stopping synchronization. Cleanup becomes available when it has finished.","Die Synchronisierung wird gestoppt. Sobald sie beendet ist, wird die Bereinigung freigegeben."));
    await refresh();
  }catch(error){notice(error.message,true);}
};
for(const action of ["unused","resources","reset"])$(action).onclick=()=>perform(action);
$("temporary").onclick=()=>perform("temporary",true);
$("discardAll").onclick=()=>perform("discard",true);
$("discardProfile").onclick=()=>perform("discard");
$("autoCleanup").onchange=async()=>{try{const res=await send({type:"SET_STORAGE_OPTIONS",autoCleanup:$("autoCleanup").checked});if(!res?.ok)throw new Error(res?.error);await refresh();}catch(error){notice(error.message,true);}};

$("version").textContent="v"+chrome.runtime.getManifest().version;
refresh().catch(error=>notice(error.message,true));
setInterval(async()=>{try{const res=await send({type:"GET_STATE"});if(overview&&res?.ok){
  const wasBusy=overview.busy;
  Object.assign(overview,res.maintenance||{busy:res.state.running,canStop:res.state.running});
  controls();if(wasBusy&&!overview.busy&&!working)await refresh();
}}catch{}},2000);
