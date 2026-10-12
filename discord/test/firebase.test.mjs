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
