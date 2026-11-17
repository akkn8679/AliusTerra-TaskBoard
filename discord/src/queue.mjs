import {DeliveryError, discordWebhookUrl, normalizeNotification, sendDiscord} from './notifier.mjs';

const MAX_BATCH = 5;
const SEND_LEASE_MS = 120000;
const TERMINAL_STATES = ['sent','error','uncertain'];

// public/history-discord.js と同じ順序・内容で署名する。既存履歴には変更を加えない。
export function historySnapshot(entry){
  return {id:String(entry.id || ''),content:String(entry.content || ''),repo:String(entry.repo || ''),
    assignee:String(entry.assignee || ''),date:String(entry.date || '')};
}
export function validateSnapshot(entry){
  const value = historySnapshot(entry || {});
  if(!/^[A-Za-z0-9_-]{1,100}$/.test(value.id) || !value.content.trim() || value.content.length > 10000 ||
    value.repo.length > 200 || value.assignee.length > 100 || !/^\d{4}-\d{2}-\d{2}$/.test(value.date)){
    throw new Error('NOTIFICATION_INVALID');
  }
  return value;
}
export async function historyEventKey(entry){
  const value = validateSnapshot(entry);
  const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
  return value.id + '_' + Array.from(new Uint8Array(bytes),byte=>byte.toString(16).padStart(2,'0')).join('');
}
function legacySignature(entry){ return JSON.stringify(['manual','saved',historySnapshot(entry)]); }

export class QueueProcessor {
  constructor({storage, firebase, env, deliver, now = Date.now}){
    Object.assign(this,{storage,firebase,env,now});
    this.deliver = deliver || (notification=>sendDiscord(env,notification));
  }

  async finish(key,status,details = {}){
    const receipt = {status,...details,updatedAt:this.now()};
    await this.firebase.request('historyDiscordReceipts/'+key,'PUT',receipt);
    await this.firebase.request('historyDiscordQueue/'+key,'PATCH',{status});
  }

  async process(key,job){
    const ledgerKey = 'delivery:'+key;
    const ledger = await this.storage.get(ledgerKey);
    if(ledger && TERMINAL_STATES.includes(ledger.status)){
      await this.finish(key,ledger.status,ledger.details);
      return ledger.status;
    }
    if(ledger?.status === 'sending'){
      if(ledger.startedAt + SEND_LEASE_MS > this.now()) return 'waiting';
      const details = {code:'INTERRUPTED_RESULT_UNKNOWN'};
      await this.storage.put(ledgerKey,{status:'uncertain',details});
      await this.finish(key,'uncertain',details);
      return 'uncertain';
    }
    if(ledger?.retryAt > this.now()) return 'waiting';
    let value;
    try{
      if(job?.status !== 'pending' || job.historyId !== job.snapshot?.id ||
        await historyEventKey(job.snapshot) !== key) throw new Error('NOTIFICATION_INVALID');
      value = validateSnapshot(job.snapshot);
      discordWebhookUrl(this.env.DISCORD_WEBHOOK_URL);
    }catch{
      const details = {code:'NOTIFICATION_INVALID'};
      await this.storage.put(ledgerKey,{status:'error',details});
      await this.finish(key,'error',details);
      return 'error';
    }

    // 移行前の手動登録と同じ内容なら、既存の永続台帳を引き継いで二重送信しない。
    const previous = await this.storage.get('history:'+value.id);
    if(previous?.messageId && previous.signature === legacySignature(value)){
      const details = {messageId:previous.messageId,sentAt:this.now(),migrated:true};
      await this.storage.put(ledgerKey,{status:'sent',details});
      await this.finish(key,'sent',details);
      return 'sent';
    }

    // 送信前に保存し、受理後の通信切断・中断では自動再送せず「要確認」にする。
    await this.storage.put(ledgerKey,{status:'sending',startedAt:this.now()});
    let messageId;
    try{
      messageId = await this.deliver({revision:key,operation:'saved',entry:value,
        actor:value.assignee,
        committedAt:Number.isFinite(job.requestedAt) ? job.requestedAt : this.now()});
    }catch(error){
      if(error instanceof DeliveryError && error.status === 429){
        await this.storage.put(ledgerKey,{status:'retry',retryAt:this.now()+Math.max(60000,Math.min(3600000,error.retryAfter || 60000))});
        return 'retry';
      }
      const uncertain = !(error instanceof DeliveryError) || error.status >= 500;
      const status = uncertain ? 'uncertain' : 'error';
      const details = {code:uncertain ? 'DISCORD_RESULT_UNKNOWN' : 'DISCORD_HTTP_'+error.status};
      await this.storage.put(ledgerKey,{status,details});
      await this.finish(key,status,details);
      return status;
    }
    const details = {messageId,sentAt:this.now()};
    await this.storage.put(ledgerKey,{status:'sent',details});
    // 旧版のブラウザが同じ内容を登録しても再送しない。
    await this.storage.put('history:'+value.id,{...previous,signature:legacySignature(value),messageId});
    await this.finish(key,'sent',details);
    return 'sent';
  }

