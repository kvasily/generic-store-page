export const fonts={classic:{label:'Classic serif',css:'Georgia,serif'},clean:{label:'Clean sans serif',css:'Arial,Helvetica,sans-serif'},book:{label:'Book serif',css:'"Palatino Linotype",Palatino,serif'},mono:{label:'Monospace',css:'"Courier New",monospace'}};
export const fields={
 brand:{label:'Shop name',value:"Your Store",max:60},
 tagline:{label:'Brand tagline',value:"YOUR ONLINE STORE",max:120},
 announcement:{label:'Announcement',value:"EXPLORE THE COLLECTION",max:180},
 headline:{label:'Catalog heading',value:"The product catalog.",max:120},
 intro:{label:'Catalog introduction',value:"Browse our collection and find what you need.",max:500},
 sidebarTitle:{label:'Sidebar heading',value:"Explore the collection.",max:120},
 sidebarText:{label:'Sidebar description',value:"Browse products by category and view the details that matter to you.",max:800},
 noteTitle:{label:'Collection note heading',value:"A sample collection",max:120},
 noteText:{label:'Collection note',value:"These products, descriptions and images are placeholders. Replace them with your own catalog before publishing.",max:800},
 aboutTitle:{label:'About heading',value:"About your store.",max:120},
 aboutText:{label:'About text',value:"Introduce your business here. Share what you offer and what customers can expect from your store.",max:1500},
 careTitle:{label:'Information heading',value:"Helpful information.",max:120},
 careText:{label:'Information text',value:"Add product guidance, shipping details, return policies or answers to common questions here.",max:1500},
 paper:{label:'Page background',value:'#faf8f4',type:'color'},ink:{label:'Text',value:'#382d35',type:'color'},muted:{label:'Secondary text',value:'#70666c',type:'color'},plum:{label:'Accent / buttons',value:'#543c51',type:'color'},line:{label:'Borders',value:'#e1dcd5',type:'color'},surface:{label:'Cards and inputs',value:'#fffdf9',type:'color'},buttonText:{label:'Button and banner text',value:'#ffffff',type:'color'},headingFont:{label:'Heading font',value:'classic',type:'font'},bodyFont:{label:'Body font',value:'clean',type:'font'}
};
export const defaults=Object.fromEntries(Object.entries(fields).map(([key,f])=>[key,f.value]));
export function validateAppearance(values) {
 const result={};
 for(const [key,f] of Object.entries(fields)) {
  const value=values[key];
  if(typeof value!=='string') throw Error(`Missing ${f.label.toLowerCase()}.`);
  if(f.type==='color') {if(!/^#[0-9a-f]{6}$/i.test(value)) throw Error(`${f.label} must be a six-digit hex color.`);}
  else if(f.type==='font') {if(!Object.hasOwn(fonts,value)) throw Error('Choose a font from the list.');}
  else if(!value.trim()||value.length>f.max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw Error(`${f.label} must contain 1–${f.max} characters.`);
  result[key]=value;
 }
 return result;
}
export function appearanceCSS(values) {
 const a=validateAppearance(values);
 return `:root{${['paper','ink','muted','plum','line','surface','buttonText'].map(k=>`--${k}:${a[k]}`).join(';')};--heading-font:${fonts[a.headingFont].css};--body-font:${fonts[a.bodyFont].css}}body,input,select,textarea,button,.button{font-family:var(--body-font)!important}h1,h2,h3,.brand,.btc-amount{font-family:var(--heading-font)!important}.product,.account-card,.bitcoin-payment,.order-summary,.checkout-main input,.checkout-main select,.checkout-main textarea{background:var(--surface)}.preview,.button:not(.secondary),.filter-input:checked+.filter-label{color:var(--buttonText);background:var(--plum)}.button:hover{filter:brightness(.9)}.account-intro p,.cart-row p,.catalog-intro>div>p:last-child{color:var(--muted)}`;
}
export function applyCatalogText(html,a,escape) {
 return html.replace(/\{\{appearance:([A-Za-z]+)\}\}/g,(_,key)=>escape(a[key]||''));
}
