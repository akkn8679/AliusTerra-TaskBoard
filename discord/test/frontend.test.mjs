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
    document:{body:{contains:()=>true},querySelectorAll:()=>[],getElementById:()=>null},
    setTimeout:(fn,delay)=>{ const id=timers.size+1; timers.set(id,{fn,delay}); return id; },
    clearTimeout:id=>timers.delete(id), didFirstRender:true, pendingRenderFromServer:false,
  });
  const source = html.slice(html.indexOf('function newId(prefix)'), html.indexOf('/* ===================== ツリー操作'));
  vm.runInContext(source, context);
  vm.runInContext("currentUser='きむち'; state.history=[{id:'h1',content:'前の内容',repo:'Unity',assignee:'きむち',date:'2026-10-12'}];", context);
  function input(value, binding="value=>{state.history[0].content=value; markHistoryDirty('h1');}"){
    const handlers = {};
    const element = {value, addEventListener:(name,handler)=>{ handlers[name]=handler; },
      blur:()=>handlers.blur(), fire:(name,event={})=>handlers[name](event)};
    context.element = element;
    vm.runInContext('bindSynchronizedTextInput(element, '+binding+');', context);
    return element;
  }
  return {context,writes,timers,input,run:source=>vm.runInContext(source,context)};
}
test('each inline script parses without changing app startup', ()=>{
  for(const [,script] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)){
    if(script.trim()) new vm.Script(script);
  }
});
test('typing, IME conversion and Enter only save history; registration explicitly queues the final text', ()=>{
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
  assert.ok(a.writes.every(write=>!write['historyNotifications/h1']));
  a.run("registerHistoryEntry('h1')");
  const final = a.writes.at(-1);
  assert.equal(final['history/h1'].content,'作業完了');
  assert.equal(final['historyNotifications/h1'].entry.content,'作業完了');
  assert.deepEqual(final['historyNotifications/h1'].committedAt,{'.sv':'timestamp'});
  assert.equal(final['historyNotifications/h1'].actor,'きむち');
  assert.equal(final['historyNotifications/h1'].trigger,'manual');
  assert.equal(prevented,true);
});

test('registration is shared by snapshot, cannot be double-clicked, and edited fields require re-registration', async()=>{
  let complete;
  const a=app(()=>new Promise(resolve=>{complete=resolve;}));
  a.run("registerHistoryEntry('h1'); registerHistoryEntry('h1');");
  assert.equal(a.writes.length,1);
  assert.equal(a.run('getHistoryRegistrationState(state.history[0])'),'REGISTERING');
  complete(); await new Promise(resolve=>setImmediate(resolve));
  assert.equal(a.run('getHistoryRegistrationState(state.history[0])'),'REGISTERED');
  a.run("registerHistoryEntry('h1')");
  assert.equal(a.writes.length,1);
  const second=app();
  second.context.savedNotification=a.writes[0]['historyNotifications/h1'];
  second.run("registeredHistoryNotifications.set('h1',savedNotification)");
  assert.equal(second.run('getHistoryRegistrationState(state.history[0])'),'REGISTERED');
  for(const [field,value] of [['content','更新内容'],['repo','UI'],['assignee','しぶ'],['date','2026-10-13']]){
    second.run('state.history[0]['+JSON.stringify(field)+']='+JSON.stringify(value));
    assert.equal(second.run('getHistoryRegistrationState(state.history[0])'),'UNREGISTERED');
    second.run("registerHistoryEntry('h1')");
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(second.run('getHistoryRegistrationState(state.history[0])'),'REGISTERED');
  }
});

test('blank content, composing IME and signed-out state do not register', ()=>{
  const a=app();
  a.run("state.history[0].content='  '; registerHistoryEntry('h1')");
  a.run("state.history[0].content='入力途中'; textEditing.state=TEXT_EDIT_STATE.COMPOSING; registerHistoryEntry('h1')");
  a.run("resetTextEditingState(); firebaseAuth.currentUser=null; registerHistoryEntry('h1')");
  assert.equal(a.writes.length,0);
  assert.equal(a.run('pendingHistoryNotifications.size'),0);
});

