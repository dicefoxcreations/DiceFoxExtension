/* Chrome owns pinning; DiceFox only controls which tabs enable its action. */
(() => {
  'use strict';
  const supported = value => {
    try {
      const u = new URL(value);
      return u.protocol === 'https:' && (u.hostname === 'dndbeyond.com' || u.hostname.endsWith('.dndbeyond.com'));
    } catch { return false; }
  };
  async function update(tab) {
    if (!chrome.action || !Number.isInteger(tab?.id)) return;
    try {
      if (supported(tab.url)) await chrome.action.enable(tab.id);
      else await chrome.action.disable(tab.id);
      await chrome.sidePanel?.setOptions({tabId:tab.id,path:'popup.html?tab='+tab.id,enabled:supported(tab.url)});
    } catch { /* tab closed while its URL changed */ }
  }
  async function refresh() {
    if (!chrome.action) return;
    await chrome.action.disable();
    await chrome.sidePanel?.setOptions({path:'popup.html',enabled:false});
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(tabs.map(update));
  }
  function open(tab){
    // Keep Chrome's user activation: open before awaiting any other API.
    if(!supported(tab?.url))return Promise.resolve();
    return chrome.sidePanel.open({tabId:tab.id}).then(()=>
      chrome.runtime.sendMessage?.({target:'selection',type:'REFRESH',tabId:tab.id}).catch(()=>{}));
  }
  globalThis.DiceFoxSiteAction = Object.freeze({supported, update, refresh, open});
  if (chrome.action) {
    chrome.tabs.onUpdated.addListener((id, info, tab) => {
      if (info.url || info.status === 'complete') update({...tab,id}).catch(() => {});
    });
    chrome.tabs.onActivated.addListener(({tabId}) => chrome.tabs.get(tabId).then(update).catch(() => {}));
    chrome.runtime.onInstalled.addListener(() => refresh().catch(() => {}));
    chrome.runtime.onStartup.addListener(() => refresh().catch(() => {}));
    chrome.action.onClicked?.addListener(tab=>open(tab).catch(error=>{
      chrome.action.setBadgeText?.({text:'!'});
      chrome.action.setTitle?.({title:'DiceFox: '+String(error.message||error)});
    }));
    refresh().catch(() => {});
  }
})();
