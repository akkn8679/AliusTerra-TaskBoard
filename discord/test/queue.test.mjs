import test from 'node:test';
import assert from 'node:assert/strict';
import {QueueProcessor,historyEventKey,historySnapshot} from '../src/queue.mjs';
import {DeliveryError,HistoryProcessor} from '../src/notifier.mjs';

class Storage {
  constructor(){ this.values = new Map(); }
  async get(key){ return structuredClone(this.values.get(key)); }
  async put(key,value){
    if(typeof key === 'object') for(const [k,v] of Object.entries(key)) this.values.set(k,structuredClone(v));
    else this.values.set(key,structuredClone(value));
  }
  async delete(keys){ for(const key of [].concat(keys)) this.values.delete(key); }
}
class Firebase {
  constructor(data={}){ this.data=structuredClone(data); this.calls=[]; }
  async request(path,method='GET',body){
    this.calls.push({path,method,body:structuredClone(body)});
    const segments=path.split('/'); let parent=this.data;
    for(const segment of segments.slice(0,-1)) parent=parent[segment] ||= {};
    const key=segments.at(-1);
    if(method==='PUT') parent[key]=structuredClone(body);
    if(method==='PATCH') parent[key]={...parent[key],...structuredClone(body)};
    return structuredClone(parent[key] || null);
  }
}
const env={DISCORD_WEBHOOK_URL:'https://discord.com/api/webhooks/123/test-token',BOARD_URL:'https://example.com/'};
const entry={id:'h1',content:'作業完了',repo:'dev/work',assignee:'きむち',date:'2026-11-18'};
async function queued(value=entry){
  const key=await historyEventKey(value);
  return {key,job:{historyId:value.id,snapshot:value,requestedAt:1000,requestedBy:'tester',status:'pending'}};
}
function processor(firebase,storage=new Storage(),deliver=async()=> 'message',now=()=>1000){
  return new QueueProcessor({firebase,storage,env,deliver,now});
}

