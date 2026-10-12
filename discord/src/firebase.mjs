const SCOPES = 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

function base64url(bytes){
  return btoa(String.fromCharCode(...bytes)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function encode(value){ return base64url(new TextEncoder().encode(JSON.stringify(value))); }

export class FirebaseReader {
  constructor(env, fetcher = fetch.bind(globalThis)){
    this.env = env;
    this.fetcher = fetcher;
    this.token = null;
    this.expiresAt = 0;
  }

  async accessToken(){
    if(this.token && Date.now() < this.expiresAt) return this.token;
    let account;
    try{ account = JSON.parse(this.env.FIREBASE_SERVICE_ACCOUNT || ''); }
    catch{ throw new Error('Firebase service account secret is missing or invalid'); }
    if(account.project_id !== this.env.FIREBASE_PROJECT_ID ||
      typeof account.client_email !== 'string' || typeof account.private_key !== 'string'){
      throw new Error('Firebase service account configuration does not match this project');
    }
    const pem = account.private_key.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
    let key;
    try{
      key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), c=>c.charCodeAt(0)),
        {name:'RSASSA-PKCS1-v1_5', hash:'SHA-256'}, false, ['sign']);
    }catch{ throw new Error('Firebase private key is invalid'); }
    const now = Math.floor(Date.now()/1000);
    const unsigned = encode({alg:'RS256', typ:'JWT'}) + '.' + encode({
      iss:account.client_email, scope:SCOPES, aud:TOKEN_URL, iat:now, exp:now+3600,
    });
    const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned));
    const response = await this.fetcher(TOKEN_URL, {
      method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion:unsigned + '.' + base64url(new Uint8Array(signature))}),
      signal:AbortSignal.timeout(10000),
    });
    if(!response.ok) throw new Error('Firebase OAuth request failed: HTTP ' + response.status);
    const result = await response.json();
    if(typeof result.access_token !== 'string' || !Number.isFinite(result.expires_in) || result.expires_in <= 60){
      throw new Error('Firebase OAuth returned an invalid token response');
    }
    this.token = result.access_token;
    this.expiresAt = Date.now() + (result.expires_in-60)*1000;
    return this.token;
  }

  async notifications(){
    const base = new URL(this.env.FIREBASE_DATABASE_URL);
    if(base.protocol !== 'https:' || !base.hostname.endsWith('.firebasedatabase.app') || base.username || base.password){
      throw new Error('Invalid Firebase database URL');
    }
    const path = this.env.FIREBASE_BOARD_PATH;
    if(!/^[A-Za-z0-9_-]+$/.test(path)) throw new Error('Invalid Firebase board path');
    const url = new URL('/' + path + '/historyNotifications.json', base);
    const response = await this.fetcher(url, {
      headers:{Authorization:'Bearer ' + await this.accessToken()}, signal:AbortSignal.timeout(10000),
    });
    if(!response.ok){
      if(response.status === 401) this.expiresAt = 0;
      throw new Error('Firebase history read failed: HTTP ' + response.status);
    }
    const records = await response.json();
    if(records === null) return {};
    if(typeof records !== 'object' || Array.isArray(records)) throw new Error('Invalid Firebase history response');
    return records;
  }
}
