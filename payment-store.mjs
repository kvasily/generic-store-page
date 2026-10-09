import { validateRequest, requestState, PaymentMismatch } from './payment.mjs';
export function migratePayments(db) {
  const columns=new Set(db.prepare('PRAGMA table_info(orders)').all().map(c=>c.name));
  const additions={payment_address:'TEXT',amount_sats:'INTEGER',expires_at:'INTEGER',min_confirmations:'INTEGER',rate:'TEXT',payment_network:'TEXT',full_seen_at:'INTEGER',confirmations:'INTEGER NOT NULL DEFAULT 0',verification_error:'INTEGER NOT NULL DEFAULT 0'};
  for(const [name,type] of Object.entries(additions)) if(!columns.has(name)) db.exec(`ALTER TABLE orders ADD COLUMN ${name} ${type}`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS orders_receiving_address ON orders(payment_address) WHERE payment_address IS NOT NULL');
}
export function attachRequest(db,order,request) {
  validateRequest(request,order);
  const previous=db.prepare('SELECT id FROM orders WHERE payment_address=?').get(request.address);
  if(previous && previous.id!==order.id) throw new PaymentMismatch('Electrum returned an address already allocated to another order');
  db.prepare("UPDATE orders SET invoice_id=?,payment_address=?,checkout_url=NULL,status='awaiting_payment',verification_error=0 WHERE id=? AND mode='electrum'").run(request.request_id,request.address,order.id);
}
export function saveVerification(db,order,request,timestamp=Math.floor(Date.now()/1000)) {
  const result=requestState(request,order,timestamp);
  db.prepare('UPDATE orders SET status=?,full_seen_at=?,confirmations=?,checked=?,verification_error=0 WHERE id=?').run(result.status,result.full_seen_at??null,result.confirmations,timestamp,order.id);
  return result.status;
}