  async registerAutomaticCompletions(){
    // 既存のRulesへ新しいindex設定を要求せず、明示された新規完了だけを処理する。
    const entries = await this.firebase.request('history');
    let registered = 0;
    for(const [id,entry] of Object.entries(entries || {})){
      if(entry?.autoRegister !== true) continue;
      const source = entry.completion;
      if(!['task','debug','agenda'].includes(source?.kind) || !/^[A-Za-z0-9_-]{1,80}$/.test(source?.id) ||
        id !== 'auto_'+source.kind+'_'+source.id || entry.id !== id) continue;
      let value;
      try{ value = validateSnapshot(entry.completionSnapshot); }catch{ continue; }
      if(value.id !== id) continue;
      const ledgerKey = 'automatic:'+id;
      let ledger = await this.storage.get(ledgerKey);
      if(!ledger){
        const key = await historyEventKey(value);
        ledger = {key,job:{historyId:id,snapshot:value,requestedAt:this.now(),
          requestedBy:'aliusterra-discord-notifier',status:'pending'},queued:false};
        await this.storage.put(ledgerKey,ledger);
      }
      if(!ledger.queued){
        const path = 'historyDiscordQueue/'+ledger.key;
        if(!await this.firebase.request(path)) await this.firebase.request(path,'PUT',ledger.job);
        ledger = {...ledger,queued:true};
        await this.storage.put(ledgerKey,ledger);
      }
      await this.firebase.request('history/'+id,'PATCH',{autoRegister:false});
      if(++registered >= MAX_BATCH) break;
    }
  }

  async publishLegacyReceipts(records){
    // 既存の登録状態を新UIへ渡す。単に受付済みだったものを送信済みとは見なさない。
    for(const [id,raw] of Object.entries(records || {})){
      const notification = normalizeNotification(id,raw);
      if(!notification || notification.operation !== 'saved') continue;
      let key;
      try{ key = await historyEventKey(notification.entry); }catch{ continue; }
      const previous = await this.storage.get('history:'+id);
      if(previous?.messageId && previous.signature === legacySignature(notification.entry)){
        const receiptKey = 'legacy-receipt:'+key;
        if(await this.storage.get(receiptKey)) continue;
        await this.firebase.request('historyDiscordReceipts/'+key,'PUT',
          {status:'sent',messageId:previous.messageId,updatedAt:this.now(),migrated:true});
        await this.storage.put(receiptKey,true);
      }
    }
  }

  async run(){
    const jobs = await this.firebase.request('historyDiscordQueue');
    const counts = {};
    let processed = 0;
    for(const [key,job] of Object.entries(jobs || {})){
      if(job?.status !== 'pending' || !/^[A-Za-z0-9_-]{1,200}$/.test(key)) continue;
      const result = await this.process(key,job);
      counts[result] = (counts[result] || 0) + 1;
      if(result === 'retry' || ++processed >= MAX_BATCH) break;
    }
    return counts;
  }
}
