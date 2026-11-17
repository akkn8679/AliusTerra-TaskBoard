(function(root, factory){
  const api = factory();
  if(typeof module === 'object' && module.exports) module.exports = api;
  else root.ALIUS_TERRA_HISTORY_DISCORD = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function(){
  'use strict';
  function snapshot(entry){
    return {id:String(entry.id || ''), content:String(entry.content || ''),
      repo:String(entry.repo || ''), assignee:String(entry.assignee || ''), date:String(entry.date || '')};
  }
  function signature(entry){ return JSON.stringify(snapshot(entry)); }
  function validate(entry){
    const value = snapshot(entry);
    if(!/^[A-Za-z0-9_-]{1,100}$/.test(value.id)) throw new Error('履歴IDが不正です。');
    if(!value.content.trim()) throw new Error('作業内容を入力してから登録してください。');
    if(value.content.length > 10000 || value.repo.length > 200 || value.assignee.length > 100){
      throw new Error('通知できる文字数の上限を超えています。');
    }
    if(!/^\d{4}-\d{2}-\d{2}$/.test(value.date)) throw new Error('編集日を確認してください。');
    return value;
  }
  async function eventKey(entry, cryptoApi){
    const value = validate(entry);
    const digest = await (cryptoApi || globalThis.crypto).subtle.digest(
      'SHA-256', new TextEncoder().encode(signature(value)));
    const hash = Array.from(new Uint8Array(digest), byte=>byte.toString(16).padStart(2,'0')).join('');
    return value.id + '_' + hash;
  }
  function registrationState(key, queue, receipts){
    const receipt = receipts && receipts[key];
    if(receipt && receipt.status === 'sent') return 'sent';
    if(receipt && (receipt.status === 'error' || receipt.status === 'uncertain')) return receipt.status;
    return queue && queue[key] ? 'pending' : 'unregistered';
  }
  return {snapshot, signature, validate, eventKey, registrationState};
});
