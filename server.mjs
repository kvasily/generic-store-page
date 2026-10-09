import { fields as appearanceFields, defaults as appearanceDefaults, fonts, validateAppearance, appearanceCSS, applyCatalogText } from './appearance.mjs';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElectrum, bitcoinAmount, paymentURI, PaymentMismatch, safeOrigin } from './payment.mjs';
import { migrateAccounts, username, validUsername, validPassword, hashPassword, verifyPassword } from './accounts.mjs';
import { migratePayments, attachRequest, saveVerification } from './payment-store.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const token = () => randomBytes(32).toString('hex');
const hash = value => createHash('sha256').update(value).digest('hex');
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const now = () => Math.floor(Date.now()/1000);
const statusText = {creating:'Preparing Bitcoin payment',payment_unavailable:'Bitcoin payment temporarily unavailable',payment_error:'Payment setup needs review',partial:'Partial payment detected',awaiting_payment:'Awaiting Bitcoin payment',confirming:'Payment received — awaiting confirmation',paid:'Payment confirmed',expired:'Payment window expired',invalid:'Payment requires review',review:'Payment requires review',demo:'Demo order — no payment requested'};
class UserError extends Error { constructor(message, status=400) {super(message);this.status=status;} }

export function validateConfig(config, mode) {
  if (!['demo','electrum'].includes(mode)) throw new Error('PAYMENT_MODE must be demo or electrum');
  // Two decimal price currencies only; each Bitcoin quote is saved with the order.
  if (!['USD','EUR','GBP','CAD','AUD'].includes(config.currency)) throw new Error('Unsupported pricing currency');
  if (!Number.isSafeInteger(config.shippingCents) || config.shippingCents<0 || config.shippingCents>100000) throw new Error('Invalid shipping charge');
  if (!Array.isArray(config.shippingCountries) || !config.shippingCountries.length || !config.shippingCountries.every(x => /^[A-Z]{2}$/.test(x))) throw new Error('Use two-letter shipping country codes');
  const ids = new Set();
  if (!config.products?.length) throw new Error('Products are required');
  for (const p of config.products) {
    if (!/^[a-zA-Z0-9_-]{1,40}$/.test(p.id) || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || !Number.isSafeInteger(p.priceCents) || p.priceCents<=0 || p.priceCents>100000) throw new Error('Invalid product');
    ids.add(p.id);
  }
}

