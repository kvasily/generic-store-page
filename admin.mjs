// Local operator command; never exposed through a web route.
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateAdminRole, username, validUsername } from './accounts.mjs';
const root=dirname(fileURLToPath(import.meta.url));
const usage='Usage: npm run admin -- <username> [--revoke | --status]';
let db;
try {
  const [input,option,...extra]=process.argv.slice(2);
  const name=username(input);
  if(!validUsername(name)||extra.length||option&&!['--revoke','--status'].includes(option)) throw Error(usage);
  const path=resolve(process.env.DATA_DIR||resolve(root,'data'),'shop.sqlite');
  if(!existsSync(path)) throw Error('No shop database found. Use the same DATA_DIR as npm start, and create the customer account first.');
  db=new DatabaseSync(path);db.exec('PRAGMA busy_timeout=5000');
  if(!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='customers'").get()) throw Error('Customer accounts are not set up. Start the updated shop and register the user first.');
  const user=db.prepare('SELECT id,username FROM customers WHERE username=?').get(name);
  if(!user) throw Error('User not found. The user must register an account on the website first.');
  migrateAdminRole(db);
  if(option!=='--status') db.prepare('UPDATE customers SET is_admin=? WHERE id=?').run(option==='--revoke'?0:1,user.id);
  const role=db.prepare('SELECT is_admin FROM customers WHERE id=?').get(user.id).is_admin?'admin':'customer';
  console.log(`${user.username}: ${role}${option==='--status'?'':' (updated)'}`);
  if(role==='admin') console.log('Sign in to the website and open /admin. Role changes apply on the next request.');
} catch(error) {console.error(error.message);process.exitCode=1;} finally {db?.close();}
