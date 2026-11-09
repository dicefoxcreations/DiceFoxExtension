(() => {
  'use strict';
  // DiceFox's interface is English regardless of the browser's UI language.
  const lang='en',isGerman=false;
  const t=(key,substitutions)=>chrome.i18n.getMessage(key,substitutions)||key;
  function apply(root=document){
    root.querySelectorAll('[data-i18n]').forEach(element=>{
      const value=t(element.dataset.i18n);if(!value)return;
      if(element.matches('input[placeholder],textarea[placeholder]'))element.placeholder=value;
      else element.textContent=value;
    });
    document.documentElement.lang='en';
  }
  globalThis.LWLI18n=Object.freeze({lang,isGerman,t,apply});
})();
