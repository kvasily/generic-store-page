import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localWalletSettings, findElectrum, validateShopPublicKey } from './electrum-auto.mjs';

// Read-only diagnostics: never print environment values, keys or RPC passwords.
export function diagnose({projectDir,env=process.env,discover=findElectrum}={}) {
  const lines=[];
  let issues=0,local=null;
  const pass=message=>lines.push(`OK: ${message}`);
  const fail=message=>{issues++;lines.push(`FIX: ${message}`);};
  lines.push(`Node ${process.version}; platform ${process.platform}`);
  lines.push(`Shop directory: ${projectDir}`);
  lines.push(`Expected key file: ${resolve(projectDir,'electrum.local.json')}`);
  lines.push(existsSync(resolve(projectDir,'.env'))?'.env exists.':'.env is absent; this is normal for automatic setup.');
  try {local=localWalletSettings(projectDir);} catch {fail('electrum.local.json is invalid. Use valid JSON with a valid mainnet masterPublicKey.');}
  if(local) pass('Local public-key file found and checksum validated.');
  else if(env.ELECTRUM_MASTER_PUBLIC_KEY) {
    try {validateShopPublicKey(env.ELECTRUM_MASTER_PUBLIC_KEY);pass('Environment public key validated.');}
    catch {fail('Environment public key has an invalid format or checksum.');}
  } else fail('No master public key found. Save electrum.local.json beside package.json, then restart npm start. Git does not include this personal file.');
  const automatic=env.ELECTRUM_AUTOSTART!=='false' && Boolean(local || env.ELECTRUM_MASTER_PUBLIC_KEY&&!env.ELECTRUM_RPC_PASSWORD || env.ELECTRUM_AUTOSTART==='true');
  lines.push(`Automatic helper selected: ${automatic?'yes':'no'}`);
  if(env.ELECTRUM_AUTOSTART==='false') lines.push('Automatic helper is explicitly disabled by ELECTRUM_AUTOSTART=false.');
  if(automatic || !env.ELECTRUM_RPC_PASSWORD) {
    try {discover({override:local?.executable||env.ELECTRUM_EXECUTABLE,env});pass('Electrum executable found.');}
    catch {fail('Electrum executable not found. Install Electrum or set electrumExecutable in electrum.local.json to its executable path.');}
  }
  if(!automatic) {
    for(const field of ['ELECTRUM_RPC_URL','ELECTRUM_RPC_USER','ELECTRUM_RPC_PASSWORD','ELECTRUM_WALLET','ELECTRUM_MASTER_PUBLIC_KEY']) {
      lines.push(`${field}: ${env[field]?'set (value hidden)':'missing'}`);
    }
    if(!['ELECTRUM_RPC_URL','ELECTRUM_RPC_USER','ELECTRUM_RPC_PASSWORD','ELECTRUM_WALLET','ELECTRUM_MASTER_PUBLIC_KEY'].every(k=>env[k])||env.ELECTRUM_WATCH_ONLY!=='true') fail('Manual RPC configuration is incomplete. For automatic setup, supply the local public-key file and remove ELECTRUM_AUTOSTART=false.');
  }
  lines.push('This check does not start Electrum or verify RPC connectivity, synchronization, or payments.');
  lines.push(issues?'Fix the items above, then run npm start.':'Configuration checks passed. Run npm start to connect; checkout also verifies wallet identity and synchronization.');
  return {lines,issues};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const result=diagnose({projectDir:dirname(fileURLToPath(import.meta.url))});
  console.log(result.lines.join('\n'));process.exitCode=result.issues?1:0;
}
