function clip(value, max){
  const text = String(value || '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
  return text.length > max ? text.slice(0, max-1) + '…' : text;
}

export function normalizeNotification(id, value){
  if(!value || typeof value !== 'object' || typeof value.revision !== 'string' ||
    !['saved','deleted'].includes(value.operation) || !value.entry || value.entry.id !== id ||
    !Number.isFinite(value.committedAt) || value.committedAt < 0 || value.committedAt > 8640000000000000) return null;
  const entry = {};
  for(const field of ['id','content','repo','assignee','date']){
    if(typeof value.entry[field] !== 'string') return null;
    entry[field] = value.entry[field];
  }
  return {revision:value.revision, operation:value.operation, entry,
    actor: typeof value.actor === 'string' ? value.actor : '', committedAt:value.committedAt};
}

export function discordPayload(notification, boardUrl){
  const h = notification.entry;
  return {
    username:'Alius-Terra 管理ログ', allowed_mentions:{parse:[]},
    embeds:[{
      title: notification.operation === 'deleted' ? '作業履歴を削除しました' : '作業履歴を保存しました',
      color: notification.operation === 'deleted' ? 0xdc5959 : 0x65a6d9,
      description:clip(h.content.trim() || '（作業内容を空欄に変更）', 3500),
      fields:[
        {name:'担当者', value:clip(h.assignee || '未設定', 200), inline:true},
        {name:'分類', value:clip(h.repo || '未設定', 200), inline:true},
        {name:'作業日', value:clip(h.date || '未設定', 100), inline:true},
        {name:'操作したメンバー', value:clip(notification.actor || '未設定', 200), inline:true},
      ],
      url:boardUrl, timestamp:new Date(notification.committedAt).toISOString(),
      footer:{text:clip('履歴ID: ' + h.id + ' / 通知ID: ' + notification.revision, 300)},
    }],
  };
}

export class DeliveryError extends Error {
  constructor(status, retryAfter = 0){
    super('Discord delivery failed: HTTP ' + status);
    this.retryAfter = retryAfter;
  }
}

export async function sendDiscord(env, notification, fetcher = fetch){
  let url;
  try{ url = new URL(env.DISCORD_WEBHOOK_URL); }
  catch{ throw new Error('Discord webhook secret is missing or invalid'); }
  if(url.protocol !== 'https:' || url.hostname !== 'discord.com' ||
    !/^\/api(?:\/v\d+)?\/webhooks\/\d+\/[\w-]+$/.test(url.pathname) || url.username || url.password){
    throw new Error('Invalid Discord webhook URL');
  }
  url.search = '';
  url.searchParams.set('wait', 'true');
  let response;
  try{
    response = await fetcher(url, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body:JSON.stringify(discordPayload(notification, env.BOARD_URL)), signal:AbortSignal.timeout(10000),
    });
  }catch{ throw new Error('Discord delivery interrupted before confirmation'); }
  if(!response.ok){
    let retryAfter = 0;
    if(response.status === 429){
      try{ retryAfter = Math.ceil(Number((await response.json()).retry_after)*1000) || 60000; }
      catch{ retryAfter = 60000; }
    }
    throw new DeliveryError(response.status, retryAfter);
  }
  let result;
  try{ result = await response.json(); }catch{ throw new Error('Discord returned no message confirmation'); }
  if(typeof result.id !== 'string') throw new Error('Discord returned an invalid message confirmation');
  return result.id;
}

export class HistoryProcessor {
  constructor(storage, readNotifications, deliver, clock = Date.now){
    this.storage = storage;
    this.readNotifications = readNotifications;
    this.deliver = deliver;
    this.clock = clock;
    this.running = null;
  }

  // 同じオブジェクトにCronが重複到着しても同時にDiscordへ送信しない。
  run(){
    if(this.running) return this.running;
    this.running = this.process().finally(()=>{ this.running = null; });
    return this.running;
  }

  async process(){
    const now = this.clock();
    const pauseUntil = await this.storage.get('pauseUntil') || 0;
    if(now < pauseUntil) return {status:'retry-wait', sent:0};
    const records = await this.readNotifications();
    const candidates = Object.entries(records).map(([id,value])=>normalizeNotification(id,value))
      .filter(Boolean).sort((a,b)=>a.committedAt-b.committedAt || a.entry.id.localeCompare(b.entry.id));
    let sent = 0;
    for(const notification of candidates){
      const key = 'history:' + notification.entry.id;
      const previous = await this.storage.get(key);
      if(previous?.revision === notification.revision) continue;
      const signature = JSON.stringify([notification.operation, notification.entry]);
      if(previous?.signature === signature || (!previous?.messageId && !notification.entry.content.trim())){
        await this.storage.put(key, {...previous, revision:notification.revision, signature});
        continue;
      }
      try{
        const messageId = await this.deliver(notification);
        // 成功応答後にだけ既送信として記録し、失敗した通知は次回Cronで再送。
        await this.storage.put(key, {revision:notification.revision, signature, messageId});
        sent++;
      }catch(error){
        const attempts = (await this.storage.get('attempts') || 0) + 1;
        const delay = Math.max(error.retryAfter || 0, Math.min(3600000, 60000 * 2**Math.min(attempts-1,6)));
        await this.storage.put({pauseUntil:now+delay, attempts});
        throw error;
      }
      // Cronの実行時間・Discordレート制限を抑える。残件は次回へ持ち越す。
      if(sent >= 10) break;
    }
    await this.storage.delete(['pauseUntil','attempts']);
    await this.storage.put('lastRun', {at:now, sent});
    return {status:'ok', sent};
  }
}