export function createShop({env=process.env, config=JSON.parse(readFileSync(resolve(ROOT,'config/shop.json'),'utf8')), dbPath, provider}={}) {
  const mode=env.PAYMENT_MODE||'electrum';
  validateConfig(config,mode);
  const origin=safeOrigin(env.SHOP_ORIGIN||'http://127.0.0.1:8080',{loopback:true,onion:true});
  const secure=new URL(origin).protocol==='https:';
  let paymentConfigured=true;
  if (mode==='electrum' && !provider) {
    try {
      if(env.PAYMENT_SERVICE_UNAVAILABLE) throw new Error('Electrum helper is unavailable');
      provider=createElectrum(env);
    } catch(error) {
      paymentConfigured=false;
      console.error(`Bitcoin checkout connection: ${error.message}. Check electrum.local.json and your Electrum installation, then restart npm start.`);
      const unavailable=async()=>{throw new Error('Electrum payment service is not connected');};
      provider={prepare:unavailable,create:unavailable,get:unavailable,recover:unavailable};
    }
  }
  const dataDir=resolve(env.DATA_DIR||resolve(ROOT,'data'));
  if (!dbPath) { mkdirSync(dataDir,{recursive:true,mode:0o700}); chmodSync(dataDir,0o700); dbPath=resolve(dataDir,'shop.sqlite'); }
  const db=new DatabaseSync(dbPath);
  if (dbPath!==':memory:') chmodSync(dbPath,0o600);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, csrf TEXT NOT NULL, cart TEXT NOT NULL DEFAULT '{}', expires INTEGER NOT NULL, active_order TEXT);
    CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, mode TEXT NOT NULL, items TEXT NOT NULL, subtotal INTEGER NOT NULL, shipping INTEGER NOT NULL, total INTEGER NOT NULL, currency TEXT NOT NULL, address TEXT NOT NULL, status TEXT NOT NULL, invoice_id TEXT UNIQUE, checkout_url TEXT, created INTEGER NOT NULL, checked INTEGER NOT NULL DEFAULT 0, fulfilled INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS orders_session ON orders(session_id);
    CREATE TABLE IF NOT EXISTS limits (session_id TEXT NOT NULL, bucket TEXT NOT NULL, start INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(session_id,bucket));`);
  migratePayments(db);
  migrateAccounts(db);
  db.exec("CREATE TABLE IF NOT EXISTS appearance_settings (id INTEGER PRIMARY KEY CHECK(id=1), settings TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0)");
  db.prepare('INSERT OR IGNORE INTO appearance_settings(id,settings,revision) VALUES(1,?,0)').run(JSON.stringify(appearanceDefaults));
  const appearance=()=>{const row=db.prepare('SELECT * FROM appearance_settings WHERE id=1').get();return {values:{...appearanceDefaults,...JSON.parse(row.settings)},revision:row.revision};};
  const query=(sql,...params)=>db.prepare(sql).get(...params);
  const run=(sql,...params)=>db.prepare(sql).run(...params);
  const money=(cents,currency=config.currency)=>new Intl.NumberFormat('en',{style:'currency',currency}).format(cents/100);
  const products=new Map(config.products.map(p=>[p.id,p]));
  const demo=mode==='demo';
  const csrf=s=>`<input type="hidden" name="csrf" value="${s.csrf}">`;
  function form(s, action, body, label, cls='button') {return `<form action="${action}" method="post">${csrf(s)}${body}<button class="${cls}" type="submit">${label}</button></form>`;}
  const accountLink=s=>`<a href="${s.user_id?'/account':'/login'}">${s.user_id?'My account':'Log in'}</a>`;
  let authInFlight=0;
  function accountPage(s,register=false,error='',next='/account') {
    const title=register?'Make yourself at home.':'Welcome back.';
    const fields=`<label>Username<input name="username" autocomplete="username" minlength="3" maxlength="32" required aria-describedby="username-help"></label><p class="muted" id="username-help">3–32 characters. Symbols, punctuation, spaces and Unicode are welcome. Usernames are case-insensitive; outer spaces are removed.</p><label>Password<input type="password" name="password" autocomplete="${register?'new-password':'current-password'}" ${register?'minlength="12"':''} maxlength="128" required></label>${register?'<p class="muted">Use 12–128 characters. Keep your password safe; password reset is not available yet.</p><label>Confirm password<input type="password" name="confirm" autocomplete="new-password" minlength="12" maxlength="128" required></label>':''}`;
    return layout(register?'Create account':'Log in',`<div class="account-layout"><section class="account-intro"><p class="eyebrow">YOUR STORE / YOUR ACCOUNT</p><h1>${title}</h1><p>Sign in to view your orders and check their payment status.</p><a href="/">Explore the product collection →</a></section><section class="account-card"><h2>${register?'Create your account':'Log in'}</h2>${error?`<p class="notice" role="alert">${esc(error)}</p>`:''}${form(s,(register?'/register':'/login')+'?next='+encodeURIComponent(next),fields,register?'Create account':'Log in')}<p>${register?`Already have an account? <a href="/login?next=${encodeURIComponent(next)}">Log in</a>`:`New here? <a href="/register?next=${encodeURIComponent(next)}">Create an account</a>`}</p><p class="muted">No email required. An account is required to check out. <a href="/cart">Return to your cart</a>.</p></section></div>`,s);
  }
  function rotateSession(old,res,userId) {
    const current=query('SELECT * FROM sessions WHERE id=? AND expires>?',old.id,now());
    if(!current) throw new UserError('Your session changed. Reload the page and try again.',409);
    const value=token();
    const fresh={id:hash(value),csrf:token(),cart:userId?current.cart:'{}',active_order:userId?current.active_order:null,expires:now()+7*86400,user_id:userId};
    db.exec('BEGIN IMMEDIATE');
    try {
      run('INSERT INTO sessions (id,csrf,cart,expires,active_order,user_id) VALUES (?,?,?,?,?,?)',fresh.id,fresh.csrf,fresh.cart,fresh.expires,fresh.active_order,userId);
      if(userId) run('UPDATE orders SET user_id=?,session_id=? WHERE session_id=? AND user_id IS NULL',userId,fresh.id,old.id);
      run('DELETE FROM sessions WHERE id=?',old.id);
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
    res.setHeader('Set-Cookie',`store_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure?'; Secure':''}`);
    return fresh;
  }
  function layout(title,body,s) {
    const a=appearance().values;
    const count=Object.values(JSON.parse(s.cart)).reduce((a,b)=>a+b,0);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>${esc(title)} — ${esc(a.brand)}</title><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/theme.css"></head><body><a class="skip" href="#main">Skip to content</a><div class="preview">${demo?'DEMO CHECKOUT · SAMPLE PRICES · NO REAL PAYMENTS':'BITCOIN PAYMENTS ONLY'}</div><header class="shell"><a class="brand" href="/">${esc(a.brand)}</a><nav aria-label="Main navigation"><a href="/">Catalog</a><a href="/cart">Cart (${count})</a>${accountLink(s)}</nav></header><main class="shell checkout-main" id="main">${body}</main><footer class="shell"><p>${demo?'Use invented shipping details when trying the demo.':'Bitcoin network fees are paid separately in your wallet.'}</p><a href="/">Back to catalog</a></footer></body></html>`;
  }
  function catalogPage(s,url,settings) {
        let page=readFileSync(resolve(ROOT,'public/index.html'),'utf8');
        page=page.replace('<!-- account-link -->',accountLink(s));
        const cart=JSON.parse(s.cart);
        page=page.replace('<!-- cart-count -->',Object.values(cart).reduce((a,b)=>a+b,0));
        for(const p of config.products) {
          const added=url.searchParams.get('added')===p.id&&cart[p.id];
          const feedback=added?`${p.name} added. ${cart[p.id]} in your cart.`:'';
          const addForm=form(s,'/cart/add',`<input type="hidden" name="product" value="${esc(p.id)}">`,'Add to cart').replace('<form ', '<form data-add-to-cart ');
          page=page.replace(`<!-- buy-${p.id} -->`,`${addForm}<p class="cart-feedback" data-cart-feedback role="status" aria-live="polite">${esc(feedback)}</p>`);
          page=page.replace(`data-price="${p.id}">Coming soon`, `data-price="${p.id}">${money(p.priceCents)}${demo?' · demo':''}`);
        }
        page=page.replace('Sample brand &amp; products · Ordering is not open',demo?'Demo prices · No real payments':'Bitcoin payments only');
        page=page.replace('Catalog preview · No orders or payments yet',demo?'Demo checkout · No real payments':'Pay with Bitcoin');
        return applyCatalogText(page,settings,esc);
  }
  function cartLines(s) {
    return Object.entries(JSON.parse(s.cart)).map(([id,quantity])=>{const product=products.get(id); if (!product || !Number.isInteger(quantity) || quantity<1 || quantity>10) throw new UserError('Your cart is no longer valid. Please start a new session.');return {...product,quantity,lineTotal:product.priceCents*quantity};});
  }
  function totals(items) {const subtotal=items.reduce((a,p)=>a+p.lineTotal,0);return {subtotal,shipping:config.shippingCents,total:subtotal+config.shippingCents};}
  function summary(items, total) {const currency=total.currency||config.currency;return `<section class="order-summary"><h2>Your order</h2>${items.map(p=>`<div class="summary-line"><span>${esc(p.name)} × ${p.quantity}</span><strong>${money(p.lineTotal,currency)}</strong></div>`).join('')}<div class="summary-line"><span>Subtotal</span><span>${money(total.subtotal,currency)}</span></div><div class="summary-line"><span>Shipping</span><span>${money(total.shipping,currency)}</span></div><div class="summary-line grand-total"><span>Total (${currency})</span><strong>${money(total.total,currency)}</strong></div><p class="muted">${demo?'Sample prices and shipping for demonstration.': 'Bitcoin network fees are additional.'}</p></section>`;}
  function limit(s,bucket,max,seconds=60) {
    const row=query('SELECT * FROM limits WHERE session_id=? AND bucket=?',s.id,bucket);
    if (row && now()-row.start<seconds && row.count>=max) throw new UserError('Please wait a moment before trying again.',429);
    if (!row || now()-row.start>=seconds) run('INSERT OR REPLACE INTO limits VALUES (?,?,?,1)',s.id,bucket,now());
    else run('UPDATE limits SET count=count+1 WHERE session_id=? AND bucket=?',s.id,bucket);
  }
  const inFlight=new Set();
  async function beginPayment(id) {
    if(inFlight.has(id)) return;
    let order=query('SELECT * FROM orders WHERE id=?',id);
    if(!['demo','payment_unavailable','creating','payment_error'].includes(order.status)||order.invoice_id) return;
    inFlight.add(id);
    // Persist the reservation boundary before contacting Electrum. A crash or
    // timeout after that boundary must recover the same request, never allocate again.
    let reserved=order.amount_sats!==null;
    try {
      if(reserved) {
        const request=await provider.recover(order);
        attachRequest(db,order,request);
        return;
      }
      run("UPDATE orders SET mode='electrum',status='creating' WHERE id=?",id);
      order=query('SELECT * FROM orders WHERE id=?',id);
      const quote=await provider.prepare(order);
      run('UPDATE orders SET amount_sats=?,rate=?,expires_at=?,min_confirmations=?,payment_network=? WHERE id=?',quote.amount_sats,quote.rate,quote.expires_at,quote.min_confirmations,quote.payment_network,id);
      reserved=true;
      order=query('SELECT * FROM orders WHERE id=?',id);
      attachRequest(db,order,await provider.create(order));
    } catch(error) {
      run('UPDATE orders SET status=? WHERE id=?',reserved?'payment_error':'payment_unavailable',id);
      console.error(`Bitcoin payment ${id}: ${error.message}`);
    } finally {inFlight.delete(id);}
  }
  async function reconcile(id) {
    const o=query('SELECT * FROM orders WHERE id=?',id);
    if (mode!=='electrum' || !o || o.mode!=='electrum' || !o.invoice_id || inFlight.has(id)) return;
    inFlight.add(id);
    run('UPDATE orders SET checked=? WHERE id=?',now(),id);
    try {
      const request=await provider.get(o);
      saveVerification(db,o,request);
    } catch(error) {
      run('UPDATE orders SET verification_error=1 WHERE id=?',id);
      if(error instanceof PaymentMismatch) run("UPDATE orders SET status='review' WHERE id=?",id);
      throw error;
    }
    finally {inFlight.delete(id);}
  }
  let polling=false;
  async function reconcilePending() {
    if(polling) return;
    polling=true;
    try {
    const orders=db.prepare("SELECT id FROM orders WHERE mode='electrum' AND invoice_id IS NOT NULL AND fulfilled=0 AND checked < ? ORDER BY checked LIMIT 100").all(now()-55);
    for (const o of orders) {try {await reconcile(o.id);} catch { /* Retry later; never claim payment from an unavailable provider. */ }}
    } finally {polling=false;}
  }
  async function body(req) {
    if (!(req.headers['content-type']||'').startsWith('application/x-www-form-urlencoded')) throw new UserError('Unsupported form submission.',415);
    let content='';for await (const chunk of req) {content+=chunk.toString();if(Buffer.byteLength(content)>16384) throw new UserError('Form is too large.',413);}
    const values=new URLSearchParams(content);
    for (const key of new Set(values.keys())) if (values.getAll(key).length!==1) throw new UserError('Duplicate form field.');
    return values;
  }
  function session(req,res) {
    const cookie=(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('store_session='))?.slice('store_session='.length);
    let s=cookie && /^[a-f0-9]{64}$/.test(cookie) ? query('SELECT * FROM sessions WHERE id=? AND expires>?',hash(cookie),now()):null;
    if (!s) {const value=token();s={id:hash(value),csrf:token(),cart:'{}',expires:now()+7*86400,active_order:null};run('INSERT INTO sessions (id,csrf,cart,expires) VALUES (?,?,?,?)',s.id,s.csrf,s.cart,s.expires);res.setHeader('Set-Cookie',`store_session=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secure?'; Secure':''}`);}
    return s;
  }
  function textInput(name,label,autocomplete,optional=false,type='text') {return `<label>${label}${optional?' (optional)':''}<input type="${type}" name="${name}" autocomplete="${autocomplete}" maxlength="${name==='email'?254:120}" ${optional?'':'required'}></label>`;}
  function addressFrom(values) {
    const result={};
    for(const key of ['name','email','line1','line2','city','region','postal','country']) {
      const value=(values.get(key)||'').trim();
      if(value.length>(key==='email'?254:120)||/[\x00-\x1f\x7f]/.test(value)) throw new UserError('Please check your shipping details.');
      if(!value&&!['email','line2','region','postal'].includes(key)) throw new UserError('Complete all required shipping fields.');
      result[key]=value;
    }
    if(result.email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(result.email)) throw new UserError('Enter a valid email address or leave it blank.');
    if(!config.shippingCountries.includes(result.country)) throw new UserError('Shipping is unavailable for that country.');
    return result;
  }
  function ownedOrder(id,s) {const o=query('SELECT * FROM orders WHERE id=? AND ((user_id IS NULL AND session_id=?) OR (user_id IS NOT NULL AND user_id=?))',id,s.id,s.user_id||null);if(!o) throw new UserError('Order not found in this browser session.',404);return o;}
  async function handler(req,res) {
    const headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"};
    for(const [k,v] of Object.entries(headers)) res.setHeader(k,v);
    const send=(html,status=200)=>{res.statusCode=status;res.end(html);};
    const redirect=path=>{res.statusCode=303;res.setHeader('Location',path);res.end();};
    let s;
    try {
      if ((req.headers.host||'').toLowerCase()!==new URL(origin).host.toLowerCase()) throw new UserError('Open the shop using its configured SHOP_ORIGIN address.',421);
      if (!['GET','POST','HEAD'].includes(req.method)) throw new UserError('Method not allowed.',405);
      const url=new URL(req.url,origin);
      const path=url.pathname;
      const requestedNext=url.searchParams.get('next');
      const next=requestedNext==='/checkout'||/^\/orders\/[a-f0-9]{64}$/.test(requestedNext||'')?requestedNext:'/account';
      if(req.method==='GET' && path==='/theme.css') {res.setHeader('Content-Type','text/css; charset=utf-8');return res.end(appearanceCSS(appearance().values));}
      if(req.method!=='POST' && path==='/styles.css') {res.setHeader('Content-Type','text/css; charset=utf-8');return res.end(readFileSync(resolve(ROOT,'public/styles.css')));}
      if(req.method!=='POST' && path==='/cart.js') {res.setHeader('Content-Type','text/javascript; charset=utf-8');return res.end(readFileSync(resolve(ROOT,'public/cart.js')));}
      if(req.method==='HEAD') return send('',200);
      s=session(req,res);
      let values;
      if(req.method==='POST') {
        // Privacy settings can serialize a same-site form's Origin as null.
        // A valid session-bound CSRF token remains mandatory in every case.
        if(req.headers.origin && req.headers.origin!=='null' && req.headers.origin!==origin) throw new UserError('Invalid request origin.',403);
        if(req.headers['sec-fetch-site']==='cross-site') throw new UserError('Cross-site form rejected.',403);
        values=await body(req);
        const submitted=Buffer.from(values.get('csrf')||'');const expected=Buffer.from(s.csrf);
        if(submitted.length!==expected.length || !timingSafeEqual(submitted,expected)) throw new UserError('Your form expired. Reload the page and try again.',403);
        s=query('SELECT * FROM sessions WHERE id=?',s.id);
        if(!s) throw new UserError('Your session changed. Reload the page and try again.',409);
        limit(s,'writes',40);
      }
      if(req.method==='GET' && ['/login','/register'].includes(path)) {
        if(s.user_id) return redirect(next);
        return send(accountPage(s,path==='/register','',next));
      }
      if(req.method==='POST' && ['/login','/register'].includes(path)) {
        if(s.user_id) return redirect(next);
        const register=path==='/register';
        const name=username(values.get('username'));
        const password=values.get('password')||'';
        limit(s,'authentication',10,900);
        limit({id:'auth-name:'+hash(name)},'authentication',10,900);
        limit({id:'auth-global'},'authentication',120,900);
        if(!validUsername(name)||!validPassword(password)) return send(accountPage(s,register,register?'Choose a valid username and a password of 12–128 characters.':'Username or password is incorrect.',next),400);
        if(register&&password!==values.get('confirm')) return send(accountPage(s,true,'Passwords do not match.',next),400);
        if(authInFlight>=4) throw new UserError('Sign-in is busy. Please try again shortly.',429);
        authInFlight++;
        try {
          let user=query('SELECT * FROM customers WHERE username=?',name);
          if(register) {
            const passwordHash=await hashPassword(password);
            if(!query('SELECT id FROM sessions WHERE id=?',s.id)) throw new UserError('Your session changed. Reload the page and try again.',409);
            const id=token();
            const result=run('INSERT OR IGNORE INTO customers (id,username,password_hash,created) VALUES (?,?,?,?)',id,name,passwordHash,now());
            if(!result.changes) return send(accountPage(s,true,'That username is unavailable. Choose another or log in.',next),400);
            user={id};
          } else {
            if(!await verifyPassword(password,user?.password_hash)) return send(accountPage(s,false,'Username or password is incorrect.',next),401);
          }
          s=rotateSession(s,res,user.id);
          return redirect(next);
        } finally {authInFlight--;}
      }
      if(req.method==='POST' && path==='/logout') {
        s=rotateSession(s,res,null);
        return redirect('/login');
      }
      if(path==='/admin'||path.startsWith('/admin/')) {
        if(!s.user_id) return redirect('/login');
        const admin=query('SELECT is_admin FROM customers WHERE id=?',s.user_id);
        if(admin?.is_admin!==1) throw new UserError('Administrator access required.',403);
        if(['/admin/appearance','/admin/appearance/preview','/admin/appearance/reset'].includes(path)) {
          if(req.method==='GET'&&path==='/admin/appearance') {
            const saved=appearance();
            const control=(key,f)=>`<label>${esc(f.label)}${f.type==='font'?`<select name="${key}">${Object.entries(fonts).map(([id,font])=>`<option value="${id}" ${saved.values[key]===id?'selected':''}>${font.label}</option>`).join('')}</select>`:f.type==='color'?`<input type="color" name="${key}" value="${esc(saved.values[key])}" required>`:`<textarea name="${key}" maxlength="${f.max}" rows="${f.max>500?4:2}" required>${esc(saved.values[key])}</textarea>`}</label>`;
            const group=type=>Object.entries(appearanceFields).filter(([,f])=>(f.type||'text')===type).map(([key,f])=>control(key,f)).join('');
            return send(layout('Appearance editor',`<p class="eyebrow">SHOP ADMINISTRATION</p><h1>Make the shop yours.</h1><p>Preview your changes in a new tab, then save to update the storefront. Fonts are built in; no external font requests.</p>${url.searchParams.has('saved')?'<p class="notice" role="status">Appearance saved.</p>':''}<form action="/admin/appearance" method="post">${csrf(s)}<input type="hidden" name="revision" value="${saved.revision}"><div class="appearance-editor"><section><h2>Colors</h2><div class="color-controls">${group('color')}</div><h2>Typography</h2>${group('font')}</section><section><h2>Storefront text</h2>${group('text')}</section></div><button class="button secondary" type="submit" formaction="/admin/appearance/preview" formtarget="_blank">Preview in new tab</button> <button class="button" type="submit">Save appearance</button></form><details><summary>Restore the original appearance</summary><p>This replaces your saved colors, fonts and storefront text with the original defaults.</p>${form(s,'/admin/appearance/reset',`<input type="hidden" name="revision" value="${saved.revision}">`,'Restore defaults','button secondary')}</details><p><a href="/admin">Back to orders</a></p>`,s));
          }
          if(req.method!=='POST') throw new UserError('Method not allowed.',405);
          let settings;
          try {settings=path.endsWith('/reset')?appearanceDefaults:validateAppearance(Object.fromEntries(values));}
          catch(error) {throw new UserError(error.message);}
          if(path.endsWith('/preview')) {
            const nonce=token();
            res.setHeader('Content-Security-Policy',headers['Content-Security-Policy'].replace("style-src 'self'",`style-src 'self' 'nonce-${nonce}'`));
            const page=catalogPage(s,new URL('/',origin),settings).replace('</head>',`<style nonce="${nonce}">${appearanceCSS(settings)}</style></head>`).replace('<body>','<body><div class="notice" role="status">Preview only — changes have not been saved. Return to the editor tab to save or continue editing.</div>');
            return send(page);
          }
          const revision=values.get('revision');
          if(!/^\d+$/.test(revision||'')) throw new UserError('Reload the editor before saving.',409);
          const result=run('UPDATE appearance_settings SET settings=?,revision=revision+1 WHERE id=1 AND revision=?',JSON.stringify(settings),Number(revision));
          if(!result.changes) throw new UserError('Another administrator changed the appearance. Reload the editor before saving.',409);
          return redirect('/admin/appearance?saved=1');
        }
        if(req.method!=='GET') throw new UserError('Method not allowed.',405);
        if(path==='/admin') {
          const page=Math.max(1,Math.min(100000,Number.parseInt(url.searchParams.get('page'),10)||1));
          const orders=db.prepare('SELECT id,created,total,currency,status,fulfilled FROM orders ORDER BY created DESC,id DESC LIMIT 51 OFFSET ?').all((page-1)*50);
          return send(layout('Shop administration',`<p class="eyebrow">SHOP ADMINISTRATION</p><h1>Orders.</h1><a class="button" href="/admin/appearance">Customize appearance →</a><p>All customer and guest orders. Payment status is the last saved state.</p><div class="account-orders">${orders.slice(0,50).map(o=>`<article class="account-order"><div><p class="eyebrow">${new Date(o.created*1000).toISOString().slice(0,10)} · UTC</p><h3><a href="/admin/orders/${o.id}">Order ${o.id.slice(0,12)}</a></h3><p>${esc(statusText[o.status]||o.status)} · ${o.fulfilled?'Fulfilled':'Unfulfilled'}</p></div><strong>${money(o.total,o.currency)}</strong></article>`).join('')||'<p class="notice">No orders yet.</p>'}</div><nav aria-label="Admin order pages">${page>1?`<a href="/admin?page=${page-1}">Previous</a>`:''}${orders.length>50?`<a href="/admin?page=${page+1}">Next</a>`:''}</nav><p class="muted">This dashboard is read-only. Use the local order-management commands to verify payment and mark orders fulfilled.</p><a href="/account">My account</a>`,s));
        }
        const adminOrder=/^\/admin\/orders\/([a-f0-9]{64})$/.exec(path);
        if(adminOrder) {
          const order=query('SELECT * FROM orders WHERE id=?',adminOrder[1]);
          if(!order) throw new UserError('Order not found.',404);
          const address=JSON.parse(order.address);
          return send(layout('Order details',`<p class="eyebrow">SHOP ADMINISTRATION</p><h1>Order details.</h1><p class="order-reference">${order.id}</p><p>${esc(statusText[order.status]||order.status)} · ${order.fulfilled?'Fulfilled':'Unfulfilled'}</p><p class="muted">Last saved payment state; verify payment before shipping.</p><div class="checkout-grid"><section><h2>Shipping details</h2><p>${[address.name,address.line1,address.line2,address.city,address.region,address.postal,address.country,address.email].filter(Boolean).map(esc).join('<br>')}</p></section>${summary(JSON.parse(order.items),order)}</div><a href="/admin">Back to all orders</a>`,s));
        }
        throw new UserError('Page not found.',404);
      }
      if(req.method==='GET' && path==='/account') {
        if(!s.user_id) return redirect('/login');
        const user=query('SELECT username,is_admin FROM customers WHERE id=?',s.user_id);
        const page=Math.max(1,Math.min(100000,Number.parseInt(url.searchParams.get('page'),10)||1));
        const orders=db.prepare('SELECT id,created,total,currency,status FROM orders WHERE user_id=? ORDER BY created DESC,id DESC LIMIT 21 OFFSET ?').all(s.user_id,(page-1)*20);
        return send(layout('My account',`<p class="eyebrow">YOUR ACCOUNT</p><h1>Hello, ${esc(user.username)}.</h1><p>Your orders, all in one place.</p>${user.is_admin?'<p><a class="button" href="/admin">Shop administration →</a></p>':''}${form(s,'/logout','','Log out','button secondary')}<h2>Order history</h2>${orders.length?`<div class="account-orders">${orders.slice(0,20).map(o=>`<article class="account-order"><div><p class="eyebrow">${new Date(o.created*1000).toISOString().slice(0,10)} · UTC</p><h3><a href="/orders/${o.id}">Order ${o.id.slice(0,12)}</a></h3><p>${esc(statusText[o.status]||'Order saved')}</p></div><strong>${money(o.total,o.currency)}</strong><a class="button secondary" href="/orders/${o.id}">View order →</a></article>`).join('')}</div>`:'<p class="notice">No orders yet. Browse the catalog to place your first order.</p><a class="button" href="/">Browse products</a>'}<nav aria-label="Order history pages">${page>1?`<a href="/account?page=${page-1}">Previous</a>`:''}${orders.length>20?`<a href="/account?page=${page+1}">Next</a>`:''}</nav>`,s));
      }
      if(req.method==='GET' && path==='/index.html') return redirect('/');
      if(req.method==='GET' && path==='/') {
        return send(catalogPage(s,url,appearance().values));
      }
      if(req.method==='POST' && path==='/cart/add') {
        const id=values.get('product');if(!products.has(id)) throw new UserError('Unknown product.');
        const cart=JSON.parse(s.cart);if((cart[id]||0)>=10) throw new UserError('Maximum 10 of each product per order.');cart[id]=(cart[id]||0)+1;run('UPDATE sessions SET cart=? WHERE id=?',JSON.stringify(cart),s.id);
        if((req.headers.accept||'').includes('application/json')) {
          res.setHeader('Content-Type','application/json; charset=utf-8');
          return send(JSON.stringify({product:products.get(id).name,quantity:cart[id],count:Object.values(cart).reduce((a,b)=>a+b,0)}));
        }
        return redirect(`/?added=${encodeURIComponent(id)}#product-${encodeURIComponent(id)}`);
      }
      if(req.method==='POST' && path==='/cart/update') {
        const id=values.get('product');const input=values.get('quantity')||'';
        if(!products.has(id)||!/^\d{1,2}$/.test(input)||Number(input)>10) throw new UserError('Choose a quantity from 0 to 10.');
        const cart=JSON.parse(s.cart);if(Number(input)===0) delete cart[id];else cart[id]=Number(input);run('UPDATE sessions SET cart=? WHERE id=?',JSON.stringify(cart),s.id);return redirect('/cart');
      }
      if(req.method==='GET' && path==='/cart') {
        const items=cartLines(s);
        return send(layout('Your cart',`<p class="eyebrow">01 / YOUR PRODUCTS</p><h1>Your cart.</h1>${items.length?`<div class="checkout-grid"><section>${items.map(p=>`<article class="cart-row"><h2>${esc(p.name)}</h2><p>${money(p.priceCents)} each</p>${form(s,'/cart/update',`<input type="hidden" name="product" value="${p.id}"><label>Quantity (0 removes)<input type="number" name="quantity" min="0" max="10" value="${p.quantity}" required></label>`,'Update quantity','button secondary')}</article>`).join('')}<a class="button" href="/checkout">${s.user_id?'Continue to shipping →':'Log in to check out →'}</a></section>${summary(items,totals(items))}</div>`:'<p>Your cart is empty.</p><a class="button" href="/">Browse the products</a>'}${s.active_order?`<p class="notice"><a href="/orders/${s.active_order}">View your current order</a></p>`:''}`,s));
      }
      if(path==='/checkout'&&!s.user_id) return redirect('/login?next=%2Fcheckout');
      if(req.method==='GET' && path==='/checkout') {
        if(s.active_order) return redirect(`/orders/${s.active_order}`);
        const items=cartLines(s);if(!items.length) return redirect('/cart');
        const fields=textInput('name','Full name','shipping name')+textInput('email','Contact email','email',true,'email')+textInput('line1','Street address','shipping address-line1')+textInput('line2','Apartment / unit','shipping address-line2',true)+textInput('city','City','shipping address-level2')+textInput('region','State / region','shipping address-level1',true)+textInput('postal','Postal code','shipping postal-code',true)+`<label>Country<select name="country" required>${config.shippingCountries.map(code=>`<option value="${code}">${esc(new Intl.DisplayNames(['en'],{type:'region'}).of(code))}</option>`).join('')}</select></label><p class="muted">Your shipping details are stored with your order for fulfillment. Only an order reference and Bitcoin amount are sent to the wallet service. Keep this browser session to view your order; automated email receipts are not enabled.</p>`;
        return send(layout('Shipping & payment',`<p class="eyebrow">02 / SHIPPING & PAYMENT</p><h1>Shipping and payment.</h1>${demo?'<p class="notice">Demo only: use invented details. No cryptocurrency will be requested.</p>':''}<div class="checkout-grid"><section><h2>Shipping details</h2>${form(s,'/checkout',fields+(demo?'':'<section class="bitcoin-payment"><h2>Payment method</h2><p><strong>Bitcoin (BTC)</strong> · On-chain payment</p><p>You will receive a unique wallet address and the exact Bitcoin amount on the next page.</p></section>'), demo?'Create demo order':'Pay with Bitcoin →')}</section>${summary(items,totals(items))}</div>`,s));
      }
      if(req.method==='POST' && path==='/checkout') {
        // Reserving the order synchronously, before network I/O, makes repeated submissions safe.
        const active=query('SELECT active_order FROM sessions WHERE id=?',s.id).active_order;
        if(active) return redirect(`/orders/${active}`);
        limit(s,'orders',5,3600);
        const items=cartLines(s);if(!items.length) throw new UserError('Your cart is empty.');
        const address=addressFrom(values);const amount=totals(items);const id=token();
        db.exec('BEGIN IMMEDIATE');
        try {
          run('INSERT INTO orders (id,session_id,mode,items,subtotal,shipping,total,currency,address,status,created) VALUES (?,?,?,?,?,?,?,?,?,?,?)',id,s.id,mode,JSON.stringify(items),amount.subtotal,amount.shipping,amount.total,config.currency,JSON.stringify(address),demo?'demo':'creating',now());
          if(s.user_id) run('UPDATE orders SET user_id=? WHERE id=?',s.user_id,id);
          run("UPDATE sessions SET active_order=?,cart='{}' WHERE id=?",id,s.id);db.exec('COMMIT');
        } catch(e) {db.exec('ROLLBACK');throw e;}
        if(!demo) await beginPayment(id);
        return redirect(`/orders/${id}`);
      }
      const match=/^\/orders\/([a-f0-9]{64})(?:\/(refresh|finish|pay))?$/.exec(path);
      if(match) {
        let order=ownedOrder(match[1],s);
        if(req.method==='POST' && match[2]==='pay') {
          if(!s.user_id) return redirect('/login?next='+encodeURIComponent('/orders/'+order.id));
          if(demo) throw new UserError('Bitcoin payments are unavailable in this test instance.');
          limit(s,'payment',4);
          await beginPayment(order.id);
          return redirect(`/orders/${order.id}`);
        }
        if(req.method==='POST' && match[2]==='refresh') {
          limit(s,'refresh',4);
          if(now()-order.checked>=10) {try {await reconcile(order.id);} catch {throw new UserError('The payment server is unavailable. Your order is saved; try refreshing later.',503);}}
          return redirect(`/orders/${order.id}`);
        }
        if(req.method==='POST' && match[2]==='finish') {
          if(!['demo','paid','expired','invalid'].includes(order.status)) throw new UserError('Resolve the current payment before starting another order.');
          run('UPDATE sessions SET active_order=NULL WHERE id=? AND active_order=?',s.id,order.id);return redirect('/');
        }
        if(req.method==='GET' && !match[2]) {
          let warning='';
          if(now()-order.checked>=10) {try{await reconcile(order.id);}catch{warning='<p class="notice">Payment status could not be refreshed. The status below is the last verified state.</p>';}}
          order=ownedOrder(order.id,s);
          const address=JSON.parse(order.address);
          if(order.mode==='electrum'&&!order.full_seen_at&&order.expires_at&&now()>=order.expires_at&&['awaiting_payment','partial'].includes(order.status)) order.status='expired';
          const canPay=mode==='electrum'&&!order.verification_error&&order.mode==='electrum'&&['awaiting_payment','confirming','paid'].includes(order.status)&&order.payment_address;
          if(order.verification_error) warning='<p class="notice">Payment verification is currently unavailable. The status below is the last verified state.</p>';
          if(order.mode==='electrum'&&mode!=='electrum') warning='<p class="notice">Live payment processing is paused. Contact the shop about this order.</p>';
          if(order.mode!=='electrum'&&order.mode!=='demo') warning='<p class="notice">This is a legacy payment. Contact the shop to verify it; Electrum does not manage this order.</p>';
          const paymentAction=!demo&&!order.invoice_id&&['demo','payment_unavailable','payment_error','creating'].includes(order.status)?`<section class="bitcoin-payment"><h2>Pay with Bitcoin</h2><p>${order.status==='payment_unavailable'?'The payment service could not connect to Electrum or obtain a current exchange rate. No payment address has been created. Your order is saved; retry when the service is available.':order.status==='payment_error'||order.amount_sats?'Check for the existing payment request before sending funds. This will recover the same request without creating a second one.':'Generate a unique receiving address and the exact Bitcoin amount for this order.'}</p>${form(s,`/orders/${order.id}/pay`,'',order.amount_sats?'Recover payment request':order.status==='payment_unavailable'?'Retry Bitcoin payment':'Pay with Bitcoin')}</section>`:'';
          const payment=canPay?`<section class="bitcoin-payment"><h2>Bitcoin payment</h2><p class="btc-amount">${bitcoinAmount(order.amount_sats)} BTC</p><label>Receiving address<input class="payment-address" value="${esc(order.payment_address)}" readonly aria-label="Bitcoin receiving address"></label><p class="muted">${order.payment_network==='mainnet'?'Bitcoin mainnet':esc(order.payment_network.toUpperCase())+' — TEST COINS ONLY'} · ${order.confirmations} / ${order.min_confirmations} confirmations</p>${order.status==='awaiting_payment'?`<a class="button" href="${esc(paymentURI(order))}">Open Bitcoin wallet →</a><p class="muted">Send the exact amount using Bitcoin on-chain. Pay network fees separately. Quote expires ${new Date(order.expires_at*1000).toISOString().replace('T',' ').replace('.000Z',' UTC')}. This address belongs only to this order.</p>`:'<p class="notice">Payment has been detected. Do not send another payment.</p>'}</section>`:'';
          const help=['payment_error','creating','partial','review','invalid','expired'].includes(order.status)?`<p class="notice">${order.status==='expired'?'This payment window has expired. Do not send funds to the old payment request. If you already sent payment, contact the shop before placing another order.':'Do not send another payment. Contact the shop with your order reference so it can check the payment.'}${config.supportEmail?` <a href="mailto:${esc(config.supportEmail)}">Contact the shop</a>`:''}</p>`:'';
          return send(layout('Order status',`<p class="eyebrow">03 / ${demo?'DEMO ORDER':'BITCOIN PAYMENT'}</p><h1>${esc(!demo&&order.status==='demo'?'Your order is ready for payment':statusText[order.status]||'Order saved')}</h1><p class="order-reference">Order reference: ${order.id}</p>${warning}${help}${demo?'<p class="notice">This demonstrates the checkout flow. No invoice, wallet address or payment request has been created.</p>':''}<div class="checkout-grid"><section>${paymentAction}${payment}${order.mode==='electrum'?form(s,`/orders/${order.id}/refresh`,'','Refresh payment status','button secondary'):''}<h2>Ship to</h2><p>${[address.name,address.line1,address.line2,address.city,address.region,address.postal,address.country].filter(Boolean).map(esc).join('<br>')}</p><p class="muted">${s.user_id?'This order is saved in <a href="/account">your account</a>.':'Keep your order reference and this browser session, or <a href="/register">create an account</a> to save your order history.'} Contact details are used for this order only.</p>${['demo','paid','expired','invalid'].includes(order.status)?form(s,`/orders/${order.id}/finish`,'','Start another order','button secondary'):''}</section>${summary(JSON.parse(order.items),order)}</div>`,s));
        }
      }
      throw new UserError('Page not found.',404);
    } catch(error) {
      if(res.headersSent) {res.end();return;}
      const message=error instanceof UserError?error.message:'Something went wrong. Please check your cart or order before trying again.';
      if((req.headers.accept||'').includes('application/json') && req.url?.split('?')[0]==='/cart/add') {
        res.setHeader('Content-Type','application/json; charset=utf-8');
        return send(JSON.stringify({error:message}),error.status||500);
      }
      send(s?layout('Please check',`<h1>${error.status===404?'Page not found':'Please check'}</h1><p role="alert">${esc(message)}</p><a class="button" href="/cart">Return to cart</a>`,s):esc(message),error.status||500);
    }
  }
  const server=http.createServer(handler);
  server.requestTimeout=20000;server.headersTimeout=15000;server.maxHeadersCount=50;
  return {server,db,reconcile,reconcilePending,paymentConfigured,close:()=>new Promise(resolve=>server.close(()=>{db.close();resolve();}))};
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  process.umask(0o077);
  try {
    const port=Number(process.env.PORT||8080);
    if(!Number.isInteger(port)||port<1||port>65535) throw new Error('PORT must be a number from 1 to 65535.');
    const env={...process.env,SHOP_ORIGIN:process.env.SHOP_ORIGIN||`http://127.0.0.1:${port}`};
    const app=createShop({env});
    let timer;
    app.server.once('error',error=>{
      console.error(error.code==='EADDRINUSE'
        ? `Port ${port} is already in use. Stop the other server (Ctrl+C in its terminal), then run npm start again. Only one shop server is needed.`
        : `Could not start the shop: ${error.message}`);
      app.db.close();process.exitCode=1;
    });
    app.server.listen(port,'127.0.0.1',()=>{
      timer=setInterval(()=>app.reconcilePending().catch(()=>{}),60000);timer.unref();
      console.log(`\nGeneric store is ready\n\n  Website:  ${env.SHOP_ORIGIN}/\n  Cart:     ${env.SHOP_ORIGIN}/cart\n\nCatalog, cart and checkout all run on this one server.\n${(env.PAYMENT_MODE||'electrum')==='demo'?'Demo mode: no real payments.':app.paymentConfigured?'Bitcoin checkout configured; payment requests verify Electrum connectivity and synchronization.':'Bitcoin checkout unavailable: Electrum is not connected. Run npm run doctor.'}\nKeep this terminal open. Press Ctrl+C to stop.\n`);
    });
    let shuttingDown=false;
    const shutdown=()=>{if(shuttingDown) return;shuttingDown=true;clearInterval(timer);app.close().then(()=>process.exit(0));};
    process.on('SIGTERM',shutdown);process.on('SIGINT',shutdown);
  } catch(error) {
    console.error(`Could not start the shop: ${error.message}`);
    process.exitCode=1;
  }
}
