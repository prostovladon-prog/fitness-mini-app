import crypto from 'crypto';
import fs from 'fs';import os from 'os';import path from 'path';import { pathToFileURL, fileURLToPath } from 'url';
// Запуск: node worker/proxy.test.mjs  (предварительно ./worker/build.sh)
const tmp = path.join(os.tmpdir(), 'atom-proxy-test.mjs');
fs.copyFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'atom-proxy-full.js'), tmp);
const W = (await import(pathToFileURL(tmp).href)).default;
const BOT='1:T';const store=new Map();
const env={BOT_TOKEN:BOT,WEBHOOK_SECRET:'s',CHANNEL:'@atom_channel',BOT_USERNAME:'officialatom_bot',
 ADMIN_KEY:'adm',ATOM_KV:{async get(k,t){const v=store.get(k);return v==null?null:(t==='json'?JSON.parse(v):v)},async put(k,v){store.set(k,v)}},
 DB:{prepare:()=>({bind:()=>({all:async()=>({results:[{name:'Гречка',brand:'x',calories:300,protein:12,fat:3,carbs:60}]})})})},
 AI:{run:async()=>({response:'привет'})}};
function init(uid){const p={auth_date:String(Math.floor(Date.now()/1000)),user:JSON.stringify({id:uid})};const d=Object.keys(p).sort().map(k=>k+'='+p[k]).join('\n');const sec=crypto.createHmac('sha256','WebAppData').update(BOT).digest();return new URLSearchParams({...p,hash:crypto.createHmac('sha256',sec).update(d).digest('hex')}).toString()}
let ok=0,bad=0;const t=(n,c)=>{c?ok++:bad++;console.log(c?'PASS':'FAIL',n)};
const f=(u,o)=>W.fetch(new Request('https://w'+u,o),env,{});
let r=await f('/');t('корень',(await r.text()).includes('running'));
r=await f('/food-search?q=гр');t('поиск без авторизации → 401',r.status===401);
r=await f('/food-search?q=гр',{headers:{'X-Telegram-Init-Data':init(5)}});let j=await r.json();t('поиск с авторизацией работает',r.status===200&&j.products[0].product_name==='Гречка');
r=await f('/ai-chat',{method:'POST',body:JSON.stringify({messages:[]}),headers:{'X-Telegram-Init-Data':init(5)}});j=await r.json();t('ИИ с авторизацией работает',j.choices[0].message.content==='привет');
r=await f('/ai-chat',{method:'POST',body:'{}'});t('ИИ без авторизации → 401 с CORS',r.status===401&&r.headers.get('access-control-allow-origin')==='*');
r=await f('/ai-chat',{method:'OPTIONS'});t('preflight разрешает новые заголовки',r.status===204&&r.headers.get('access-control-allow-headers').includes('X-Telegram-Init-Data'));
r=await f('/api/config');j=await r.json();t('config: enabled, канал',j.enabled&&j.channel.url==='https://t.me/atom_channel'&&j.bot==='officialatom_bot');
r=await f('/api/status',{method:'POST',body:JSON.stringify({initData:init(5)})});j=await r.json();t('status: триал',j.access&&j.reason==='trial');
const u=JSON.parse(store.get('u:5'));u.t0=Date.now()-9*86400000;store.set('u:5',JSON.stringify(u));
r=await f('/food-search?q=гр',{headers:{'X-Telegram-Init-Data':init(5)}});t('после триала поиск → 402 и CORS',r.status===402&&r.headers.get('access-control-allow-origin')==='*');
console.log(ok+'/'+(ok+bad));
// --- штрихкод
let sql='',bindv=null;
env.DB={prepare:(q)=>({bind:(...a)=>{sql=q;bindv=a;return{all:async()=>{
  if(q.includes('LTRIM')) return {results: a[0]==='4600000000017'?[{name:'Молоко 3,2%',brand:'Простоквашино',serving_size:'200',code:'04600000000017',calories:60,protein:2.9,fat:3.2,carbs:4.7}]:[]};
  return {results:[]};}}}})};
