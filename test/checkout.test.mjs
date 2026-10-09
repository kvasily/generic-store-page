import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShop, validateConfig } from '../server.mjs';
import { createElectrum, requestState, quoteSatoshis, bitcoinAmount, PaymentMismatch } from '../payment.mjs';
import { migratePayments, attachRequest } from '../payment-store.mjs';
import { DatabaseSync } from 'node:sqlite';
const base=JSON.parse(readFileSync(new URL('../config/shop.json',import.meta.url)));
const address={name:'Test Customer',email:'',line1:'123 Test Street',line2:'',city:'Test City',region:'CA',postal:'12345',country:'US'};
async function setup(t, {mode='demo',provider,config}={}) {
 const app=createShop({dbPath:':memory:',config:config||{...base,liveReady:true,taxIncluded:true,supportEmail:'shop@example.com'},env:{PAYMENT_MODE:mode,SHOP_ORIGIN:'http://127.0.0.1:8080'},provider});
 app.server.listen(0,'127.0.0.1');await once(app.server,'listening');t.after(()=>app.close());
 const origin=`http://127.0.0.1:${app.server.address().port}`;
 function browser() {
  let cookie='',csrf='';
  async function request(path,fields,extra={}) {
   const headers={Host:'127.0.0.1:8080',...(cookie?{cookie}:{}),...extra};
   if(fields) headers['Content-Type']='application/x-www-form-urlencoded';
   const r=await new Promise((resolve,reject)=>{
    const req=httpRequest(origin+path,{method:fields?'POST':'GET',headers},res=>{
     let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode,headers:new Headers(Object.entries(res.headers).map(([k,v])=>[k,Array.isArray(v)?v.join(', '):v])),text:async()=>text}));
    });
    req.on('error',reject);req.end(fields?new URLSearchParams({csrf,...fields}).toString():undefined);
   });
   if(r.headers.get('set-cookie')) cookie=r.headers.get('set-cookie').split(';')[0];
   const text=await r.text();const token=/name="csrf" value="([a-f0-9]+)"/.exec(text);if(token) csrf=token[1];
   return {status:r.status,text,location:r.headers.get('location'),headers:r.headers};
  }
  return {request};
 }
 return {...app,browser};
}
async function add(b) {await b.request('/');assert.equal((await b.request('/cart/add',{product:'01'})).status,303);}
let accountNumber=0;
async function signIn(b) {
 if((await b.request('/account')).status===200) return;
 await b.request('/register');
 const password='checkout test passphrase';
 assert.equal((await b.request('/register',{username:'checkout_'+(++accountNumber),password,confirm:password})).status,303);
 await b.request('/account');
}
async function legacyOrder(app,b) {
 await add(b);
 const session=app.db.prepare('SELECT * FROM sessions ORDER BY rowid DESC LIMIT 1').get();const id='e'.repeat(64);
 app.db.prepare('INSERT INTO orders (id,session_id,mode,items,subtotal,shipping,total,currency,address,status,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,session.id,'demo','[]',1800,500,2300,'USD',JSON.stringify(address),'demo',Math.floor(Date.now()/1000));
 app.db.prepare("UPDATE sessions SET active_order=?,cart='{}' WHERE id=?").run(id,session.id);
 return {location:'/orders/'+id};
}
async function order(b) {await signIn(b);await add(b);return b.request('/checkout',address);}
const ADDRESS='bc1q'+'a'.repeat(38);
function fakeProvider({failure=false,delay=0}={}) {
 let count=0,request;
 return {get count(){return count;}, get request(){return request;},
 async prepare(o){return {amount_sats:23000,rate:'100000',expires_at:Math.floor(Date.now()/1000)+900,min_confirmations:3,payment_network:'mainnet'};},
 async create(o){count++;if(delay) await new Promise(r=>setTimeout(r,delay));request={request_id:'request-'+count,address:ADDRESS,amount_sat:o.amount_sats,message:'generic-store-page:'+o.id,is_lightning:false,expiry:0,timestamp:o.created,status:0,confirmations:0,tx_hashes:[]};if(failure) throw Error('timeout');return request;},
 async get(){return request;},async recover(){return request;}};
}
test('cart uses server prices, validates quantities, removes items and stays usable without scripts',async t=>{
 const app=await setup(t);const b=app.browser();const home=await b.request('/');
 assert.match(home.text,/Add to cart/);assert.match(home.text,/\$18\.00 · demo/);assert.match(home.text,/<form data-add-to-cart action="\/cart\/add" method="post">/);assert.match(home.text,/name="csrf"/);
 assert.equal((await b.request('/cart/add',{product:'unknown'})).status,400);
 assert.equal((await b.request('/cart/add',{product:'01',price:'0'})).status,303);
 assert.equal((await b.request('/cart/update',{product:'01',quantity:'-1'})).status,400);
 assert.equal((await b.request('/cart/update',{product:'01',quantity:'11'})).status,400);
 assert.equal((await b.request('/cart/update',{product:'01',quantity:'2'})).status,303);
 const cart=await b.request('/cart');assert.match(cart.text,/\$41\.00/);
 assert.equal((await b.request('/cart/update',{product:'01',quantity:'0'})).status,303);
 assert.match((await b.request('/cart')).text,/Your cart is empty/);
});
test('CSRF, cross-origin posts and unsupported shipping are rejected',async t=>{
 const app=await setup(t);const b=app.browser();await signIn(b);await add(b);
 assert.equal((await b.request('/cart/add',{product:'01',csrf:'bad'})).status,403);
 assert.equal((await b.request('/cart/add',{product:'01'},{Origin:'https://evil.example'})).status,403);
 assert.equal((await b.request('/checkout',{...address,country:'ZZ'})).status,400);
 assert.equal((await b.request('/checkout',{...address,name:''})).status,400);
 assert.equal(app.db.prepare('SELECT count(*) n FROM orders').get().n,0);
});
test('demo saves an immutable order, clears cart, escapes address, and isolates sessions',async t=>{
 const app=await setup(t);const b=app.browser();await signIn(b);await add(b);
 const created=await b.request('/checkout',{...address,name:'<script>alert(1)</script>',total:'1'});
 assert.equal(created.status,303);const page=await b.request(created.location);
 assert.match(page.text,/Demo order/);assert.match(page.text,/&lt;script&gt;/);assert.match(page.text,/\$23\.00/);assert.doesNotMatch(page.text,/Pay with Bitcoin/);
 assert.equal((await app.browser().request(created.location)).status,404);
 const saved=app.db.prepare('SELECT * FROM orders').get();assert.equal(saved.status,'demo');assert.equal(saved.total,2300);
 assert.match((await b.request('/cart')).text,/Your cart is empty/);
 assert.equal((await b.request('/checkout',address)).location,created.location);
 assert.equal(app.db.prepare('SELECT count(*) n FROM orders').get().n,1);
});
test('parallel checkout requests create exactly one Electrum request',async t=>{
 const provider=fakeProvider({delay:40});const app=await setup(t,{mode:'electrum',provider});const b=app.browser();await signIn(b);await add(b);
 const [one,two]=await Promise.all([b.request('/checkout',address),b.request('/checkout',address)]);
 assert.equal(one.location,two.location);assert.equal(provider.count,1);assert.equal(app.db.prepare('SELECT count(*) n FROM orders').get().n,1);
 assert.equal(app.db.prepare('SELECT status FROM orders').get().status,'awaiting_payment');
});
test('invoice timeout remains recoverable without automatically issuing another request',async t=>{
 const provider=fakeProvider({failure:true});const app=await setup(t,{mode:'electrum',provider});const b=app.browser();const first=await order(b);
 assert.equal(app.db.prepare('SELECT status FROM orders').get().status,'payment_error');
 assert.equal((await b.request('/checkout',address)).location,first.location);assert.equal(provider.count,1);
 assert.match((await b.request(first.location)).text,/Do not send another payment/);
});
test('order shows a stable wallet address and exact amount, and requires the configured confirmations',async t=>{
 const provider=fakeProvider();const app=await setup(t,{mode:'electrum',provider});const b=app.browser();const created=await order(b);const page=await b.request(created.location);
 assert.match(page.text,/0.00023000 BTC/);assert.match(page.text,/bitcoin:bc1q/);assert.match(page.text,/Open Bitcoin wallet/);
 await b.request(created.location);assert.equal(provider.count,1);
 const id=created.location.split('/').pop();const state=()=>app.db.prepare('SELECT status FROM orders WHERE id=?').get(id).status;
 provider.request.status=7;await app.reconcile(id);assert.equal(state(),'confirming');
 provider.request.status=3;provider.request.confirmations=1;await app.reconcile(id);assert.equal(state(),'confirming');
 provider.request.confirmations=3;await app.reconcile(id);assert.equal(state(),'paid');
 provider.request.amount_sat=1;await assert.rejects(()=>app.reconcile(id),/does not match/);assert.equal(state(),'review');
});
test('configured prices enable Bitcoin checkout without hidden readiness flags',()=>{
 assert.doesNotThrow(()=>validateConfig(base,'electrum'));
 assert.throws(()=>validateConfig({...base,products:[{id:'01',name:'x',priceCents:1.5}]},'demo'),/Invalid product/);
});
test('partial payments and API failures never authorize fulfillment',async t=>{
 const provider=fakeProvider();const app=await setup(t,{mode:'electrum',provider});const b=app.browser();const created=await order(b);const id=created.location.split('/').pop();
 provider.request.tx_hashes=['partial-transaction'];await app.reconcile(id);assert.equal(app.db.prepare('SELECT status FROM orders').get().status,'partial');
 provider.get=async()=>{throw Error('offline');};await assert.rejects(()=>app.reconcile(id),/offline/);
 assert.equal(app.db.prepare('SELECT status FROM orders').get().status,'partial');
 assert.match((await b.request(created.location)).text,/verification is currently unavailable/);
});
test('private source, credentials and order data have no public route',async t=>{
 const app=await setup(t);const b=app.browser();
 for(const path of ['/.env','/electrum.local.json','/server.mjs','/config/shop.json','/data/shop.sqlite','/data/electrum/config','/orders.mjs']) assert.equal((await b.request(path)).status,404,path);
 const home=await b.request('/');assert.match(home.headers.get('content-security-policy'),/form-action 'self'/);assert.equal(home.headers.get('cache-control'),'no-store');assert.equal(home.headers.get('referrer-policy'),'no-referrer');
});

test('concurrent additions retain both quantities and unexpected hosts are rejected',async t=>{
 const app=await setup(t);const b=app.browser();await b.request('/');
 await Promise.all([b.request('/cart/add',{product:'01'}),b.request('/cart/add',{product:'01'})]);
 const cart=await b.request('/cart');assert.match(cart.text,/value="2"/);assert.match(cart.text,/\$41\.00/);
 assert.equal((await b.request('/',undefined,{Host:'evil.example'})).status,421);
});
function sampleOrder(overrides={}) {return {id:'a'.repeat(64),invoice_id:'request-1',payment_address:ADDRESS,amount_sats:23000,created:1000,expires_at:1900,min_confirmations:3,payment_network:'mainnet',...overrides};}
function sampleRequest(order, overrides={}) {return {request_id:order.invoice_id,address:order.payment_address,amount_sat:order.amount_sats,is_lightning:false,message:'generic-store-page:'+order.id,timestamp:order.created,expiry:0,status:0,confirmations:0,tx_hashes:[],...overrides};}
test('request verification rejects altered amounts, wallet addresses, references, IDs, Lightning and expiring reservations',()=>{
 const o=sampleOrder();const r=sampleRequest(o);
 for(const patch of [{request_id:'other'},{address:'bc1q'+'b'.repeat(38)},{amount_sat:22999},{message:'other'},{is_lightning:true},{expiry:900}]) assert.throws(()=>requestState({...r,...patch},o,1100),PaymentMismatch);
 assert.equal(requestState(r,o,1900).status,'expired');
 assert.equal(requestState({...r,status:3,confirmations:3},o,2000).status,'review');
 assert.equal(requestState({...r,status:3,confirmations:3},{...o,full_seen_at:1500},2000).status,'paid');
 assert.equal(requestState(r,{...o,full_seen_at:1500},1700).status,'review');
 assert.equal(requestState({...r,status:7},o,1500).status,'confirming');
 assert.throws(()=>requestState({...r,status:3,confirmations:0},o,1500),PaymentMismatch);
});
test('BTC conversion uses integer arithmetic and rounds up exactly one satoshi when needed',()=>{
 assert.equal(quoteSatoshis(2300,'100000.00'),23000);
 assert.equal(quoteSatoshis(1,'30000'),34);
 assert.equal(quoteSatoshis(2300,'100000.00000001'),23000);
 assert.equal(bitcoinAmount(1),'0.00000001');
 for(const rate of ['0','-1','NaN','1e5','1.123456789']) assert.throws(()=>quoteSatoshis(100,rate));
});
const electrumEnv={ELECTRUM_RPC_URL:'http://127.0.0.1:7777',ELECTRUM_RPC_USER:'test',ELECTRUM_RPC_PASSWORD:'test-only',ELECTRUM_WALLET:'/test/watch-only',ELECTRUM_MASTER_PUBLIC_KEY:'zpub'+'a'.repeat(107),ELECTRUM_WATCH_ONLY:'true',ELECTRUM_NETWORK:'mainnet'};
function rpcFixture({offline=false,unsynced=false,key,network='mainnet',date=1100,badId=false,noBase=false,localHeight=100,serverHeight=100}={}) {
 const calls=[];const saved=[];
 const fetcher=async(url,options)=>{
  if(url.startsWith('https://api.coinbase.com/')) return {ok:true,headers:new Headers({date:new Date(date*1000).toUTCString()}),json:async()=>({data:{...(noBase?{}:{base:'BTC'}),currency:'USD',amount:'100000.00'}})};
  const req=JSON.parse(options.body);calls.push({url,...req,options});
  if(req.method!=='getinfo') {
   assert.equal(req.params.wallet_path,electrumEnv.ELECTRUM_WALLET);
   assert.equal(Object.hasOwn(req.params,'wallet'),false);
  }
  let result;
  switch(req.method) {
   case 'getinfo':result={network,connected:!offline,blockchain_height:localHeight,server_height:serverHeight};break;
   case 'is_synchronized':result=!unsynced;break;
   case 'getmpk':result=key||electrumEnv.ELECTRUM_MASTER_PUBLIC_KEY;break;
   case 'ismine':result=true;break;
   case 'add_request':result={request_id:'request-'+(saved.length+1),address:ADDRESS,amount_sat:23000,is_lightning:false,message:req.params.memo,timestamp:1100,expiry:0,status:0,confirmations:0,tx_hashes:[]};saved.push(result);break;
   case 'get_request':result=saved.find(r=>r.request_id===req.params.request_id);break;
   case 'list_requests':result=saved;break;
   default:throw Error('Unexpected RPC '+req.method);
  }
  return {ok:true,json:async()=>({jsonrpc:'2.0',id:badId?'wrong':req.id,result})};
 };
 return {fetcher,calls,saved};
}
test('Electrum adapter reserves an on-chain address indefinitely and recovers without creating a second request',async()=>{
 const f=rpcFixture();const provider=createElectrum(electrumEnv,f.fetcher,()=>1100);
 const o={...sampleOrder({created:1100,invoice_id:null,payment_address:null}),total:2300,currency:'USD'};
 const quote=await provider.prepare(o);Object.assign(o,quote);assert.equal(quote.amount_sats,23000);assert.equal(quote.expires_at,1100+3600);
 const request=await provider.create(o);assert.equal(request.address,ADDRESS);
 const create=f.calls.find(x=>x.method==='add_request');assert.equal(create.params.amount,'0.00023000');assert.equal(create.params.expiry,0);assert.equal(create.params.force,true);assert.equal(create.params.lightning,false);assert.equal(create.params.wallet_path,electrumEnv.ELECTRUM_WALLET);
 assert.match(create.options.headers.Authorization,/^Basic /);assert.equal(create.options.redirect,'error');
 assert.equal((await provider.recover(o)).request_id,request.request_id);assert.equal(f.calls.filter(x=>x.method==='add_request').length,1);
 assert.ok(f.calls.every(x=>!['getseed','getmasterprivate','payto','signtransaction'].includes(x.method)));
});
test('Electrum rejects disconnected, unsynchronized, wrong-wallet and wrong-network responses, stale rates and mismatched RPC IDs',async()=>{
 for(const params of [{offline:true},{unsynced:true},{key:'wrong'},{network:'testnet'},{date:500},{badId:true}]) {
  const f=rpcFixture(params);const provider=createElectrum(electrumEnv,f.fetcher,()=>1100);
  await assert.rejects(()=>provider.prepare({...sampleOrder(),total:2300,currency:'USD'}));
  assert.equal(f.calls.filter(x=>x.method==='add_request').length,0);
 }
 assert.throws(()=>createElectrum({...electrumEnv,ELECTRUM_WATCH_ONLY:'false'}),/watch-only/);
 assert.throws(()=>createElectrum({...electrumEnv,ELECTRUM_MASTER_PUBLIC_KEY:'xprvSECRET'}),/PUBLIC/);
 assert.throws(()=>createElectrum({...electrumEnv,BTC_MIN_CONFIRMATIONS:'0'}),/confirmation/);
});
test('reusing an address for a different order is refused before the customer can see it',async t=>{
 const provider=fakeProvider();const app=await setup(t,{mode:'electrum',provider});const first=app.browser(),second=app.browser();
 await order(first);const result=await order(second);
 const saved=app.db.prepare('SELECT * FROM orders WHERE id=?').get(result.location.split('/').pop());
 assert.equal(saved.status,'payment_error');assert.equal(saved.payment_address,null);
 assert.doesNotMatch((await second.request(result.location)).text,/bitcoin:bc1q/);
});
test('legacy databases migrate without losing existing order records',()=>{
 const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE orders (id TEXT PRIMARY KEY,mode TEXT,status TEXT,invoice_id TEXT,checkout_url TEXT); INSERT INTO orders VALUES ('old','btcpay','paid','legacy-id','https://old.example')");
 migratePayments(db);migratePayments(db);
 const old=db.prepare('SELECT * FROM orders').get();assert.equal(old.id,'old');assert.equal(old.mode,'btcpay');assert.equal(old.invoice_id,'legacy-id');assert.equal(old.payment_address,null);db.close();
});

test('request reservations survive a database restart and still forbid reuse',()=>{
 const dir=mkdtempSync(join(tmpdir(),'store-electrum-'));const path=join(dir,'shop.sqlite');
 let db=new DatabaseSync(path);
 try {
  db.exec("CREATE TABLE orders (id TEXT PRIMARY KEY,mode TEXT,status TEXT,invoice_id TEXT UNIQUE,checkout_url TEXT); INSERT INTO orders VALUES ('first','electrum','creating',NULL,NULL); INSERT INTO orders VALUES ('second','electrum','creating',NULL,NULL)");
  migratePayments(db);const first=sampleOrder({id:'first',invoice_id:null,payment_address:null});
  const request=sampleRequest({...first,invoice_id:'req-a',payment_address:ADDRESS});attachRequest(db,first,request);
  db.close();db=new DatabaseSync(path);migratePayments(db);
  assert.equal(db.prepare('SELECT payment_address FROM orders WHERE id=?').get('first').payment_address,ADDRESS);
  const second=sampleOrder({id:'second',invoice_id:null,payment_address:null});
  assert.throws(()=>attachRequest(db,second,sampleRequest({...second,invoice_id:'req-b',payment_address:ADDRESS})),/already allocated/);
 } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});
test('documented Coinbase spot response without optional base field is accepted',async()=>{
 const f=rpcFixture({noBase:true});const provider=createElectrum(electrumEnv,f.fetcher,()=>1100);
 assert.equal((await provider.prepare({...sampleOrder(),total:2300,currency:'USD'})).amount_sats,23000);
});
test('privacy-preserving null-origin forms work with a valid CSRF token and return to the catalog',async t=>{
 const app=await setup(t);const b=app.browser();await b.request('/');
 const added=await b.request('/cart/add',{product:'01'},{Origin:'null','Sec-Fetch-Site':'same-origin'});
 assert.equal(added.status,303);assert.equal(added.location,'/?added=01#product-01');
 const home=await b.request('/?added=01');assert.match(home.text,/Sample Product 01 added\. 1 in your cart/);assert.match(home.text,/<span data-cart-count>1<\/span>/);
 assert.match((await b.request('/cart')).text,/Sample Product 01/);
 const bad=await b.request('/cart/add',{product:'01',csrf:'wrong'},{Origin:'null'});assert.equal(bad.status,403);
 const cross=await b.request('/cart/add',{product:'01'},{Origin:'null','Sec-Fetch-Site':'cross-site'});assert.equal(cross.status,403);
});
test('in-place add returns counts without redirect; errors stay JSON and do not add items',async t=>{
 const app=await setup(t);const b=app.browser();await b.request('/');
 const headers={Origin:'null',Accept:'application/json'};
 const added=await b.request('/cart/add',{product:'01'},headers);
 assert.equal(added.status,200);assert.equal(added.location,null);assert.deepEqual(JSON.parse(added.text),{product:'Sample Product 01',quantity:1,count:1});
 const next=await b.request('/cart/add',{product:'02'},headers);assert.equal(JSON.parse(next.text).count,2);
 const bad=await b.request('/cart/add',{product:'01',csrf:'bad'},headers);assert.equal(bad.status,403);assert.ok(JSON.parse(bad.text).error);
 const external=await b.request('/cart/add',{product:'01'},{...headers,Origin:'https://evil.example'});assert.equal(external.status,403);assert.ok(JSON.parse(external.text).error);
 assert.match((await b.request('/')).text,/<span data-cart-count>2<\/span>/);
 const script=await b.request('/cart.js');assert.equal(script.status,200);assert.match(script.headers.get('content-type'),/javascript/);
});

test('default mode displays Bitcoin checkout and creates a payable request with shipped configuration',async t=>{
 const provider=fakeProvider();
 // Exercise the application default without an environment mode.
 const real=createShop({dbPath:':memory:',config:base,env:{},provider});
 assert.ok(real);real.db.close();
 const live=await setup(t,{mode:'electrum',provider,config:base});const b=live.browser();await signIn(b);await add(b);
 const checkout=await b.request('/checkout');assert.match(checkout.text,/Payment method/);assert.match(checkout.text,/Pay with Bitcoin/);assert.doesNotMatch(checkout.text,/DEMO CHECKOUT/);
 const r=await b.request('/checkout',address);const page=await b.request(r.location);
 assert.match(page.text,/0.00023000 BTC/);assert.match(page.text,/bitcoin:bc1q/);assert.match(page.text,/Open Bitcoin wallet/);
});
test('saved demo order can request Bitcoin payment once, with session ownership enforced',async t=>{
 const provider=fakeProvider({delay:30});const app=await setup(t,{mode:'electrum',provider,config:base});const b=app.browser();await add(b);
 const session=app.db.prepare('SELECT * FROM sessions').get();const id='d'.repeat(64);
 app.db.prepare('INSERT INTO orders (id,session_id,mode,items,subtotal,shipping,total,currency,address,status,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,session.id,'demo','[]',1800,500,2300,'USD',JSON.stringify(address),'demo',Math.floor(Date.now()/1000));
 const path='/orders/'+id;assert.match((await b.request(path)).text,/Pay with Bitcoin/);
 const outsider=app.browser();await outsider.request('/');assert.equal((await outsider.request(path+'/pay',{})).status,404);
 assert.match((await b.request(path+'/pay',{})).location,/^\/login/);assert.equal(provider.count,0);
 await signIn(b);
 await Promise.all([b.request(path+'/pay',{}),b.request(path+'/pay',{})]);
 assert.equal(provider.count,1);assert.match((await b.request(path)).text,/bitcoin:bc1q/);
});
test('unavailable service shows retry and ambiguous requests recover without new allocation',async t=>{
 const provider=fakeProvider({failure:true});const prepare=provider.prepare;let offline=true;
 provider.prepare=async o=>{if(offline) throw Error('offline');return prepare(o);};
 const app=await setup(t,{mode:'electrum',provider,config:base});const b=app.browser();const r=await order(b);
 assert.match((await b.request(r.location)).text,/Retry Bitcoin payment/);assert.equal(provider.count,0);
 offline=false;await b.request(r.location+'/pay',{});assert.equal(provider.count,1);
 assert.match((await b.request(r.location)).text,/Recover payment request/);
 await b.request(r.location+'/pay',{});assert.equal(provider.count,1);
 assert.match((await b.request(r.location)).text,/bitcoin:bc1q/);
});

test('network errors identify Electrum versus exchange rate without printing sensitive error text',async()=>{
 const fixture=rpcFixture();
 for(const service of ['Electrum RPC','Coinbase Bitcoin exchange-rate API']) {
  const fetcher=async(url,options)=>{
   if(service==='Electrum RPC'||url.startsWith('https://api.coinbase.com/')) throw new TypeError('private-value',{cause:{code:'ENOTFOUND'}});
   return fixture.fetcher(url,options);
  };
  await assert.rejects(createElectrum(electrumEnv,fetcher,()=>1100).prepare({total:100,currency:'USD'}),error=>error.message.startsWith(service)&&error.message.includes('ENOTFOUND')&&!error.message.includes('private-value'));
 }
});

test('synchronized wallet tolerates one-block height differences in either direction but rejects larger gaps',async()=>{
 for(const serverHeight of [970526,970527,970528]) {
  const f=rpcFixture({localHeight:970527,serverHeight});
  const quote=await createElectrum(electrumEnv,f.fetcher,()=>1100).prepare({total:2300,currency:'USD'});
  assert.equal(quote.amount_sats,23000);
 }
 for(const params of [{localHeight:970527,serverHeight:970525},{localHeight:970527,serverHeight:970529},{localHeight:1,serverHeight:0},{localHeight:0,serverHeight:1},{localHeight:970527,serverHeight:970526,unsynced:true},{localHeight:970527,serverHeight:970526,offline:true}]) {
  const f=rpcFixture(params);
  await assert.rejects(createElectrum(electrumEnv,f.fetcher,()=>1100).prepare({total:2300,currency:'USD'}),/synchronizing|offline/);
 }
});

const credentials={username:'store_customer',password:'a long unique passphrase',confirm:'a long unique passphrase'};
test('customer registration claims guest orders, preserves cart, rotates session, and login restores private history',async t=>{
 const app=await setup(t);const b=app.browser();
 const first=await b.request('/');const oldCookie=first.headers.get('set-cookie').split(';')[0];
 const created=await legacyOrder(app,b);await b.request('/cart/add',{product:'02'});
 await b.request('/register');const registered=await b.request('/register',credentials);
 assert.equal(registered.location,'/account');assert.notEqual(registered.headers.get('set-cookie').split(';')[0],oldCookie);
 const user=app.db.prepare('SELECT * FROM customers').get();assert.ok(user.password_hash.startsWith('scrypt$'));assert.ok(!user.password_hash.includes(credentials.password));
 assert.equal(app.db.prepare('SELECT user_id FROM orders').get().user_id,user.id);
 assert.match((await b.request('/account')).text,new RegExp(created.location));assert.match((await b.request('/cart')).text,/Sample Product 02/);
 assert.equal((await b.request(created.location)).status,200);
 const stranger=app.browser();assert.equal((await stranger.request(created.location)).status,404);
 assert.equal((await stranger.request('/account',undefined,{Cookie:oldCookie})).location,'/login');
 const accountPage=await b.request('/account');const csrf=/name="csrf" value="([a-f0-9]+)"/.exec(accountPage.text)[1];
 assert.equal((await b.request('/logout',{csrf:'bad'})).status,403);
 const logout=await b.request('/logout',{csrf});assert.equal(logout.location,'/login');
 assert.equal((await b.request(created.location)).status,404);
 await b.request('/login');assert.equal((await b.request('/login',{...credentials,password:'wrong password value'})).status,401);
 assert.equal((await b.request('/login',credentials)).location,'/account');assert.equal((await b.request(created.location)).status,200);
 await b.request('/account');await b.request(created.location+'/finish',{});
 const fresh=await order(b);assert.notEqual(fresh.location,created.location);assert.equal(app.db.prepare('SELECT user_id FROM orders WHERE id=?').get(fresh.location.split('/').pop()).user_id,user.id);
 const device=app.browser();await device.request('/login');assert.equal((await device.request('/login',credentials)).location,'/account');
 assert.equal((await device.request(fresh.location)).status,200);
 const loginPage=await device.request('/account');assert.match(loginPage.text,new RegExp(fresh.location));

});
test('account validation, CSRF, duplicate registration, cross-account isolation and persistent username throttling',async t=>{
 const app=await setup(t);const b=app.browser();await b.request('/register');
 assert.equal((await b.request('/register',{...credentials,csrf:'bad'})).status,403);
 assert.equal((await b.request('/register',{...credentials,password:'short',confirm:'short'})).status,400);
 assert.equal((await b.request('/register',{...credentials,confirm:'different password'})).status,400);
 assert.equal((await b.request('/register',credentials)).status,303);await b.request('/account');const created=await order(b);
 const other=app.browser();await other.request('/register');
 assert.equal((await other.request('/register',credentials)).status,400);
 assert.equal((await other.request('/register',{...credentials,username:'another_customer'})).status,303);
 assert.equal((await other.request(created.location)).status,404);
 assert.doesNotMatch((await other.request('/account')).text,new RegExp(created.location));
 for(let i=0;i<10;i++) {const attacker=app.browser();await attacker.request('/login');assert.equal((await attacker.request('/login',{username:'absent_user',password:'incorrect long password'})).status,401);}
 const attacker=app.browser();await attacker.request('/login');assert.equal((await attacker.request('/login',{username:'absent_user',password:'incorrect long password'})).status,429);
});

test('admin access is enforced on every request and cannot be self-assigned through registration',async t=>{
 const app=await setup(t);const guest=app.browser();const created=await legacyOrder(app,guest);
 const b=app.browser();assert.equal((await b.request('/admin')).location,'/login');
 await b.request('/register');await b.request('/register',{...credentials,is_admin:'1',role:'admin'});
 assert.equal(app.db.prepare('SELECT is_admin FROM customers').get().is_admin,0);
 assert.equal((await b.request('/admin')).status,403);assert.equal((await b.request('/admin'+created.location)).status,403);
 app.db.prepare('UPDATE customers SET is_admin=1 WHERE username=?').run(credentials.username);
 assert.match((await b.request('/account')).text,/Shop administration/);
 assert.match((await b.request('/admin')).text,new RegExp('/admin'+created.location));
 const details=await b.request('/admin'+created.location);assert.equal(details.status,200);assert.match(details.text,/123 Test Street/);
 assert.equal((await b.request(created.location)).status,404);
 assert.equal((await b.request('/admin',{})).status,405);
 app.db.prepare('UPDATE customers SET is_admin=0 WHERE username=?').run(credentials.username);
 assert.equal((await b.request('/admin')).status,403);assert.equal((await b.request('/admin'+created.location)).status,403);
});

test('guest cart stays available but GET and POST checkout require login and resume safely',async t=>{
 const provider=fakeProvider();const app=await setup(t,{mode:'electrum',provider});const b=app.browser();await add(b);
 assert.match((await b.request('/cart')).text,/Log in to check out/);
 for(const fields of [undefined,address]) assert.equal((await b.request('/checkout',fields)).location,'/login?next=%2Fcheckout');
 assert.equal(app.db.prepare('SELECT count(*) n FROM orders').get().n,0);assert.equal(provider.count,0);
 const login=await b.request('/login?next=%2Fcheckout');assert.match(login.text,/register\?next=%2Fcheckout/);
 const invalid=await b.request('/register?next=%2Fcheckout',{...credentials,confirm:'wrong'});assert.match(invalid.text,/action="\/register\?next=%2Fcheckout"/);
 assert.equal((await b.request('/register?next=%2Fcheckout',credentials)).location,'/checkout');
 await b.request('/checkout');const created=await b.request('/checkout',address);assert.match(created.location,/^\/orders\//);assert.equal(provider.count,1);
 const other=app.browser();await other.request('/login?next=%2Fcheckout');assert.equal((await other.request('/login?next=%2Fcheckout',credentials)).location,'/checkout');
 assert.equal((await other.request('/login?next=https://evil.example')).location,'/account');
});

test('special-character and Unicode usernames register, render as text, and log in consistently',async t=>{
 const app=await setup(t);
 for(const name of ['@Store & Team!',"<b>o'reilly</b>",'✨café📦','!!!']) {
  const b=app.browser();const page=await b.request('/register');assert.doesNotMatch(page.text,/pattern=/);
  assert.equal((await b.request('/register',{...credentials,username:name})).status,303);
  const account=await b.request('/account');
  if(name.includes('<b>')) {assert.match(account.text,/&lt;b&gt;o&#39;reilly&lt;\/b&gt;/);assert.doesNotMatch(account.text,/<b>o'reilly<\/b>/);}
  await b.request('/logout',{});await b.request('/login');
  assert.equal((await b.request('/login',{...credentials,username:' '+name.toUpperCase().normalize('NFD')+' '})).location,'/account');
 }
 const b=app.browser();await b.request('/register');
 for(const name of ['ab','x'.repeat(33),'bad\nname','bad\u0000name','   ']) assert.equal((await b.request('/register',{...credentials,username:name})).status,400);
});

test('appearance dashboard enforces admin and CSRF, previews without saving, validates and persists changes',async t=>{
 const {defaults}=await import('../appearance.mjs');const app=await setup(t);const b=app.browser();await signIn(b);
 assert.equal((await b.request('/admin/appearance')).status,403);
 assert.equal((await b.request('/admin/appearance',{...defaults,revision:'0'})).status,403);
 app.db.prepare('UPDATE customers SET is_admin=1').run();
 const editor=await b.request('/admin/appearance');assert.match(editor.text,/Preview in new tab/);assert.match(editor.text,/type="color"/);
 const changes={...defaults,brand:'<Store & Co>',headline:'Your new store',aboutText:'Selected for you.',paper:'#112233',headingFont:'mono',revision:'0'};
 assert.equal((await b.request('/admin/appearance',{...changes,csrf:'wrong'})).status,403);
 const preview=await b.request('/admin/appearance/preview',changes);assert.equal(preview.status,200);assert.match(preview.text,/&lt;Store &amp; Co&gt;/);assert.match(preview.text,/--paper:#112233/);assert.match(preview.headers.get('content-security-policy'),/style-src 'self' 'nonce-/);
 assert.equal(app.db.prepare('SELECT revision FROM appearance_settings').get().revision,0);
 assert.doesNotMatch((await b.request('/')).text,/Your new store/);
 const invalid=await b.request('/admin/appearance',{...changes,paper:'red; background:url(https://evil.example)'});assert.equal(invalid.status,400);
 assert.equal((await b.request('/admin/appearance',{...changes,headingFont:'evil'})).status,400);
 assert.equal((await b.request('/admin/appearance',changes)).location,'/admin/appearance?saved=1');
 const home=await b.request('/');assert.match(home.text,/Your new store/);assert.match(home.text,/Selected for you\./);assert.doesNotMatch(home.text,/<Store & Co>/);
 assert.match((await b.request('/cart')).text,/&lt;Store &amp; Co&gt;/);
 const css=await b.request('/theme.css');assert.match(css.headers.get('content-type'),/text\/css/);assert.match(css.text,/--paper:#112233/);assert.match(css.text,/Courier New/);
 assert.equal((await b.request('/admin/appearance',changes)).status,409);
 await b.request('/admin/appearance');assert.equal((await b.request('/admin/appearance/reset',{revision:'1'})).status,303);
 assert.match((await b.request('/theme.css')).text,/--paper:#faf8f4/);
 app.db.prepare('UPDATE customers SET is_admin=0').run();
 assert.equal((await b.request('/admin/appearance/reset',{revision:'2'})).status,403);
 assert.equal((await b.request('/admin/appearance/preview',changes)).status,403);
});
