import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import completion from '../../completion.js';
import history from '../../history-discord.js';

const html=readFileSync(new URL('../../index.html',import.meta.url),'utf8');
function section(from,to){
  const start=html.indexOf(from),end=html.indexOf(to,start);
  assert.ok(start>=0 && end>start,`frontend section exists: ${from}`);
  return html.slice(start,end);
}
const clone=value=>JSON.parse(JSON.stringify(value));
function app(){
  const writes=[],timers=new Map(),elements=new Map(),transactions=[];
  const auth={currentUser:{uid:'google-user-1'}};
  const c=vm.createContext({console,APP_CONFIG:{assignees:['きむち','しぶ','いつ','いちご'],workBranches:['dev/codex-work'],discordNotificationsEnabled:true},
    window:{ALIUS_TERRA_COMPLETION:completion,ALIUS_TERRA_HISTORY_DISCORD:{...history}},
    firebaseReady:true,firebaseAuth:auth,firebase:{auth:()=>auth,database:{ServerValue:{TIMESTAMP:{'.sv':'timestamp'}}}},
    boardRef:{async update(value){writes.push(clone(value));}},localStorage:{getItem:()=>null},
    document:{body:{contains:()=>true},querySelectorAll:()=>[],getElementById:id=>elements.get(id) || null},
    setTimeout:(fn,delay)=>{const id=timers.size+1;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id),
    setSyncStatus(){},renderHistory(){},render(){},requestAnimationFrame:fn=>fn(),
    didFirstRender:true,pendingRenderFromServer:false,shouldDeferServerData:()=>false,TextEncoder,crypto:webcrypto,
  });
  c.run=source=>vm.runInContext(source,c);
  c.run(section('const ASSIGNEES =','/* ===================== ツリー操作'));
  for(const [from,to] of [
    ['function getContainer(','function addRootTask('],['function setField(','function buildRows('],
    ['function nextHistoryCreatedAt(','function addHistoryEntry('],['function compareHistoryEntries(','function createWorkBranchSelect('],
    ['function makeDebugIssue(','function addDebugIssue('],['function bindDebugTitleInput(','function renderDebugSheet('],
    ['function makeAgendaItem(','function addAgendaItem('],['function bindAgendaTitleInput(','function renderAgendaSheet('],
    ['const historyComposingIds =','function stopHistoryDiscordSync('],['function normalizeSheetStatus(','function isTypingActive('],
  ])c.run(section(from,to));
  elements.set('historyDiscordNote',{textContent:''});
  c.run('historyDiscordQueueLoaded=true;historyDiscordReceiptsLoaded=true');
  function installQueue(){
    c.queueRef={child:key=>({async transaction(update){
      transactions.push(key);const previous=c.run('historyDiscordQueue')[key] || null;
      const value=update(previous);return {snapshot:{val:()=>value===undefined?previous:clone(value)}};
    }})};c.run('historyDiscordQueueRef=queueRef');
  }
  function input(value,binder){
    const handlers={};
    const element={value,addEventListener:(name,fn)=>(handlers[name] ||= []).push(fn),
      fire(name,event={}){for(const fn of handlers[name] || [])fn({target:this,currentTarget:this,...event});},blur(){this.fire('blur');}};
    c.element=element;c.run(binder);return element;
  }
  return {c,writes,timers,transactions,auth,run:c.run,input,installQueue};
}
test('scripts parse; only the three requested tabs are present; Google sign-in remains',()=>{
  for(const [,script] of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))if(script.trim())new vm.Script(script);
  assert.deepEqual([...html.matchAll(/data-tool-tab="([^"]+)"/g)].map(m=>m[1]),['tasks','debug','agenda']);
  assert.ok(!/header-slideshow\.js|bonusTabBtn|quoteCatalog/.test(html));
  assert.ok(html.includes('googleSignInBtn') && html.includes('onAuthStateChanged'));
  assert.ok(!html.includes('signInAnonymously'));
});
test('legacy completed data hydrates Japanese debug states, hierarchy and categories without writing or backfilling',()=>{
  const a=app();a.c.incoming={rootOrder:['t1'],tasks:{t1:{id:'t1',name:'過去の完了',status:100,color:'#123456',childOrder:['t2']},t2:{name:'子',status:33}},
    history:{h1:{id:'h1',content:'既存履歴',repo:'イラスト',date:'2026-10-12'}},
    debugIssues:{d1:{title:'旧解決',status:'解決済み',resolvedDate:'2026-10-01'},d2:{status:'対応中'},d3:{status:'確認待ち'},d4:{status:'未対応'}},
    agendaItems:{a1:{title:'議題',summary:'既存概要',status:'resolved',completedDate:'2026-10-02'}},historyNotifications:{h1:{trigger:'manual'}}};
  const before=clone(a.c.incoming);a.run('applyServerData(incoming);doSave()');assert.deepEqual(clone(a.c.incoming),before);
  assert.equal(a.run('state.tasks[0].children[0].name'),'子');assert.equal(a.run('state.tasks[0].color'),'#123456');
  assert.equal(a.run('state.tasks[0].repo'),'');assert.equal(a.run('state.tasks[0].priority'),'medium');
  assert.deepEqual(clone(a.run('state.debugIssues.map(x=>x.status)')),['resolved','working','verifying','open']);
  assert.equal(a.run('state.debugIssues[0].assignee'),'');assert.equal(a.run('state.agendaItems[0].summary'),'既存概要');
  assert.equal(a.run('state.history.length'),1);assert.equal(a.run('state.history[0].repo'),'イラスト');assert.equal(a.writes.length,0);
});
test('branch, priority and responders survive an isolated update and reload',()=>{
  const a=app();a.run("state.tasks=[makeTask({id:'t1',repo:'dev/codex-work',priority:'high'})];state.debugIssues=[{id:'d1',title:'問題',status:'working',assignee:'しぶ'}];state.agendaItems=[{id:'a1',title:'議題',status:'open',assignee:'いちご'}];markTaskDirty('t1');markDebugIssueDirty('d1');markAgendaItemDirty('a1');doSave()");
  assert.deepEqual(Object.keys(a.writes[0]).sort(),['agendaItems/a1','debugIssues/d1','tasks/t1']);
  a.c.saved={rootOrder:['t1'],tasks:{t1:a.writes[0]['tasks/t1']},debugIssues:{d1:a.writes[0]['debugIssues/d1']},agendaItems:{a1:a.writes[0]['agendaItems/a1']}};
  a.run('applyServerData(saved)');assert.equal(a.run('state.tasks[0].repo'),'dev/codex-work');assert.equal(a.run('state.tasks[0].priority'),'high');
  assert.equal(a.run('state.debugIssues[0].assignee'),'しぶ');assert.equal(a.run('state.agendaItems[0].assignee'),'いちご');
});
test('signed-out state never writes pending data or reserves manual notifications',async()=>{
  const a=app();a.installQueue();a.run("state.history=[{id:'h1',content:'履歴',date:'2026-11-18'}];markHistoryDirty('h1')");
  a.auth.currentUser=null;a.run('scheduleSave();saveNow();doSave()');await a.run("registerHistoryForDiscord('h1')");
  assert.equal(a.writes.length,0);assert.equal(a.transactions.length,0);assert.equal(a.timers.size,0);
});
test('a newly applied Firebase snapshot replaces deferred old data before focusout can replay it',()=>{
  const a=app();let typing=true;
  Object.assign(a.c,{databaseValueListener:null,firebaseResponseTimer:null,authState:'ready',AUTH_STATE:{DATABASE_READY:'ready'},shouldDeferServerData:()=>typing});
  a.c.boardRef.on=()=>{};
  a.run(section('function startFirebaseSync(){','if(firebaseAuth){'));
  a.run('startFirebaseSync()');
  a.c.databaseValueListener({val:()=>({agendaItems:{a1:{title:'旧議題',summary:'編集中に届いた古い概要',status:'open'}}})});
  assert.equal(a.run('pendingRenderFromServer'),true);
  typing=false;
  a.c.databaseValueListener({val:()=>({agendaItems:{a1:{title:'保存した議題',summary:'保存後の最新概要',status:'open'}}})});
  a.run('applyPendingServerData()');
  assert.equal(a.run('state.agendaItems[0].title'),'保存した議題');
  assert.equal(a.run('state.agendaItems[0].summary'),'保存後の最新概要');
  assert.equal(a.run('pendingRenderFromServer'),false);assert.equal(a.writes.length,0);
});
for(const kind of ['task','history','debug','agenda'])test(`${kind}: IME does not save intermediate conversion and Enter commits the final full text`,()=>{
  const a=app();a.run("state.tasks=[makeTask({id:'t1',name:'前の内容'})];state.history=[{id:'h1',content:'前の内容',date:'2026-11-18'}];state.debugIssues=[{id:'d1',title:'前の内容',status:'open'}];state.agendaItems=[{id:'a1',title:'前の内容',status:'open'}]");
  const binder={task:"bindSynchronizedTextInput(element,value=>setField([0],'name',value))",history:"bindHistoryTextInput(element,'h1','content')",debug:"bindDebugTitleInput(element,'d1')",agenda:"bindAgendaTitleInput(element,'a1')"}[kind];
  const input=a.input('前の内容',binder);input.fire('focus');input.value='前の内容を';input.fire('input');input.fire('compositionstart');
  input.value='へんかん';input.fire('input',{isComposing:true});a.run('doSave()');
  let prevented=false;input.fire('keydown',{key:'Enter',isComposing:true,preventDefault(){prevented=true;}});
  input.fire('keydown',{key:'Enter',keyCode:229,preventDefault(){prevented=true;}});assert.equal(prevented,false);assert.equal(a.writes.length,0);
  input.value='変換した最終全文';input.fire('compositionend');input.fire('keydown',{key:'Enter',preventDefault(){prevented=true;}});
  const path={task:'tasks/t1',history:'history/h1',debug:'debugIssues/d1',agenda:'agendaItems/a1'}[kind];assert.equal(prevented,true);
  assert.deepEqual(Object.keys(a.writes.at(-1)),[path]);assert.equal(a.writes.at(-1)[path][kind==='task'?'name':kind==='history'?'content':'title'],'変換した最終全文');assert.equal(a.transactions.length,0);
});
for(const kind of ['task','debug','agenda'])test(`${kind}: completion atomically writes one frozen automatic history and never duplicates on recompletion`,()=>{
  const a=app();a.run("state.tasks=[makeTask({id:'t1',name:'完了タスク',repo:'dev/codex-work',assignee:'いつ'})];state.debugIssues=[{id:'d1',title:'問題',status:'open',assignee:'しぶ',resolvedDate:''}];state.agendaItems=[{id:'a1',title:'議題',status:'open',assignee:'いちご',completedDate:''}]");
  const complete={task:"setField([0],'status',100)",debug:"setDebugIssueField('d1','status','resolved')",agenda:"setAgendaItemField('a1','status','resolved')"}[kind];
  const reopen={task:"setField([0],'status',33)",debug:"setDebugIssueField('d1','status','open')",agenda:"setAgendaItemField('a1','status','open')"}[kind];
  a.run(complete+';doSave()');const id={task:'t1',debug:'d1',agenda:'a1'}[kind],collection={task:'tasks',debug:'debugIssues',agenda:'agendaItems'}[kind];
  assert.deepEqual(Object.keys(a.writes[0]).sort(),[`${collection}/${id}`,`history/auto_${kind}_${id}`].sort());
  const entry=a.writes[0][`history/auto_${kind}_${id}`];assert.equal(entry.autoRegister,true);assert.deepEqual(entry.completion,{kind,id});
  assert.equal(entry.assignee,{task:'いつ',debug:'しぶ',agenda:'いちご'}[kind]);assert.equal(entry.completionSnapshot.content,entry.content);
  if(kind!=='task')assert.match(a.writes[0][`${collection}/${id}`][kind==='debug'?'resolvedDate':'completedDate'],/^\d{4}-\d{2}-\d{2}$/);
  a.run(reopen+';'+complete+';doSave()');assert.equal(a.run('state.history.length'),1);assert.ok(!Object.keys(a.writes.at(-1)).some(path=>path.startsWith('history/')));
});
test('priority order is high then medium then low with completed rows always last',()=>{
  const a=app();a.c.items=[{priority:'low',status:0},{priority:'high',status:100},{priority:'medium',status:0},{priority:'high',status:0}];a.run("items.sort(compareFn('priority'))");
  assert.deepEqual(a.c.items.map(x=>[x.priority,x.status]),[['high',0],['medium',0],['low',0],['high',100]]);
});
test('branch choices preserve old categories and exclude main without rewriting source values',()=>{
  const a=app();const old=a.run("workBranchOptions('イラスト')").find(option=>option.value==='イラスト');assert.equal(old.disabled,true);assert.match(old.label,/保存済み・候補外/);
  assert.equal(a.run("workBranchOptions('main').some(x=>x.value==='main')"),false);assert.deepEqual(clone(a.run("workBranchOptions('').map(x=>x.value)")),['','dev/codex-work']);
});
test('rapid additions remain newest-first after reload and legacy histories retain date order',()=>{
  const a=app();a.run("state.history=[{id:'old1',date:'2026-01-01'},{id:'old2',date:'2099-12-31'}]");
  const first=a.run('nextHistoryCreatedAt()');a.run(`state.history.push({id:'new1',createdAt:${first},date:'2026-01-01'})`);const second=a.run('nextHistoryCreatedAt()');assert.ok(second>first);
  a.run(`state.history.push({id:'new2',createdAt:${second},date:'2026-01-01'});state.history=JSON.parse(JSON.stringify(state.history));state.history.sort(compareHistoryEntries)`);
  assert.deepEqual(clone(a.run('state.history.map(x=>x.id)')),['new2','new1','old2','old1']);
});
test('legacy manual registrations display as registered until their content changes',async()=>{
  const a=app();a.run("state.history=[{id:'h1',content:'既存履歴',repo:'イラスト',assignee:'しぶ',date:'2026-10-12'}];legacyHistoryNotifications={h1:{trigger:'manual',operation:'saved',entry:{...state.history[0]}}}");
  const button={dataset:{},disabled:false};a.c.button=button;await a.run('refreshHistoryDiscordButton(button,state.history[0])');assert.equal(button.textContent,'登録済み');assert.equal(button.disabled,true);
  a.run("state.history[0].content='更新した履歴'");await a.run('refreshHistoryDiscordButton(button,state.history[0])');assert.equal(button.textContent,'未登録');assert.equal(button.disabled,false);assert.equal(a.writes.length,0);
});
test('manual registration uses one content key and creation metadata does not invalidate it',async()=>{
  const a=app();a.installQueue();a.run("state.history=[{id:'h1',content:'新しい履歴',repo:'dev/codex-work',assignee:'きむち',date:'2026-11-18'}]");
  await a.run("Promise.all([registerHistoryForDiscord('h1'),registerHistoryForDiscord('h1')])");assert.equal(a.transactions.length,1);assert.equal(a.writes.length,1);
  const entry=a.run('state.history[0]');assert.equal(await history.eventKey(entry),await history.eventKey({...entry,createdAt:1234}));assert.equal(a.run('Object.keys(historyDiscordQueue).length'),1);
});
test('logout while the notification content key is being computed prevents all writes',async()=>{
  const a=app();a.installQueue();a.run("state.history=[{id:'h1',content:'履歴',date:'2026-11-18'}]");
  let finishKey;a.c.window.ALIUS_TERRA_HISTORY_DISCORD.eventKey=()=>new Promise(resolve=>{finishKey=resolve;});
  const registering=a.run("registerHistoryForDiscord('h1')");a.auth.currentUser=null;finishKey('h1_hash');await registering;
  assert.equal(a.writes.length,0);assert.equal(a.transactions.length,0);
});
test('account change while saving a notification prevents reserving it under the next user',async()=>{
  const a=app();a.installQueue();a.run("state.history=[{id:'h1',content:'履歴',date:'2026-11-18'}]");
  a.c.window.ALIUS_TERRA_HISTORY_DISCORD.eventKey=async()=> 'h1_hash';
  let completeWrite;a.c.boardRef.update=value=>{a.writes.push(clone(value));return new Promise(resolve=>{completeWrite=resolve;});};
  const registering=a.run("registerHistoryForDiscord('h1')");await new Promise(resolve=>setImmediate(resolve));
  assert.equal(a.writes.length,1);a.auth.currentUser={uid:'different-user'};completeWrite();await registering;
  assert.equal(a.transactions.length,0);
});
test('panels remember independent settings, migrate the old history preference and keep history within one third',()=>{
  const elements={},stored=new Map([['aliusTerraTaskBoard.historyPanel','{"height":210,"state":"COLLAPSED"}']]),resizes=[];
  function el(id){return elements[id] ||= {hidden:false,contains:()=>false,style:{setProperty(k,v){this[k]=v;}},classList:{toggle(){}},listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},setAttribute(k,v){this[k]=v;}};}
  const c=vm.createContext({window:{innerHeight:900,addEventListener:(name,fn)=>resizes.push(fn)},document:{getElementById:el},localStorage:{getItem:key=>stored.get(key),setItem:(key,value)=>stored.set(key,value)}});
  vm.runInContext(section('function boardSectionMaxHeight(','function nextHistoryCreatedAt('),c);
  assert.equal(el('historyContent').hidden,true);assert.equal(el('historySection').style['--section-height'],'210px');el('historyToggle').listeners.click();el('taskToggle').listeners.click();
  assert.equal(el('historyContent').hidden,false);assert.equal(el('taskContent').hidden,true);el('historyResizer').listeners.keydown({key:'End',preventDefault(){}});assert.equal(el('historySection').style['--section-height'],'300px');
  c.window.innerHeight=600;resizes.forEach(fn=>fn());assert.equal(el('historySection').style['--section-height'],'200px');assert.equal(el('taskSection').style['--section-height'],'478px');
  c.window.innerHeight=300;resizes.forEach(fn=>fn());assert.equal(el('historySection').style['--section-height'],'100px');assert.equal(JSON.parse(stored.get('aliusTerraTaskBoard.taskPanel.v1')).closed,true);
});
