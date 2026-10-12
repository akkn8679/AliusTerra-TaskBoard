import test from 'node:test';
import assert from 'node:assert/strict';
import {HistoryProcessor, DeliveryError, sendDiscord, discordPayload, discordWebhookUrl} from '../src/notifier.mjs';

function notification(content = 'バトルを実装', revision = 'n1', operation = 'saved'){
  return {revision, trigger:'manual', operation, committedAt:1791790000000, actor:'きむち',
    entry:{id:'h1', content, repo:'Unity', assignee:'きむち', date:'2026-10-12'}};
}
class Storage {
  constructor(){ this.values = new Map(); }
  async get(key){ return this.values.get(key); }
  async put(key, value){
    if(typeof key === 'object') for(const [k,v] of Object.entries(key)) this.values.set(k, structuredClone(v));
    else this.values.set(key, structuredClone(value));
  }
  async delete(keys){ for(const key of [].concat(keys)) this.values.delete(key); }
}

test('empty notification branch does not post old Firebase history', async()=>{
  const processor = new HistoryProcessor(new Storage(), async()=>({}), ()=>assert.fail('unexpected post'));
  assert.equal((await processor.run()).sent, 0);
});
test('saved, changed and deleted content posts once each; same snapshot and restarts do not duplicate', async()=>{
  const storage = new Storage();
  let record = notification();
  const posted = [];
  const deliver = async n=>{ posted.push(n); return 'message-'+posted.length; };
  let processor = new HistoryProcessor(storage, async()=>({h1:record}), deliver);
  await processor.run();
  await processor.run();
  record = notification('バトルを実装', 'n2');
  await processor.run();
  processor = new HistoryProcessor(storage, async()=>({h1:record}), deliver);
  await processor.run();
  record = notification('バトルとUIを実装', 'n3');
  await processor.run();
  record = notification('バトルとUIを実装', 'n4', 'deleted');
  await processor.run();
  assert.deepEqual(posted.map(n=>n.revision), ['n1','n3','n4']);
});
test('unused empty rows stay silent, clearing an already posted row and deleting it is reported', async()=>{
  let record = notification('', 'n1');
  const posted = [];
  const processor = new HistoryProcessor(new Storage(), async()=>({h1:record}), async n=>{
    posted.push(n); return String(posted.length);
  });
  await processor.run();
  record = notification('', 'n2', 'deleted');
  await processor.run();
  assert.equal(posted.length, 0);
  record = notification('作業済み', 'n3');
  await processor.run();
  record = notification('', 'n4');
  await processor.run();
  record = notification('', 'n5', 'deleted');
  await processor.run();
  assert.deepEqual(posted.map(n=>n.revision), ['n3','n4','n5']);
});
test('Discord failure does not acknowledge and respects Retry-After before retry', async()=>{
  const storage = new Storage();
  let now = 1000000;
  let count = 0;
  const processor = new HistoryProcessor(storage, async()=>({h1:notification()}), async()=>{
    if(++count === 1) throw new DeliveryError(429, 120000);
    return 'confirmed';
  }, ()=>now);
  await assert.rejects(processor.run(), /HTTP 429/);
  assert.equal(await storage.get('history:h1'), undefined);
  assert.equal((await processor.run()).status, 'retry-wait');
  assert.equal(count, 1);
  now += 120000;
  await processor.run();
  assert.equal((await storage.get('history:h1')).messageId, 'confirmed');
  await processor.run();
  assert.equal(count, 2);
});
test('newer finalized revision replaces failed revision before retry', async()=>{
  let record = notification();
  let now = 0;
  const posted = [];
  const processor = new HistoryProcessor(new Storage(), async()=>({h1:record}), async n=>{
    posted.push(n.revision);
    if(posted.length === 1) throw new DeliveryError(500);
    return 'ok';
  }, ()=>now);
  await assert.rejects(processor.run());
  record = notification('最新の確定内容', 'n2');
  now = 60000;
  await processor.run();
  assert.deepEqual(posted, ['n1','n2']);
});
test('concurrent Cron invocations share one delivery', async()=>{
  let release;
  let deliveries = 0;
  const gate = new Promise(resolve=>{ release=resolve; });
  const processor = new HistoryProcessor(new Storage(), async()=>{ await gate; return {h1:notification()}; },
    async()=>{ deliveries++; return 'one'; });
  const first = processor.run();
  const second = processor.run();
  assert.equal(first, second);
  release();
  await Promise.all([first,second]);
  assert.equal(deliveries, 1);
});
test('a batch posts at most ten and leaves the remaining changes for the next Cron', async()=>{
  const records = {};
  for(let i=0;i<12;i++){
    const n = notification('作業 '+i, 'n'+i);
    n.entry.id = 'h'+i;
    records[n.entry.id] = n;
  }
  let count = 0;
  const processor = new HistoryProcessor(new Storage(), async()=>records, async()=>String(++count));
  assert.equal((await processor.run()).sent, 10);
  assert.equal((await processor.run()).sent, 2);
});
test('malformed records never reach Discord', async()=>{
  const malformed = notification();
  malformed.entry.id = 'wrong';
  const processor = new HistoryProcessor(new Storage(), async()=>({h1:malformed, h2:null}), ()=>assert.fail());
  assert.equal((await processor.run()).sent, 0);
});
test('Discord confirmation is required and mentions are disabled; long content fits one embed', async()=>{
  const env = {DISCORD_WEBHOOK_URL:'https://discord.com/api/webhooks/123/test-token',
    BOARD_URL:'https://akkn8679.github.io/AliusTerra-TaskBoard/'};
  let captured;
  assert.equal(await sendDiscord(env, notification('@everyone '+ '長'.repeat(9000)), async(url,init)=>{
    captured = {url, payload:JSON.parse(init.body)};
    return Response.json({id:'message'});
  }), 'message');
  assert.equal(captured.url.searchParams.get('wait'), 'true');
  assert.deepEqual(captured.payload.allowed_mentions, {parse:[]});
  assert.equal(captured.payload.embeds[0].description.length, 3500);
  const serialized = JSON.stringify(discordPayload(notification(), env.BOARD_URL));
  assert.ok(!serialized.includes('test-token'));
  await assert.rejects(sendDiscord(env, notification(), async()=>Response.json({})), /confirmation/);
  await assert.rejects(sendDiscord({...env, DISCORD_WEBHOOK_URL:'https://evil.example/api/webhooks/1/token'},
    notification(), ()=>assert.fail()), /Invalid Discord/);
});

