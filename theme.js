(function(){
  'use strict';
  const storageKey='aliusTerraTaskBoard.theme.v1';
  function normalize(value){return value==='dark' ? 'dark' : 'light';}
  let theme='light';
  try{theme=normalize(localStorage.getItem(storageKey));}catch{}
  function apply(value,persist){
    theme=normalize(value);
    document.documentElement.dataset.theme=theme;
    const button=document.getElementById('themeToggle');
    if(button){
      const dark=theme==='dark';
      button.textContent=dark ? '☾' : '☀';
      button.setAttribute('aria-pressed',String(dark));
      button.setAttribute('aria-label',dark ? 'ライトモードに切り替え' : 'ダークモードに切り替え');
      button.title=dark ? 'ダークモード（クリックでライトモード）' : 'ライトモード（クリックでダークモード）';
    }
    if(persist){try{localStorage.setItem(storageKey,theme);}catch{}}
  }
  // CSS・本文の描画前に適用する。保存不可でも既定のライトでツールを使える。
  apply(theme,false);
  function bind(){
    const button=document.getElementById('themeToggle');
    if(!button) return;
    apply(theme,false);
    button.addEventListener('click',()=>apply(theme==='dark' ? 'light' : 'dark',true));
  }
  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',bind,{once:true});
  else bind();
  window.addEventListener('storage',event=>{
    if(event.key===storageKey) apply(event.newValue,false);
  });
})();
