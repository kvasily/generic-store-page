import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localWalletSettings, validateShopPublicKey, findElectrum, startElectrumHelper } from '../electrum-auto.mjs';
const sha=b=>createHash('sha256').update(b).digest();
function fixtureKey(byte=1) {
 const payload=Buffer.alloc(78);payload.writeUInt32BE(0x04b24746);payload.fill(byte,13,45);
 Buffer.from('0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798','hex').copy(payload,45);
 const data=Buffer.concat([payload,sha(sha(payload)).subarray(0,4)]);
 let n=BigInt('0x'+data.toString('hex')),key='';const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
 while(n){key=alphabet[Number(n%58n)]+key;n/=58n;}return key;
}
function fixture(t,{wrongWallet=false,ready=true,failLoad=false}={}) {
 const root=mkdtempSync(join(tmpdir(),'electrum-auto-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const executable=join(root,'electrum');writeFileSync(executable,'#!/bin/sh\n',{mode:0o700});
 const calls=[];let running=false,spawns=0,child;
 const spawnImpl=(file,args,options)=>{
  spawns++;assert.equal(file,executable);assert.deepEqual(args,['-D',join(root,'data','electrum'),'daemon']);assert.equal(options.stdio,'ignore');
  running=ready;child=new EventEmitter();child.exitCode=null;child.kill=()=>{child.exitCode=0;running=false;child.emit('exit',0);};return child;
 };
 const fetcher=async(url,options)=>{
  if(!running) throw Error('not running');
  const req=JSON.parse(options.body);calls.push(req);const config=JSON.parse(readFileSync(join(root,'data','electrum','config'),'utf8'));
  assert.equal(url,`http://127.0.0.1:${config.rpcport}`);assert.equal(options.headers.Authorization,`Basic ${Buffer.from(`${config.rpcuser}:${config.rpcpassword}`).toString('base64')}`);assert.equal(options.redirect,'error');
  let result;
  switch(req.method) {
   case 'ping':result=true;break;
   case 'restore':assert.equal(req.params.text,fixtureKey());assert.equal(req.params.encrypt_file,false);assert.ok(!existsSync(req.params.wallet_path));writeFileSync(req.params.wallet_path,'watch-only mock',{mode:0o600});result={path:req.params.wallet_path};break;
   case 'load_wallet':if(failLoad) return {ok:true,json:async()=>({id:req.id,error:{message:'failed'}})};result=req.params.wallet_path;break;
   case 'getmpk':assert.equal(req.params.wallet_path,join(root,'data','electrum','wallets','generic-store-page-watch-only'));assert.equal(Object.hasOwn(req.params,'wallet'),false);result=wrongWallet?fixtureKey(2):fixtureKey();break;
   case 'stop':child.kill();result=true;break;
   default:throw Error('Unapproved RPC method '+req.method);
  }
  return {ok:true,json:async()=>({jsonrpc:'2.0',id:req.id,result})};
 };
 return {root,calls,get spawns(){return spawns;},get running(){return running;},options:{projectDir:root,masterPublicKey:fixtureKey(),executable,env:{},fetcher,spawnImpl,choosePort:async()=>39777,wait:async()=>{},attempts:2}};
}
test('only valid mainnet public keys are accepted; private/local settings are optional',t=>{
 assert.equal(validateShopPublicKey(fixtureKey()),fixtureKey());
 for(const key of ['xprv123','tpub123','seed words',fixtureKey().slice(0,-1)+'0']) assert.throws(()=>validateShopPublicKey(key));
 const f=fixture(t);assert.equal(localWalletSettings(f.root),null);
 writeFileSync(join(f.root,'electrum.local.json'),JSON.stringify({masterPublicKey:fixtureKey()}));assert.equal(localWalletSettings(f.root).masterPublicKey,fixtureKey());
});
test('startup creates and loads only a watch-only wallet with private local RPC settings',async t=>{
 const f=fixture(t);const helper=await startElectrumHelper(f.options);
 assert.equal(f.spawns,1);assert.equal(helper.env.ELECTRUM_MASTER_PUBLIC_KEY,fixtureKey());assert.equal(helper.env.ELECTRUM_WATCH_ONLY,'true');
 assert.equal(f.calls.filter(c=>c.method==='restore').length,1);
 assert.equal(JSON.parse(readFileSync(join(f.root,'data','electrum','config'),'utf8')).rpchost,'127.0.0.1');
 assert.ok(!existsSync(join(f.root,'data','electrum','shop-start.lock')));
 await helper.stop();assert.equal(f.running,false);
});
test('restart preserves the wallet and RPC credentials instead of restoring it again',async t=>{
 const f=fixture(t);const first=await startElectrumHelper(f.options);const secret=first.env.ELECTRUM_RPC_PASSWORD;await first.stop();
 const second=await startElectrumHelper(f.options);assert.equal(f.spawns,2);assert.equal(second.env.ELECTRUM_RPC_PASSWORD,secret);assert.equal(f.calls.filter(c=>c.method==='restore').length,1);await second.stop();
});
test('an already-running dedicated helper is reused and not stopped by a second client',async t=>{
 const f=fixture(t);const first=await startElectrumHelper(f.options);const second=await startElectrumHelper(f.options);
 assert.equal(f.spawns,1);await second.stop();assert.equal(f.running,true);await first.stop();
});
test('wrong wallet, failed loading and failed daemon startup are rejected and cleaned up',async t=>{
 for(const options of [{wrongWallet:true},{failLoad:true},{ready:false}]) {
  const f=fixture(t,options);await assert.rejects(()=>startElectrumHelper(f.options));assert.equal(f.running,false);assert.ok(!existsSync(join(f.root,'data','electrum','shop-start.lock')));
 }
});
test('changing the saved key or exposing RPC beyond loopback is rejected',async t=>{
 const f=fixture(t);const helper=await startElectrumHelper(f.options);await helper.stop();
 await assert.rejects(()=>startElectrumHelper({...f.options,masterPublicKey:fixtureKey(2)}),/different wallet/);
 const path=join(f.root,'data','electrum','config');const config=JSON.parse(readFileSync(path,'utf8'));config.rpchost='0.0.0.0';writeFileSync(path,JSON.stringify(config));
 await assert.rejects(()=>startElectrumHelper(f.options),/loopback/);
});
test('automatic discovery finds a conventional macOS Electrum app and honors a custom executable',t=>{
 const f=fixture(t);assert.equal(findElectrum({override:f.options.executable}),f.options.executable);
 const mac=join(f.root,'Applications','Electrum.app','Contents','MacOS');mkdirSync(mac,{recursive:true});writeFileSync(join(mac,'run_electrum'),'mock',{mode:0o700});
 assert.equal(findElectrum({platform:'darwin',home:f.root,env:{PATH:''}}),join(mac,'run_electrum'));
 assert.throws(()=>findElectrum({override:join(f.root,'missing')}),/not found/);
});
