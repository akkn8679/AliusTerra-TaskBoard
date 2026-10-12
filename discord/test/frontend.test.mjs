import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
function app(update = ()=>Promise.resolve()){
  const writes = [];
  const timers = new Map();
  const context = vm.createContext({console, firebase:{database:{ServerValue:{TIMESTAMP:{'.sv':'timestamp'}}}},
    firebaseReady:true, firebaseAuth:{currentUser:{uid:'u1'}}, authState:'READY',
    AUTH_STATE:{DATABASE_READY:'READY'}, boardRef:{update:values=>{ writes.push(structuredClone(values)); return update(); }},
    document:{body:{contains:()=>true}},
    setTimeout:(fn,delay)=>{ const id=timers.size+1; timers.set(id,{fn,delay}); return id; },
    clearTimeout:id=>timers.delete(id), didFirstRender:true, pendingRenderFromServer:false,
  });
  const source = html.slice(html.indexOf('function newId(prefix)'), html.indexOf('/* ===================== ツリー操作'));
  vm.runInContext(source, context);
  vm.runInContext("currentUser='きむち'; state.history=[{id:'h1',content:'前の内容',repo:'Unity',assignee:'きむち',date:'2026-10-12'}];", context);
  function input(value){
    const handlers = {};
    const element = {value, addEventListener:(name,handler)=>{ handlers[name]=handler; },
      blur:()=>handlers.blur(), fire:(name,event={})=>handlers[name](event)};
    context.element = element;
    vm.runInContext("bindSynchronizedTextInput(element, value=>{state.history[0].content=value; markHistoryDirty('h1');}, null, ()=>queueHistoryNotification(state.history[0]));", context);
    return element;
  }
  return {context,writes,timers,input,run:source=>vm.runInContext(source,context)};
}
test('each inline script parses without changing app startup', ()=>{
  for(const [,script] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)){
    if(script.trim()) new vm.Script(script);
  }
});
test('typing and IME conversion do not notify; Enter after conversion atomically saves final text and notification', ()=>{
  const a = app();
  const input = a.input('前の内容');
  input.fire('focus');
  input.value = '作'; input.fire('input'); a.run('doSave()');
  assert.ok(!a.writes[0]['historyNotifications/h1']);
  input.fire('compositionstart');
  input.value='さぎょう'; input.fire('input',{isComposing:true});
  let prevented = false;
  input.fire('keydown',{key:'Enter',isComposing:true,preventDefault:()=>{ prevented=true; }});
  assert.equal(prevented,false);
  assert.equal(a.run('pendingHistoryNotifications.size'),0);
  input.value='作業完了'; input.fire('compositionend'); a.run('doSave()');
  assert.ok(!a.writes[1]['historyNotifications/h1']);
  input.fire('keydown',{key:'Enter',isComposing:false,preventDefault:()=>{ prevented=true; }});
  const final = a.writes.at(-1);
  assert.equal(final['history/h1'].content,'作業完了');
  assert.equal(final['historyNotifications/h1'].entry.content,'作業完了');
  assert.deepEqual(final['historyNotifications/h1'].committedAt,{'.sv':'timestamp'});
  assert.equal(final['historyNotifications/h1'].actor,'きむち');
  assert.equal(prevented,true);
});
test('blur without edits does not enqueue a notification, and keyCode 229 does not finalize', ()=>{
  const a = app(); const input=a.input('前の内容');
  input.fire('focus'); input.fire('keydown',{key:'Enter',keyCode:229,preventDefault:()=>assert.fail()});
  input.blur(); assert.equal(a.writes.length,0);
});
test('failed older write cannot restore its notification over a newer successful edit', async()=>{
  let rejectFirst;
  let count=0;
  const a=app(()=>++count === 1 ? new Promise((_,reject)=>{rejectFirst=reject;}) : Promise.resolve());
  a.run("queueHistoryNotification(state.history[0]); doSave();");
  a.run("state.history[0].content='新しい内容'; markHistoryDirty('h1'); queueHistoryNotification(state.history[0]); doSave();");
  const latest=a.writes[1]['historyNotifications/h1'].revision;
  rejectFirst(new Error('expected rejection'));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(a.run('pendingHistoryNotifications.size'),0);
  assert.equal(a.run("latestHistoryNotificationRevisions.get('h1')"),latest);
});
test('failed finalized save retains same revision and retries', async()=>{
  let count=0;
  const a=app(()=>++count===1 ? Promise.reject(new Error('expected rejection')) : Promise.resolve());
  a.run("markHistoryDirty('h1'); queueHistoryNotification(state.history[0]); doSave();");
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(a.run('pendingHistoryNotifications.size'),1);
  const retry=[...a.timers.values()].find(t=>t.delay===5000);
  assert.ok(retry); retry.fn();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(a.writes[0]['historyNotifications/h1'].revision,a.writes[1]['historyNotifications/h1'].revision);
});
