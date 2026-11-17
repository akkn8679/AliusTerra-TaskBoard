(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.ALIUS_TERRA_COMPLETION = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';
  const labels = {task:'タスク完了',debug:'不具合解決',agenda:'議題完了'};
  function historyId(kind, id){
    if(!labels[kind] || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error('COMPLETION_SOURCE_INVALID');
    return 'auto_' + kind + '_' + id;
  }
  function createHistory(kind, item, date){
    const id = historyId(kind,item.id);
    const snapshot = {id,content:'【'+labels[kind]+'】'+(kind==='task' ? item.name : item.title),
      repo:String(item.repo || ''),assignee:String(item.assignee || '未設定'),date};
    return {...snapshot,createdAt:Date.now(),autoRegister:true,completion:{kind,id:item.id},completionSnapshot:{...snapshot}};
  }
  return {historyId,createHistory};
});
