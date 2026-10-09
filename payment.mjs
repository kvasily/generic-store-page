import { randomUUID } from 'node:crypto';

export function safeOrigin(value, { onion = false, loopback = false } = {}) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Use a plain origin URL');
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ((loopback && local) || (onion && /^[a-z2-7]{56}\.onion$/.test(url.hostname))))) throw new Error('Use HTTPS, an allowed onion origin, or loopback');
  return url.origin;
}
export class PaymentMismatch extends Error {}
export function bitcoinAmount(sats) {
  if (!Number.isSafeInteger(sats) || sats < 1 || sats > 2100000000000000) throw new Error('Invalid Bitcoin amount');
  return `${Math.floor(sats / 100000000)}.${String(sats % 100000000).padStart(8,'0')}`;
}
export function quoteSatoshis(cents, rate) {
  // Convert a decimal fiat/BTC quote to integer sats, always rounding up.
  if (!Number.isSafeInteger(cents) || cents<=0 || !/^\d{1,10}(?:\.\d{1,8})?$/.test(rate)) throw new Error('Invalid price quote');
  const [whole,fraction='']=rate.split('.');
  const scale=10n**BigInt(fraction.length);
  const denominator=(BigInt(whole)*scale+BigInt(fraction||'0'))*100n;
  if(denominator<=0n) throw new Error('Invalid price quote');
  const sats=(BigInt(cents)*100000000n*scale+denominator-1n)/denominator;
  const result=Number(sats);bitcoinAmount(result);return result;
}
export function requestMemo(order) { return `generic-store-page:${order.id}`; }
export function validateRequest(request, order) {
  if(!request || typeof request.request_id!=='string' || !request.request_id || request.request_id.length>200 || request.is_lightning!==false || request.message!==requestMemo(order) || request.amount_sat!==order.amount_sats || request.expiry!==0 || !Number.isSafeInteger(request.timestamp) || request.timestamp<order.created-60) throw new PaymentMismatch('Electrum request does not match this order');
  const address=request.address;
  const pattern=order.payment_network==='mainnet'?/^(?:bc1[ac-hj-np-z02-9]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/:order.payment_network==='regtest'?/^bcrt1[ac-hj-np-z02-9]{11,87}$/:/^(?:tb1[ac-hj-np-z02-9]{11,87}|[mn2][a-km-zA-HJ-NP-Z1-9]{25,34})$/;
  if(typeof address!=='string'||!pattern.test(address)) throw new PaymentMismatch('Unexpected Bitcoin address or network');
  if(order.invoice_id && request.request_id!==order.invoice_id) throw new PaymentMismatch('Payment request ID changed');
  if(order.payment_address && address!==order.payment_address) throw new PaymentMismatch('Receiving address changed');
  return request;
}
export function requestState(request, order, timestamp=Math.floor(Date.now()/1000)) {
  validateRequest(request,order);
  const confirmations=request.confirmations??0;
  if(!Number.isSafeInteger(confirmations)||confirmations<0) throw new PaymentMismatch('Invalid confirmation count');
  // Electrum status 3 means fully paid with >=1 confirmation, NOT our fulfillment threshold.
  const full=request.status===3||request.status===7;
  if(full) {
    if(request.status===3 && confirmations<1) throw new PaymentMismatch('Inconsistent paid status');
    const seen=order.full_seen_at||timestamp;
    if(seen>order.expires_at) return {status:'review',full_seen_at:seen,confirmations};
    return {status:request.status===3&&confirmations>=order.min_confirmations?'paid':'confirming',full_seen_at:seen,confirmations};
  }
  if(request.status!==0) return {status:'review',full_seen_at:order.full_seen_at,confirmations};
  if(order.full_seen_at) return {status:'review',full_seen_at:order.full_seen_at,confirmations};
  if(timestamp>=order.expires_at) return {status:'expired',full_seen_at:null,confirmations};
  return {status:Array.isArray(request.tx_hashes)&&request.tx_hashes.length?'partial':'awaiting_payment',full_seen_at:null,confirmations};
}
export function paymentURI(order) {
  return `bitcoin:${order.payment_address}?amount=${bitcoinAmount(order.amount_sats)}&label=${encodeURIComponent('Your Store')}`;
}
async function paymentFetch(fetcher,url,options,label) {
  try {return await fetcher(url,options);}
  catch(error) {
    const raw=error.cause?.code||error.code||error.name;
    const code=typeof raw==='string'&&/^[A-Za-z0-9_]{1,60}$/.test(raw)?raw:'NETWORK_ERROR';
    throw new Error(`${label} connection failed (${code})`);
  }
}
export function createElectrum(env, fetcher=fetch, clock=()=>Math.floor(Date.now()/1000)) {
  const origin=safeOrigin(env.ELECTRUM_RPC_URL||'http://127.0.0.1:7777',{loopback:true});
  const wallet=env.ELECTRUM_WALLET;
  if(!wallet || !env.ELECTRUM_RPC_USER || !env.ELECTRUM_RPC_PASSWORD || !env.ELECTRUM_MASTER_PUBLIC_KEY) throw new Error('Electrum RPC credentials, wallet path and expected master PUBLIC key are required');
  if(!/^[xyztuvXYZTUV]pub[1-9A-HJ-NP-Za-km-z]+$/.test(env.ELECTRUM_MASTER_PUBLIC_KEY)) throw new Error('Configure an extended PUBLIC key, never a seed or private key');
  if(env.ELECTRUM_WATCH_ONLY!=='true') throw new Error('Confirm that the configured Electrum wallet is watch-only');
  const network=env.ELECTRUM_NETWORK||'mainnet';
  if(!['mainnet','testnet','testnet4','signet','regtest'].includes(network)) throw new Error('Unsupported Electrum network');
  const minConfirmations=Number(env.BTC_MIN_CONFIRMATIONS||3);
  const expirySeconds=Number(env.BTC_CHECKOUT_MINUTES||60)*60;
  if(!Number.isInteger(minConfirmations)||minConfirmations<1||minConfirmations>100||!Number.isInteger(expirySeconds)||expirySeconds<300||expirySeconds>3600) throw new Error('Invalid confirmation threshold or checkout window');
  async function rpc(method,params={},withWallet=true) {
    const id=randomUUID();
    const response=await paymentFetch(fetcher,origin,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json',Authorization:`Basic ${Buffer.from(`${env.ELECTRUM_RPC_USER}:${env.ELECTRUM_RPC_PASSWORD}`).toString('base64')}`},body:JSON.stringify({jsonrpc:'2.0',id,method,params:{...params,...(withWallet?{wallet_path:wallet}: {})}}),signal:AbortSignal.timeout(15000)},`Electrum RPC ${method}`);
    if(!response.ok) throw new Error(`Electrum RPC HTTP ${response.status}`);
    const data=await response.json();
    if(data.id!==id||data.error||!Object.hasOwn(data,'result')) throw new Error('Electrum RPC failed; check wallet and daemon configuration');
    return data.result;
  }
  async function ready() {
    const [info,synced,key]=await Promise.all([rpc('getinfo',{},false),rpc('is_synchronized'),rpc('getmpk')]);
    if(info.network!==network) throw new Error(`Electrum network mismatch: expected ${network}`);
    if(info.connected!==true) throw new Error('Electrum helper is offline: no connection to a Bitcoin server');
    if(!Number.isSafeInteger(info.blockchain_height)||!Number.isSafeInteger(info.server_height)) throw new Error('Electrum returned invalid blockchain synchronization heights');
    if(info.blockchain_height<1||info.server_height<1||Math.abs(info.server_height-info.blockchain_height)>1||synced!==true) throw new Error(`Electrum helper is synchronizing: local height ${info.blockchain_height}, server height ${info.server_height}, wallet synchronized ${synced===true}. Wait, then retry payment.`);
    if(key!==env.ELECTRUM_MASTER_PUBLIC_KEY) throw new Error('Electrum wallet does not match the configured master public key');
  }
  return {
    async prepare(order) {
      await ready();
      const url=`https://api.coinbase.com/v2/prices/BTC-${encodeURIComponent(order.currency)}/spot`;
      const response=await paymentFetch(fetcher,url,{redirect:'error',headers:{Accept:'application/json','Cache-Control':'no-cache'},signal:AbortSignal.timeout(10000)},'Coinbase Bitcoin exchange-rate API');
      if(!response.ok) throw new Error(`Coinbase Bitcoin exchange-rate API returned HTTP ${response.status}`);
      const data=(await response.json()).data;
      const responseDate=Date.parse(response.headers.get('date')||'');
      const age=Number(response.headers.get('age')||0);
      if(!Number.isFinite(responseDate)||Math.abs(clock()-Math.floor(responseDate/1000))>120||!Number.isFinite(age)||age>120||(data?.base!==undefined&&data.base!=='BTC')||data?.currency!==order.currency||typeof data.amount!=='string') throw new Error('Bitcoin exchange rate is stale or invalid');
      return {amount_sats:quoteSatoshis(order.total,data.amount),rate:data.amount,payment_network:network,min_confirmations:minConfirmations,expires_at:clock()+expirySeconds};
    },
    async create(order) {
      await ready();
      if(clock()>=order.expires_at) throw new Error('Checkout quote expired before request creation');
      // Never expire/delete these reservations in Electrum: expired requests can reuse addresses.
      const request=await rpc('add_request',{amount:bitcoinAmount(order.amount_sats),memo:requestMemo(order),expiry:0,lightning:false,force:true});
      validateRequest(request,order);
      if(await rpc('ismine',{address:request.address})!==true) throw new PaymentMismatch('Receiving address is not owned by the configured wallet');
      return request;
    },
    async get(order) {
      await ready();
      const request=await rpc('get_request',{request_id:order.invoice_id});
      validateRequest(request,order);
      return request;
    },
    async recover(order) {
      await ready();
      const requests=await rpc('list_requests');
      if(!Array.isArray(requests)) throw new Error('Unexpected Electrum request list');
      const matches=requests.filter(r=>r.message===requestMemo(order));
      if(matches.length!==1) throw new Error('Expected exactly one matching request; inspect Electrum before proceeding');
      validateRequest(matches[0],order);
      if(await rpc('ismine',{address:matches[0].address})!==true) throw new PaymentMismatch('Address ownership check failed');
      return matches[0];
    }
  };
}
