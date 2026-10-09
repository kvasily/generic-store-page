import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
const source=readFileSync(new URL('../public/cart.js',import.meta.url),'utf8');
function page(fetcher) {
 const feedback={textContent:''};const count={textContent:'0'};const button={disabled:false};let submit;
 const form={action:'http://shop.test/cart/add',parentElement:{querySelector:()=>feedback},addEventListener:(name,callback)=>{assert.equal(name,'submit');submit=callback;}};
 const document={querySelectorAll:selector=>selector==='[data-add-to-cart]'?[form]:selector==='[data-cart-count]'?[count]:[button]};
 runInNewContext(source,{document,fetch:fetcher,URLSearchParams,FormData:class { *[Symbol.iterator](){yield ['product','01'];yield ['csrf','session-token'];} }});
 return {feedback,count,button,submit:()=>submit({preventDefault(){}})};
}
test('add button updates the catalog count and confirmation without navigating',async()=>{
 let calls=0;const p=page(async(url,options)=>{calls++;assert.equal(url,'http://shop.test/cart/add');assert.equal(options.method,'POST');assert.equal(options.credentials,'same-origin');assert.equal(options.body.get('csrf'),'session-token');return {ok:true,json:async()=>({product:'Sample Product 01',quantity:1,count:1})};});
 await p.submit();assert.equal(p.count.textContent,'1');assert.match(p.feedback.textContent,/Sample Product 01 added/);assert.equal(p.button.disabled,false);assert.equal(calls,1);
});
test('rejected additions keep the existing count and show the server message',async()=>{
 const p=page(async()=>({ok:false,json:async()=>({error:'Maximum 10 of each product per order.'})}));
 await p.submit();assert.equal(p.count.textContent,'0');assert.match(p.feedback.textContent,/Maximum 10/);assert.equal(p.button.disabled,false);
});
test('an uncertain network response does not automatically retry an addition',async()=>{
 let calls=0;const p=page(async()=>{calls++;throw Error('network');});
 await p.submit();assert.equal(calls,1);assert.match(p.feedback.textContent,/Check your cart before trying again/);assert.equal(p.button.disabled,false);
});