const offCalls=[];globalThis.fetch=async(u)=>{offCalls.push(u);if(u.includes('/5449000000996.json'))return{ok:true,json:async()=>({status:1,product:{code:'5449000000996',product_name:'Coca-Cola',brands:'Coca-Cola',nutriments:{'energy-kcal_100g':42,'proteins_100g':0,'fat_100g':0,'carbohydrates_100g':10.6}}})};return{ok:true,json:async()=>({status:0})}};
const hdr={headers:{'X-Telegram-Init-Data':init(77)}};
await W.fetch(new Request('https://w/api/status',{method:'POST',body:JSON.stringify({initData:init(9)})}),env,{});
r=await f('/food-search?q=4600000000017',hdr);j=await r.json();t('штрихкод найден в своей базе (учёт лишнего нуля)',j.barcode&&j.source==='db'&&j.products[0].product_name==='Молоко 3,2%'&&bindv[0]==='4600000000017',[j,bindv]);
t('поиск по коду, а не по названию',sql.includes("LTRIM(CAST(code AS TEXT), '0') = ?")&&!sql.includes('name_lower'));
r=await f('/food-search?q=5449000000996',hdr);j=await r.json();t('нет в базе → Open Food Facts',j.source==='off'&&j.products[0].product_name==='Coca-Cola'&&j.products[0].nutriments['energy-kcal_100g']===42&&offCalls.some(u=>u.includes('5449000000996')),j);
r=await f('/food-search?q=9999999999999',hdr);j=await r.json();t('нигде нет → пустой список, без ошибки',r.status===200&&j.products.length===0);
r=await f('/food-search?q=0012345678905',hdr);j=await r.json();t('UPC-A: пробует вариант без нуля',r.status===200&&offCalls.some(u=>u.includes('/012345678905.json')));
console.log(ok+'/'+(ok+bad));
// --- текстовый поиск на настоящей SQLite (та же SQL, что в D1)
{
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec('CREATE TABLE products(name TEXT,brand TEXT,serving_size TEXT,code TEXT,calories REAL,protein REAL,fat REAL,carbs REAL,name_lower TEXT,brand_lower TEXT)');
const ins = db.prepare('INSERT INTO products VALUES(?,?,?,?,?,?,?,?,?,?)');
[['Грудка куриная копчёная','Ганна',250,'4810000000011'],['Колбаса варёная Докторская','Ганна',260,'4810000000028'],['Куриная грудка отварная','Домашний',150,'1'],['Гречка','Мистраль',310,'2'],['Грудка индейки','Ганна',130,'3']]
 .forEach(([n,b,k,c])=>ins.run(n,b,'',c,k,20,10,1,n.toLowerCase(),b.toLowerCase()));
env.DB={prepare:(q)=>({bind:(...a)=>({all:async()=>({results:db.prepare(q).all(...a)})})})};
let offQ=null;globalThis.fetch=async(u)=>{if(String(u).includes('search.pl')){offQ=u;return{ok:true,json:async()=>({products:[{code:'9',product_name:'Грудка куриная копчёная',brands:'Ганна',nutriments:{'energy-kcal_100g':250}},{code:'10',product_name:'Грудка куриная копчёная в нарезке',brands:'Ганна, Беларусь',nutriments:{'energy-kcal_100g':240,'proteins_100g':20}},{code:'11',product_name:'Чай',brands:'X',nutriments:{'energy-kcal_100g':1}}]})}}return{ok:true,json:async()=>({status:0})}};
const h={headers:{'X-Telegram-Init-Data':init(88)}};
await W.fetch(new Request('https://w/api/status',{method:'POST',body:JSON.stringify({initData:init(88)})}),env,{});
const s=async q=>(await (await f('/food-search?q='+encodeURIComponent(q),h)).json());
let j=await s('куриная грудка ганна');t('«куриная грудка ганна» находит «Грудка куриная копчёная · Ганна»',j.products.some(p=>p.product_name==='Грудка куриная копчёная'&&p.brands==='Ганна'),j);
j=await s('копченная грудка ганна');t('опечатка «копченная» + ё/е',j.products.some(p=>p.product_name==='Грудка куриная копчёная'),j);
j=await s('ганна');t('только бренд: все товары бренда',j.products.filter(p=>p.brands==='Ганна').length===3);
j=await s('гречка');t('простой запрос работает',j.products[0].product_name==='Гречка');
j=await s('куриная грудка ганна');t('из Open Food Facts добавлены только подходящие и без дублей',j.source==='db+off'&&j.products.filter(p=>p.product_name==='Грудка куриная копчёная').length===1&&j.products.some(p=>p.product_name.includes('в нарезке'))&&!j.products.some(p=>p.product_name==='Чай'),j);
globalThis.fetch=async()=>{throw new Error('offline')};
j=await s('куриная грудка ганна');t('Open Food Facts недоступен → всё равно ответ из своей базы',j.products.length>=1,j);
console.log(ok+'/'+(ok+bad));
}
