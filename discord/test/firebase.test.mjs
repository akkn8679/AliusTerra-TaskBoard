import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync, verify} from 'node:crypto';
import {FirebaseReader} from '../src/firebase.mjs';

test('service account JWT is signed correctly and scoped; bearer token is reused and only notifications are read', async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const env={FIREBASE_PROJECT_ID:'aliusterratasks', FIREBASE_BOARD_PATH:'aliusTerraBoard',
    FIREBASE_DATABASE_URL:'https://aliusterratasks-default-rtdb.asia-southeast1.firebasedatabase.app',
    FIREBASE_SERVICE_ACCOUNT:JSON.stringify({project_id:'aliusterratasks',client_email:'reader@example.iam.gserviceaccount.com',
      private_key:privateKey.export({type:'pkcs8',format:'pem'})})};
  let tokenCalls=0,readCalls=0;
  const reader=new FirebaseReader(env,async(url,init)=>{
    if(String(url)==='https://oauth2.googleapis.com/token'){
      tokenCalls++;
      const jwt=init.body.get('assertion');
      const [header,payload,signature]=jwt.split('.');
      assert.ok(verify('sha256',Buffer.from(header+'.'+payload),publicKey,Buffer.from(signature,'base64url')));
      const claims=JSON.parse(Buffer.from(payload,'base64url'));
      assert.equal(claims.aud,'https://oauth2.googleapis.com/token');
      assert.ok(claims.scope.includes('firebase.database'));
      assert.ok(claims.scope.includes('userinfo.email'));
      return Response.json({access_token:'test-bearer',expires_in:3600});
    }
    readCalls++;
    assert.equal(url.pathname,'/aliusTerraBoard/historyNotifications.json');
    assert.equal(url.search,'');
    assert.equal(init.headers.Authorization,'Bearer test-bearer');
    assert.ok(!init.method || init.method==='GET');
    return Response.json(null);
  });
  assert.deepEqual(await reader.notifications(),{});
  await reader.notifications();
  assert.equal(tokenCalls,1); assert.equal(readCalls,2);
});
test('wrong project and invalid destination fail before any credential is sent', async()=>{
  const reader=new FirebaseReader({FIREBASE_PROJECT_ID:'aliusterratasks',
    FIREBASE_SERVICE_ACCOUNT:JSON.stringify({project_id:'other'})},()=>assert.fail());
  await assert.rejects(reader.accessToken(),/does not match/);
  reader.env.FIREBASE_DATABASE_URL='https://evil.example';
  await assert.rejects(reader.notifications(),/Invalid Firebase/);
});

test('default fetch keeps the Workers global receiver for OAuth and database requests', async()=>{
  const originalFetch = globalThis.fetch;
  const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const env={FIREBASE_PROJECT_ID:'aliusterratasks', FIREBASE_BOARD_PATH:'aliusTerraBoard',
    FIREBASE_DATABASE_URL:'https://aliusterratasks-default-rtdb.asia-southeast1.firebasedatabase.app',
    FIREBASE_SERVICE_ACCOUNT:JSON.stringify({project_id:'aliusterratasks',client_email:'reader@example.iam.gserviceaccount.com',
      private_key:privateKey.export({type:'pkcs8',format:'pem'})})};
  let calls=0;
  globalThis.fetch=async function(url){
    assert.equal(this, globalThis, 'Workers fetch must not receive the FirebaseReader as its receiver');
    calls++;
    return String(url)==='https://oauth2.googleapis.com/token'
      ? Response.json({access_token:'test-bearer',expires_in:3600}) : Response.json(null);
  };
  try{
    assert.deepEqual(await new FirebaseReader(env).notifications(),{});
    assert.equal(calls,2);
  }finally{
    globalThis.fetch=originalFetch;
  }
});

test('new notification requests remain under the existing board and only acknowledge automatic history flags', async()=>{
  const env={FIREBASE_PROJECT_ID:'aliusterratasks',FIREBASE_BOARD_PATH:'aliusTerraBoard',
    FIREBASE_DATABASE_URL:'https://aliusterratasks-default-rtdb.asia-southeast1.firebasedatabase.app'};
  const calls=[];
  const reader=new FirebaseReader(env,async(url,init)=>{calls.push({url,init});return Response.json({});});
  reader.accessToken=async()=> 'fake-token';
  await reader.request('historyDiscordReceipts/h1_hash','PUT',{status:'sent'});
  await reader.request('history/auto_task_t1','PATCH',{autoRegister:false});
  assert.equal(calls[0].url.pathname,'/aliusTerraBoard/historyDiscordReceipts/h1_hash.json');
  assert.equal(calls[1].url.pathname,'/aliusTerraBoard/history/auto_task_t1.json');
  assert.equal(calls[1].init.redirect,'manual');
  for(const path of ['tasks','../other','history/h1']) await assert.rejects(reader.request(path,'PUT',{}),/Invalid Firebase notification/);
  await assert.rejects(reader.request('history/h1','PATCH',{autoRegister:false,content:'changed'}),/Invalid Firebase notification/);
  env.FIREBASE_BOARD_PATH='rover'; await assert.rejects(reader.request('history'),/Invalid Firebase board/);
  assert.equal(calls.length,2);
});

test('authentication failures invalidate cached tokens and log only a safe error classification',async()=>{
  const env={FIREBASE_PROJECT_ID:'aliusterratasks',FIREBASE_BOARD_PATH:'aliusTerraBoard',
    FIREBASE_DATABASE_URL:'https://aliusterratasks-default-rtdb.asia-southeast1.firebasedatabase.app'};
  for(const [error,code] of [['Permission denied','PERMISSION_DENIED'],['Auth token is expired','TOKEN_EXPIRED'],['Invalid auth token','TOKEN_INVALID'],['private diagnostic text','REQUEST_FAILED']]){
    const reader=new FirebaseReader(env,async()=>Response.json({error},{status:401}));
    reader.accessToken=async()=> 'fake-token';reader.expiresAt=1234;
    await assert.rejects(reader.request('historyDiscordReceipts/h1_hash','PUT',{status:'sent'}),
      exception=>exception.message==='Firebase PUT historyDiscordReceipts failed: HTTP 401 '+code);
    assert.equal(reader.expiresAt,0);
  }
});
