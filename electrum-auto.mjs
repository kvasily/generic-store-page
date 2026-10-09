import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, readdirSync, accessSync, constants, openSync, closeSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, delimiter } from 'node:path';
import { createServer } from 'node:net';

const sha256=value=>createHash('sha256').update(value).digest();
export function validateShopPublicKey(key) {
  if(typeof key!=='string'||!/^([xyz]pub)[1-9A-HJ-NP-Za-km-z]{100,120}$/.test(key)) throw new Error('Use a Bitcoin mainnet master PUBLIC key (xpub, ypub or zpub), never a seed/private key.');
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n=0n;for(const c of key) n=n*58n+BigInt(alphabet.indexOf(c));
  let hex=n.toString(16);if(hex.length%2) hex='0'+hex;
  const bytes=Buffer.from(hex,'hex');const payload=bytes.subarray(0,-4);
  if(bytes.length!==82||!sha256(sha256(payload)).subarray(0,4).equals(bytes.subarray(-4))||!['0488b21e','049d7cb2','04b24746'].includes(payload.subarray(0,4).toString('hex'))||![2,3].includes(payload[45])) throw new Error('The master public key has an invalid checksum or format.');
  return key;
}
export function localWalletSettings(projectDir) {
  const file=join(projectDir,'electrum.local.json');
  if(!existsSync(file)) return null;
  let config;try{config=JSON.parse(readFileSync(file,'utf8'));}catch{throw new Error('electrum.local.json must contain valid JSON.');}
  return {masterPublicKey:validateShopPublicKey(config.masterPublicKey),executable:config.electrumExecutable||null};
}
export function findElectrum({override,env=process.env,platform=process.platform,home=homedir()}={}) {
  const candidates=[];
  if(override) candidates.push(resolve(override));
  else {
    for(const dir of (env.PATH||'').split(delimiter).filter(Boolean)) candidates.push(join(dir,platform==='win32'?'electrum.exe':'electrum'));
    if(platform==='darwin') {
      for(const base of ['/Applications',join(home,'Applications')]) for(const binary of ['run_electrum','Electrum','electrum']) candidates.push(join(base,'Electrum.app','Contents','MacOS',binary));
    }
    const dirs=platform==='win32'
      ?[env.LOCALAPPDATA&&join(env.LOCALAPPDATA,'Programs','Electrum'),env.PROGRAMFILES&&join(env.PROGRAMFILES,'Electrum'),env['PROGRAMFILES(X86)']&&join(env['PROGRAMFILES(X86)'],'Electrum')]
      :[join(home,'Applications'),join(home,'.local','bin')];
    for(const dir of dirs.filter(Boolean)) {
      try {for(const name of readdirSync(dir).sort().reverse()) if(platform==='win32'?/^electrum(?:-[\d.]+)?\.exe$/i.test(name):/^electrum.*\.AppImage$/i.test(name)) candidates.push(join(dir,name));} catch {}
    }
  }
  for(const path of candidates) {try{accessSync(path,platform==='win32'?constants.F_OK:constants.X_OK);return path;}catch{}}
  throw new Error('Electrum was not found. Install the desktop app, or set electrumExecutable to its executable path in electrum.local.json.');
}
export async function freePort() {
  const server=createServer();
  return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{const port=server.address().port;server.close(error=>error?reject(error):resolve(port));});});
}
async function rpc(connection,method,params={},fetcher=fetch,timeout=10000) {
  const id=randomUUID();
  const response=await fetcher(`http://127.0.0.1:${connection.rpcport}`,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Basic ${Buffer.from(`${connection.rpcuser}:${connection.rpcpassword}`).toString('base64')}`},body:JSON.stringify({jsonrpc:'2.0',id,method,params}),signal:AbortSignal.timeout(timeout)});
  if(!response.ok) throw new Error('The local Electrum helper did not accept the connection.');
  const result=await response.json();
  if(result.id!==id||result.error||!Object.hasOwn(result,'result')) throw new Error(`Electrum could not complete ${method}. Check the installed Electrum version and local wallet directory.`);
  return result.result;
}
function acquireSetupLock(dir) {
  const path=join(dir,'shop-start.lock');
  if(existsSync(path)) {
    let pid;try{pid=Number(readFileSync(path,'utf8'));}catch{}
    if(Number.isInteger(pid)&&pid>0) {
      try{process.kill(pid,0);throw new Error('Another shop process is preparing Electrum. Wait for it to finish.');}
      catch(error){if(error.code!=='ESRCH') throw error;}
      try{unlinkSync(path);}catch{}
    }
  }
  let fd;try{fd=openSync(path,'wx',0o600);}catch{throw new Error('Electrum setup is already in progress. Stop the earlier startup before retrying.');}
  writeFileSync(fd,String(process.pid));closeSync(fd);
  return ()=>{try{unlinkSync(path);}catch{}};
}
export async function startElectrumHelper({projectDir,masterPublicKey,executable,env=process.env,fetcher=fetch,spawnImpl=spawn,choosePort=freePort,wait=ms=>new Promise(r=>setTimeout(r,ms)),attempts=80}={}) {
  validateShopPublicKey(masterPublicKey);
  if(env.ELECTRUM_NETWORK&&env.ELECTRUM_NETWORK!=='mainnet') throw new Error('Automatic desktop setup uses Bitcoin mainnet. Use manual RPC configuration for test networks.');
  const dir=resolve(env.DATA_DIR||join(projectDir,'data'),'electrum');
  mkdirSync(dir,{recursive:true,mode:0o700});chmodSync(dir,0o700);
  const unlock=acquireSetupLock(dir);
  let child=null,failed=false;
  let connection;
  const stop=async()=>{
    if(!child || child.exitCode!==null) return;
    try{await rpc(connection,'stop',{},fetcher,2000);}catch{}
    if(child.exitCode===null) {
      const finished=new Promise(r=>child.once('exit',r));
      await Promise.race([finished,wait(2000)]);
      if(child.exitCode===null) child.kill('SIGTERM');
    }
  };
  try {
    const marker=join(dir,'shop-wallet-key.sha256');const fingerprint=sha256(masterPublicKey).toString('hex');
    const wallet=join(dir,'wallets','generic-store-page-watch-only');
    if(existsSync(marker)) {if(readFileSync(marker,'utf8').trim()!==fingerprint) throw new Error('This payment helper belongs to a different wallet. Keep the original key for existing orders.');}
    else {
      if(existsSync(wallet)||existsSync(join(dir,'config'))) throw new Error('The helper directory was not created by this shop. Choose an empty DATA_DIR or use manual RPC configuration.');
      writeFileSync(marker,fingerprint,{mode:0o600,flag:'wx'});
    }
    const configPath=join(dir,'config');
    if(existsSync(configPath)) {
      const saved=JSON.parse(readFileSync(configPath,'utf8'));
      // Only read the dedicated helper's connection fields; never inspect desktop wallet files.
      connection={rpcuser:saved.rpcuser,rpcpassword:saved.rpcpassword,rpchost:saved.rpchost,rpcport:saved.rpcport,rpcsock:saved.rpcsock};
      if(connection.rpchost!=='127.0.0.1'||!Number.isInteger(connection.rpcport)||connection.rpcport<1||connection.rpcport>65535||!connection.rpcuser||!connection.rpcpassword||connection.rpcsock!=='tcp') throw new Error('The dedicated Electrum helper must use authenticated loopback TCP.');
    } else {
      connection={rpchost:'127.0.0.1',rpcport:await choosePort(),rpcsock:'tcp',rpcuser:'generic-store-page',rpcpassword:randomBytes(32).toString('hex')};
      writeFileSync(configPath,JSON.stringify({config_version:3,...connection},null,2),{mode:0o600,flag:'wx'});
    }
    let running=false;
    try{running=await rpc(connection,'ping',{},fetcher,1000)===true;}catch{}
    if(!running) {
      const binary=findElectrum({override:executable||env.ELECTRUM_EXECUTABLE,env});
      child=spawnImpl(binary,['-D',dir,'daemon'],{stdio:'ignore',windowsHide:true});
      child.on('error',()=>{failed=true;});child.on('exit',()=>{failed=true;});
      for(let i=0;i<attempts;i++) {
        if(failed) break;
        try{if(await rpc(connection,'ping',{},fetcher,500)===true){running=true;break;}}catch{}
        await wait(250);
      }
      if(!running) throw new Error('Electrum could not start its private payment helper. Check electrumExecutable and that the installed app supports daemon commands.');
    }
    mkdirSync(join(dir,'wallets'),{recursive:true,mode:0o700});
    if(!existsSync(wallet)) {
      // The public key goes over local authenticated RPC, never in process arguments.
      await rpc(connection,'restore',{text:masterPublicKey,wallet_path:wallet,encrypt_file:false},fetcher);
    }
    await rpc(connection,'load_wallet',{wallet_path:wallet},fetcher);
    const actual=await rpc(connection,'getmpk',{wallet_path:wallet},fetcher);
    if(actual!==masterPublicKey) throw new Error('The helper wallet does not match your master public key.');
    return {stop,env:{ELECTRUM_RPC_URL:`http://127.0.0.1:${connection.rpcport}`,ELECTRUM_RPC_USER:connection.rpcuser,ELECTRUM_RPC_PASSWORD:connection.rpcpassword,ELECTRUM_WALLET:wallet,ELECTRUM_MASTER_PUBLIC_KEY:masterPublicKey,ELECTRUM_WATCH_ONLY:'true',ELECTRUM_NETWORK:'mainnet'}};
  } catch(error) {await stop();throw error;} finally {unlock();}
}
