import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const derive=promisify(scrypt);
const options={N:32768,r:8,p:1,maxmem:64*1024*1024};
export function migrateAccounts(db) {
  db.exec('CREATE TABLE IF NOT EXISTS customers (id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created INTEGER NOT NULL)');
  migrateAdminRole(db);
  for(const table of ['sessions','orders']) {
    if(!db.prepare(`PRAGMA table_info(${table})`).all().some(c=>c.name==='user_id')) db.exec(`ALTER TABLE ${table} ADD COLUMN user_id TEXT`);
  }
  db.exec('CREATE INDEX IF NOT EXISTS orders_customer ON orders(user_id,created)');
}
export function username(value) {return String(value||'').trim().normalize('NFC').toLowerCase().normalize('NFC');}
export function validUsername(value) {return typeof value==='string'&&value.length>=3&&value.length<=32&&value.trim().length>0&&!/[\p{Cc}\p{Cs}\u202a-\u202e\u2066-\u2069]/u.test(value);}
export function validPassword(value) {return typeof value==='string'&&value.length>=12&&value.length<=128;}
export async function hashPassword(password) {
  const salt=randomBytes(16).toString('hex');
  const key=await derive(password,salt,32,options);
  return `scrypt$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password,stored) {
  const [,salt,expected]=(stored||'scrypt$00000000000000000000000000000000$'+'00'.repeat(32)).split('$');
  const key=await derive(password,salt,32,options);
  return timingSafeEqual(key,Buffer.from(expected,'hex'))&&Boolean(stored);
}

export function migrateAdminRole(db) {
  if(!db.prepare('PRAGMA table_info(customers)').all().some(c=>c.name==='is_admin')) {
    db.exec('ALTER TABLE customers ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0 CHECK (is_admin IN (0,1))');
  }
}