test('automatic notifications from an old open page are ignored', async()=>{
  const old = notification();
  delete old.trigger;
  const processor = new HistoryProcessor(new Storage(), async()=>({h1:old}), ()=>assert.fail('unexpected automatic post'));
  assert.equal((await processor.run()).sent,0);
});

test('first manual registration of previously auto-posted content sends once', async()=>{
  const storage=new Storage();
  const record=notification();
  await storage.put('history:h1',{revision:'old-auto',signature:JSON.stringify(['saved',record.entry]),messageId:'old-message'});
  let deliveries=0;
  const processor=new HistoryProcessor(storage,async()=>({h1:record}),async()=>{deliveries++;return 'manual-message';});
  assert.equal((await processor.run()).sent,1);
  assert.equal((await processor.run()).sent,0);
  assert.equal(deliveries,1);
});

test('invalid webhook diagnostics identify the format error without disclosing secret input or sending it', async()=>{
  const examples=[
    ['not-a-url-secret', 'missing or invalid'],
    ['http://discord.com/api/webhooks/123/private-token', 'HTTPS is required'],
    ['https://other.example/api/webhooks/123/private-token', 'host must be discord.com'],
    ['https://user:private-token@discord.com/api/webhooks/123/token', 'embedded login credentials'],
    ['https://discord.com/channels/123/private-token', 'not a channel or server link'],
    ['https://discord.com/api/webhooks/private-id/private-token', 'ID must be numeric'],
    ['https://discord.com/api/webhooks/123/private.token', 'token contains unexpected characters'],
  ];
  for(const [secret,reason] of examples){
    await assert.rejects(sendDiscord({DISCORD_WEBHOOK_URL:secret}, notification(), ()=>assert.fail('must not send')),
      error=>error.message.includes(reason) && !error.message.includes(secret) && !error.message.includes('private-token'));
  }
  assert.equal(discordWebhookUrl('https://discord.com/api/v10/webhooks/123/token_abc-123?wait=false').search, '?wait=true');
});

test('legacy Discord webhook URLs send only to the current official host with the same ID and token', async()=>{
  const env={DISCORD_WEBHOOK_URL:'https://discordapp.com/api/webhooks/123/test_token-abc',
    BOARD_URL:'https://akkn8679.github.io/AliusTerra-TaskBoard/'};
  assert.equal(await sendDiscord(env,notification(),async url=>{
    assert.equal(url.href,'https://discord.com/api/webhooks/123/test_token-abc?wait=true');
    return Response.json({id:'confirmed'});
  }),'confirmed');
  for(const host of ['discordapp.com.evil.example','evil-discordapp.com','discordapp.example']){
    await assert.rejects(sendDiscord({...env,DISCORD_WEBHOOK_URL:'https://'+host+'/api/webhooks/123/test_token-abc'},
      notification(),()=>assert.fail('must not send secrets to a lookalike host')),/Invalid Discord/);
  }
});
