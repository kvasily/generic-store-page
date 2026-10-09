import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { localWalletSettings, startElectrumHelper } from './electrum-auto.mjs';
import { validateConfig } from './server.mjs';
const root=dirname(fileURLToPath(import.meta.url));
let helper,website,stopping=false;
async function stop(signal='SIGTERM') {
  if(stopping) return;stopping=true;
  if(website&&website.exitCode===null) website.kill(signal);
  if(helper) await helper.stop();
}
process.on('SIGINT',()=>stop('SIGINT'));
process.on('SIGTERM',()=>stop('SIGTERM'));
try {
  const local=localWalletSettings(root);
  const config=JSON.parse(readFileSync(resolve(root,'config/shop.json'),'utf8'));
  const env={...process.env};
  if(env.PAYMENT_MODE==='demo') console.log('Replacing the old demo setting with Bitcoin checkout.');
  env.PAYMENT_MODE='electrum';
  validateConfig(config,env.PAYMENT_MODE);
  const automatic=env.ELECTRUM_AUTOSTART!=='false' && (local || env.ELECTRUM_MASTER_PUBLIC_KEY && !env.ELECTRUM_RPC_PASSWORD || env.ELECTRUM_AUTOSTART==='true');
  if(!automatic && !env.ELECTRUM_RPC_PASSWORD) {
    console.error(`Electrum automatic setup was not selected. Expected public-key file: ${resolve(root,'electrum.local.json')}`);
    console.error('Save your electrum.local.json beside package.json. It is personal and is not downloaded by git pull. Run npm run doctor for configuration diagnostics.');
    if(env.ELECTRUM_AUTOSTART==='false') console.error('ELECTRUM_AUTOSTART=false disables the helper; remove that setting to use automatic setup.');
  }
  if(env.PAYMENT_MODE==='electrum'&&automatic) {
    console.log('Starting your private Electrum payment helper…');
    try {
      helper=await startElectrumHelper({projectDir:root,masterPublicKey:local?.masterPublicKey||env.ELECTRUM_MASTER_PUBLIC_KEY,executable:local?.executable,env});
      Object.assign(env,helper.env);
      console.log('Watch-only wallet connected. Payment requests wait for Electrum to finish synchronizing.');
    } catch(error) {
      console.error(`Electrum payment helper: ${error.message}`);
      env.PAYMENT_SERVICE_UNAVAILABLE='1';
      console.error('The shop will open with Bitcoin checkout. Fix the connection above and restart npm start to accept payments.');
    }
  }
  if(stopping) {if(helper) await helper.stop();process.exitCode=0;}
  else {
    const orders=process.argv[2]==='--orders';
    const check=process.argv[2]==='--payment-check';
    website=spawn(process.execPath,[resolve(root,orders?'orders.mjs':check?'payment-check.mjs':'server.mjs'),...(orders?process.argv.slice(3):[])],{cwd:root,env,stdio:'inherit'});
    website.once('error',async()=>{console.error('Could not start the shop process.');await stop();process.exitCode=1;});
    website.once('exit',async code=>{await stop();process.exitCode=code??0;});
  }
} catch(error) {console.error(`Could not start the shop: ${error.message}`);await stop();process.exitCode=1;}