test('automatic legacy snapshots do not show registered, and deleting a history does not enqueue a post', ()=>{
  const a=app();
  a.run("registeredHistoryNotifications.set('h1',{operation:'saved',entry:historyNotificationEntry(state.history[0])})");
  assert.equal(a.run('getHistoryRegistrationState(state.history[0])'),'UNREGISTERED');
  a.context.render=()=>{};
  const deletion=html.slice(html.indexOf('function deleteHistoryEntry(id)'),html.indexOf('function renderHistory()'));
  vm.runInContext(deletion,a.context);
  a.run("deleteHistoryEntry('h1'); doSave()");
  assert.equal(a.writes[0]['history/h1'],null);
  assert.ok(a.writes.every(write=>!write['historyNotifications/h1']));
});

test('failed registration stays unregistered and the original request retries without another notification ID', async()=>{
  let count=0;
  const a=app(()=>++count===1 ? Promise.reject(new Error('expected rejection')) : Promise.resolve());
  a.run("registerHistoryEntry('h1')");
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(a.run('getHistoryRegistrationState(state.history[0])'),'ERROR');
  const retry=[...a.timers.values()].find(t=>t.delay===5000);
  assert.ok(retry); retry.fn();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(a.run('getHistoryRegistrationState(state.history[0])'),'REGISTERED');
  assert.equal(a.writes[0]['historyNotifications/h1'].revision,a.writes[1]['historyNotifications/h1'].revision);
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

test('agenda IME commits only final text to its own collection and never queues Discord', ()=>{
  const a=app();
  a.run("state.agendaItems=[{id:'a1',title:'前の議題',summary:'概要',status:'open',openedDate:'2026-10-12',completedDate:''}]");
  const input=a.input('前の議題', "value=>{state.agendaItems[0].title=value; markAgendaItemDirty('a1');}");
  input.fire('focus'); input.fire('compositionstart');
  input.value='ぎだい'; input.fire('input',{isComposing:true}); a.run('doSave()');
  assert.equal(a.writes.length,0);
  input.value='議題の最終全文'; input.fire('compositionend'); input.blur();
  assert.deepEqual(Object.keys(a.writes.at(-1)),['agendaItems/a1']);
  assert.equal(a.writes.at(-1)['agendaItems/a1'].title,'議題の最終全文');
  assert.equal(a.writes.at(-1)['agendaItems/a1'].summary,'概要');
  assert.equal(a.run('pendingHistoryNotifications.size'),0);
});

test('agenda deletion removes only its item, preserving histories and debug items', ()=>{
  const a=app(); a.context.render=()=>{};
  a.run("state.agendaItems=[{id:'a1',title:'議題'},{id:'a2',title:'別の議題'}]; state.debugIssues=[{id:'d1',title:'問題'}]");
  vm.runInContext(html.slice(html.indexOf('function findAgendaItem(id)'),html.indexOf('function renderAgendaItems()')),a.context);
  a.run("const agendaModal={itemId:null}; deleteAgendaItem('a1')");
  assert.deepEqual(a.writes,[{'agendaItems/a1':null}]);
  assert.equal(a.run('state.history[0].id'),'h1');
  assert.equal(a.run('state.debugIssues[0].id'),'d1');
  assert.equal(a.run('state.agendaItems[0].id'),'a2');
});

test('server snapshots restore agenda status, dates and overview separately from debug data', ()=>{
  const a=app();
  a.context.todayStr=()=>'2026-10-12';
  vm.runInContext(html.slice(html.indexOf('function applyServerData(data)'),html.indexOf('function isTypingActive()')),a.context);
  a.context.snapshot={agendaItems:{a1:{title:'議題',summary:'共有する概要',status:'working',openedDate:'2026-10-11',completedDate:'2026-10-13'},a2:{status:'invalid'},removed:null},debugIssues:{d1:{title:'不具合'}}};
  a.run('applyServerData(snapshot)');
  assert.equal(a.run('state.agendaItems.length'),2);
  assert.deepEqual(JSON.parse(a.run('JSON.stringify(state.agendaItems[0])')),{id:'a1',title:'議題',summary:'共有する概要',status:'working',openedDate:'2026-10-11',completedDate:'2026-10-13'});
  assert.equal(a.run('state.agendaItems[1].status'),'open');
  assert.equal(a.run('state.debugIssues[0].title'),'不具合');
  a.run('applyServerData({})');
  assert.equal(a.run('state.agendaItems.length'),0);
});
