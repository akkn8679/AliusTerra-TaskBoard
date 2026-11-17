import { DurableObject } from 'cloudflare:workers';
import { FirebaseReader } from './firebase.mjs';
import { HistoryProcessor, sendDiscord, discordWebhookUrl } from './notifier.mjs';
import { QueueProcessor } from './queue.mjs';

export class HistoryLog extends DurableObject {
  constructor(ctx, env){
    super(ctx, env);
    const reader = new FirebaseReader(env);
    this.reader = reader;
    this.storage = ctx.storage;
    this.processor = new HistoryProcessor(ctx.storage,
      ()=>reader.notifications(), notification=>sendDiscord(env, notification));
    this.env = env;
    this.running = Promise.resolve();
  }

  async fetch(){
    if(this.env.NOTIFICATIONS_ENABLED !== 'true') return Response.json({status:'disabled'});
    if(!this.env.FIREBASE_SERVICE_ACCOUNT || !this.env.DISCORD_WEBHOOK_URL){
      throw new Error('History notifier secrets have not been configured');
    }
    // 再試行待ちでも設定形式を確認し、秘密を出さず設定エラーを診断できる。
    discordWebhookUrl(this.env.DISCORD_WEBHOOK_URL);
    const operation = this.running.then(async()=>{
      // 旧ページの登録を先に確定し、新しいキューとの重複送信を避ける。
      const legacy = await this.processor.run();
      const queue = new QueueProcessor({storage:this.storage,firebase:this.reader,env:this.env});
      await queue.publishLegacyReceipts(await this.reader.notifications());
      await queue.registerAutomaticCompletions();
      return {legacy,queue:await queue.run()};
    });
    this.running = operation.catch(()=>{});
    return Response.json(await operation);
  }
}

export default {
  // 外部HTTPから投稿やデータ取得を実行できない。Cronのみが内部オブジェクトを呼ぶ。
  fetch(){ return new Response('Not found', {status:404}); },
  async scheduled(controller, env){
    if(env.NOTIFICATIONS_ENABLED !== 'true') return;
    const id = env.HISTORY_LOG.idFromName(env.FIREBASE_PROJECT_ID + ':' + env.FIREBASE_BOARD_PATH);
    try{
      const response = await env.HISTORY_LOG.get(id).fetch('https://internal/run', {method:'POST'});
      if(!response.ok) throw new Error('History notifier failed');
      console.log('History notifier:', await response.json());
    }catch{
      // SDK/通信例外に秘密のURLが含まれても公開ログに出さない。
      console.error('History notifier failed; check Firebase and Discord configuration. Pending changes will retry.');
      throw new Error('History notifier scheduled run failed');
    }
  },
};