test('queue hash matches browser snapshot order and changes when registered text changes',async()=>{
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(historySnapshot(entry))));
  const expected='h1_'+Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
  assert.equal(await historyEventKey(entry),expected);
  assert.notEqual(await historyEventKey({...entry,content:'修正後'}),expected);
});
test('queue delivery confirms once and repairs receipt after interrupted acknowledgement without reposting',async()=>{
  const {key,job}=await queued(); const firebase=new Firebase({historyDiscordQueue:{[key]:job}});
  const storage=new Storage(); let sent=0;
  const original=firebase.request.bind(firebase); let failReceipt=true;
  firebase.request=async(path,...args)=>{
    if(path.startsWith('historyDiscordReceipts/') && failReceipt) throw new Error('temporary receipt failure');
    return original(path,...args);
  };
  let p=processor(firebase,storage,async()=>{sent++;return 'confirmed';});
  await assert.rejects(p.run());
  failReceipt=false;
  p=processor(firebase,storage,async()=>{sent++;return 'wrong';});
  await p.run(); await p.run();
  assert.equal(sent,1); assert.equal(firebase.data.historyDiscordReceipts[key].status,'sent');
  assert.equal(firebase.data.historyDiscordReceipts[key].messageId,'confirmed');
});
test('unconfirmed queue sends become uncertain and never automatically resend',async()=>{
  const {key,job}=await queued(); const firebase=new Firebase({historyDiscordQueue:{[key]:job}});
  let sent=0; const p=processor(firebase,new Storage(),async()=>{sent++;throw new Error('network interrupted');});
  assert.deepEqual(await p.run(),{uncertain:1}); await p.run();
  assert.equal(sent,1); assert.equal(firebase.data.historyDiscordReceipts[key].code,'DISCORD_RESULT_UNKNOWN');
});
test('persisted sending lease becomes uncertain after a restart rather than repeating the post',async()=>{
  const {key,job}=await queued(); const firebase=new Firebase({historyDiscordQueue:{[key]:job}});
  const storage=new Storage(); await storage.put('delivery:'+key,{status:'sending',startedAt:1000});
  const p=processor(firebase,storage,()=>assert.fail('must not resend'),()=>2000);
  assert.deepEqual(await p.run(),{waiting:1}); p.now=()=>121000;
  assert.deepEqual(await p.run(),{uncertain:1});
});
test('rate limits wait before retrying while malformed jobs never reach Discord',async()=>{
  const {key,job}=await queued(); const firebase=new Firebase({historyDiscordQueue:{[key]:job,bad:{...job}}});
  let now=0,attempts=0;
  const p=processor(firebase,new Storage(),async()=>{if(++attempts===1) throw new DeliveryError(429,120000);return 'confirmed';},()=>now);
  assert.deepEqual(await p.run(),{retry:1});
  assert.deepEqual(await p.run(),{waiting:1,error:1});
  now=120000; assert.deepEqual(await p.run(),{sent:1});
  assert.equal(attempts,2); assert.equal(firebase.data.historyDiscordReceipts.bad.status,'error');
});
test('legacy confirmed history migrates to a sent receipt and does not duplicate through the new queue',async()=>{
  const {key,job}=await queued(); const firebase=new Firebase({historyDiscordQueue:{[key]:job}}); const storage=new Storage();
  await storage.put('history:h1',{revision:'old',signature:JSON.stringify(['manual','saved',entry]),messageId:'old-message'});
  const p=processor(firebase,storage,()=>assert.fail('already sent'));
  await p.publishLegacyReceipts({h1:{revision:'old',trigger:'manual',operation:'saved',committedAt:1000,entry}});
  assert.equal(firebase.data.historyDiscordReceipts[key].messageId,'old-message');
  await p.run(); assert.equal(firebase.data.historyDiscordReceipts[key].status,'sent');
});
test('a new queue delivery updates the legacy ledger so an old browser cannot repeat it',async()=>{
  const {key,job}=await queued(); const firebase=new Firebase({historyDiscordQueue:{[key]:job}}); const storage=new Storage();
  let sent=0; await processor(firebase,storage,async()=>{sent++;return 'new-message';}).run();
  const legacy=new HistoryProcessor(storage,async()=>({h1:{revision:'old-browser-registration',trigger:'manual',operation:'saved',entry,committedAt:1000}}),()=>assert.fail('already delivered'));
  assert.equal((await legacy.run()).sent,0); assert.equal(sent,1);
});
test('only explicitly marked new completions register, with their first frozen snapshot after acknowledgement retry',async()=>{
  const value={...entry,id:'auto_task_t1'};
  const item={...value,autoRegister:true,completion:{kind:'task',id:'t1'},completionSnapshot:value};
  const firebase=new Firebase({history:{[item.id]:item,historical:{...entry,status:100}}}); const storage=new Storage();
  const original=firebase.request.bind(firebase); let failAck=true;
  firebase.request=async(path,method,body)=>{
    if(path==='history/auto_task_t1' && failAck) throw new Error('acknowledgement interrupted');
    return original(path,method,body);
  };
  let p=processor(firebase,storage);
  await assert.rejects(p.registerAutomaticCompletions());
  firebase.data.history[item.id].completionSnapshot.content='later edit'; failAck=false;
  p=processor(firebase,storage); await p.registerAutomaticCompletions(); await p.registerAutomaticCompletions();
  const jobs=Object.values(firebase.data.historyDiscordQueue);
  assert.equal(jobs.length,1); assert.equal(jobs[0].snapshot.content,'作業完了');
  assert.equal(firebase.data.history[item.id].autoRegister,false);
  assert.equal(firebase.data.history.historical.content,entry.content);
});
test('queue and automatic registration batches stay bounded and leave other history fields intact',async()=>{
  const jobs={};
  for(let i=0;i<7;i++){ const {key,job}=await queued({...entry,id:'h'+i});jobs[key]=job; }
  const firebase=new Firebase({historyDiscordQueue:jobs}); let sent=0;
  const p=processor(firebase,new Storage(),async()=>String(++sent));
  assert.deepEqual(await p.run(),{sent:5}); assert.deepEqual(await p.run(),{sent:2});
  assert.equal(sent,7); assert.ok(firebase.calls.every(call=>call.path.startsWith('historyDiscord')));
});
