import { readFileSync } from 'node:fs';
import { createElectrum,bitcoinAmount } from './payment.mjs';
try {
  if(process.env.PAYMENT_SERVICE_UNAVAILABLE) throw new Error('Electrum helper startup failed; see the preceding connection error');
  const config=JSON.parse(readFileSync(new URL('./config/shop.json',import.meta.url),'utf8'));
  const provider=createElectrum(process.env);
  console.log('Checking Electrum connection, wallet identity, synchronization, and the Coinbase exchange-rate API…');
  const quote=await provider.prepare({total:100,currency:config.currency});
  console.log(`PASS: wallet synchronized and exchange rate available. 1 ${config.currency} quotes ${bitcoinAmount(quote.amount_sats)} BTC.`);
  console.log('No order, receiving address, or payment request was created.');
} catch(error) {
  console.error(`Payment diagnostic: ${error.message}`);
  process.exitCode=1;
}
