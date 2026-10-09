// Operator-only commands. This file and the database are never served publicly.
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createElectrum, PaymentMismatch } from './payment.mjs';
import { migratePayments, attachRequest, saveVerification } from './payment-store.mjs';
const path=resolve(process.env.DATA_DIR||'./data','shop.sqlite');
if(!existsSync(path)) {console.error('No order database at configured DATA_DIR.');process.exit(1);}
const db=new DatabaseSync(path);db.exec('PRAGMA busy_timeout=5000');migratePayments(db);
const [command,id]=process.argv.slice(2);
try {
  if(command==='list') console.table(db.prepare('SELECT id,mode,status,total,currency,amount_sats,confirmations,created,fulfilled FROM orders ORDER BY created DESC LIMIT 100').all());
  else {
    let order=db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    if(!order) throw Error('Order not found.');
    if(command==='show') console.log(JSON.stringify({...order,items:JSON.parse(order.items),address:JSON.parse(order.address)},null,2));
    else if(['sync','fulfill','recover'].includes(command)) {
      if(order.mode!=='electrum') throw Error('Only Electrum orders can be managed here. Demo and legacy orders cannot be fulfilled by this command.');
      const provider=createElectrum(process.env);
      if(command==='recover') {
        if(order.invoice_id || !order.amount_sats || !['creating','payment_error'].includes(order.status)) throw Error('This order does not have an unresolved Electrum request to recover.');
        // Recovery only attaches an existing matching request, never creates another one.
        attachRequest(db,order,await provider.recover(order));
        order=db.prepare('SELECT * FROM orders WHERE id=?').get(id);
      }
      if(!order.invoice_id) throw Error('No request attached. Use recover after checking the Electrum wallet.');
      let state;
      try {state=saveVerification(db,order,await provider.get(order));}
      catch(e) {
        db.prepare('UPDATE orders SET verification_error=1 WHERE id=?').run(id);
        if(e instanceof PaymentMismatch) db.prepare("UPDATE orders SET status='review' WHERE id=?").run(id);
        throw e;
      }
      if(command==='fulfill') {
        if(state!=='paid') throw Error('Payment is not fully confirmed within the checkout terms. Do not ship automatically.');
        db.prepare('UPDATE orders SET fulfilled=1 WHERE id=?').run(id);
      }
      console.log(`${id}: ${state}${command==='fulfill'?' (marked fulfilled)':''}`);
    } else throw Error('Usage: node --env-file-if-exists=.env orders.mjs list | show ORDER | sync ORDER | recover ORDER | fulfill ORDER');
  }
} catch(error) {console.error(error.message);process.exitCode=1;} finally {db.close();}
