const fs=require('fs'),crypto=require('crypto');
const src=fs.readFileSync(''+__dirname+'/atom-access.js','utf8');
if(/^\s*(import|export)\s/m.test(src)){console.log('FAIL: в файле есть import/export');process.exit(1)}
const W=new Function(src+'\nreturn {atomAccessHandle,atomRequireAccess,atomHandleUpdate,atomMakeToken,atomVerifyToken,atomVerifyInitData,atomStatus,atomCfg};')();
let pass=0,fail=0;const ok=(n,c,i)=>{if(c){pass++;console.log('PASS',n)}else{fail++;console.log('FAIL',n,i===undefined?'':JSON.stringify(i))}};
// фейковый KV
const store=new Map();const KV={async get(k,t){const v=store.get(k);if(v===undefined)return null;return t==='json'?JSON.parse(v):v},async put(k,v){store.set(k,v)}};
const BOT='123456:TEST_TOKEN_abc';
const tgCalls=[];let chatStatus='member',invoiceOk=true;
global.fetch=async(url,opts)=>{const m=url.split('/bot'+BOT+'/')[1];const body=JSON.parse(opts.body||'{}');tgCalls.push({m,body});
  let r={ok:true,result:true};
  if(m==='getChatMember')r=chatStatus==='error'?{ok:false,description:'chat not found'}:{ok:true,result:{status:chatStatus,is_member:chatStatus==='restricted'}};
  if(m==='createInvoiceLink')r=invoiceOk?{ok:true,result:'https://t.me/$inv_abc'}:{ok:false,description:'bad'};
  return {json:async()=>r}};
const env={BOT_TOKEN:BOT,ATOM_KV:KV,WEBHOOK_SECRET:'whs',CHANNEL:'@atom_test',BOT_USERNAME:'atom_bot'};
function initData(uid,o={}){const p={auth_date:String(o.authDate||Math.floor(Date.now()/1000)),query_id:'AAH',user:JSON.stringify({id:uid,first_name:'Т'})};
  const dcs=Object.keys(p).sort().map(k=>k+'='+p[k]).join('\n');const sec=crypto.createHmac('sha256','WebAppData').update(o.bot||BOT).digest();
  const hash=crypto.createHmac('sha256',sec).update(dcs).digest('hex');return new URLSearchParams({...p,hash}).toString();}
const req=(path,body,method='POST',headers={})=>new Request('https://w.test'+path,{method,headers:{'content-type':'application/json',...headers},body:method==='GET'||method==='OPTIONS'?undefined:JSON.stringify(body||{})});
const call=async(path,body,e=env,method='POST',h={})=>{const r=await W.atomAccessHandle(req(path,body,method,h),e);return r};
const js=async r=>r.json();
(async()=>{
  // --- конфиг и CORS
  let r=await call('/api/config',null,env,'GET');let j=await js(r);
  ok('config: включено и канал отдаётся',j.enabled&&j.price===250&&j.trialDays===4&&j.bonusDays===3&&j.channel.url==='https://t.me/atom_test'&&j.bot==='atom_bot',j);
  r=await call('/api/status',{},env,'OPTIONS');ok('CORS preflight 204',r.status===204&&r.headers.get('access-control-allow-origin')==='*');
  ok('чужие адреса не перехватываются',await W.atomAccessHandle(new Request('https://w.test/food-search?q=1'),env)===null);
  r=await call('/api/config',null,{},'GET');j=await js(r);ok('без настроек: enabled=false',j.enabled===false,j);
  r=await call('/api/status',{},{});ok('без настроек: 503',r.status===503);
  // --- проверка подписи
  r=await call('/api/status',{});ok('без initData: 401',r.status===401);
  r=await call('/api/status',{initData:initData(1,{bot:'999:OTHER'})});ok('подпись другого бота отклонена',r.status===401);
  let bad=initData(1).replace('user=','user=%7B%22id%22%3A2%7D&x=');r=await call('/api/status',{initData:bad});ok('подделанные данные отклонены',r.status===401);
  r=await call('/api/status',{initData:initData(1,{authDate:Math.floor(Date.now()/1000)-90000})});ok('устаревшая подпись (>24ч) отклонена',r.status===401);
  // --- пробный период
  const t0=Date.now();r=await call('/api/status',{initData:initData(100)});j=await js(r);
  ok('новый пользователь: доступ, trial 4 дня',r.status===200&&j.access&&j.reason==='trial'&&Math.abs(j.trialEndsAt-(t0+4*86400000))<5000,j);
  ok('бонус доступен до подписки',j.bonusAvailable===true&&j.bonusGranted===false);
  const r2=await js(await call('/api/status',{initData:initData(100)}));ok('повторный вызов не сбрасывает пробный период',r2.trialEndsAt===j.trialEndsAt);
  // --- бонус за канал
  chatStatus='left';r=await call('/api/channel-check',{initData:initData(100)});j=await js(r);ok('не подписан: бонуса нет',j.subscribed===false&&j.granted===false&&j.bonusGranted===false,j);
  chatStatus='member';const before=r2.trialEndsAt;r=await call('/api/channel-check',{initData:initData(100)});j=await js(r);
  ok('подписан: +3 дня',j.subscribed&&j.granted&&j.trialEndsAt-before===3*86400000&&j.reason==='bonus',j);
  ok('вызов getChatMember с верными параметрами',tgCalls.some(c=>c.m==='getChatMember'&&c.body.chat_id==='@atom_test'&&c.body.user_id===100));
  r=await call('/api/channel-check',{initData:initData(100)});j=await js(r);ok('бонус выдаётся один раз',j.granted===false&&j.trialEndsAt-before===3*86400000);
  chatStatus='error';r=await call('/api/channel-check',{initData:initData(100)});ok('ошибка проверки канала → 502 с подсказкой',r.status===502&&(await js(r)).hint.includes('администратором'));
  chatStatus='administrator';r=await call('/api/channel-check',{initData:initData(101)});j=await js(r);ok('администратор канала тоже считается подписанным',j.subscribed&&j.granted);
  const e2={...env};delete e2.CHANNEL;r=await call('/api/channel-check',{initData:initData(100)},e2);ok('без канала: 400',r.status===400);
  // --- окончание пробного периода
  const u=JSON.parse(store.get('u:100'));u.t0=Date.now()-8*86400000;store.set('u:100',JSON.stringify(u));
  j=await js(await call('/api/status',{initData:initData(100)}));ok('через 8 дней: доступ закрыт',j.access===false&&j.reason==='expired',j);
  ok('после 7 дней бонус уже не предлагается',j.bonusAvailable===false);
  const u5=await js(await call('/api/status',{initData:initData(200)}));const k=JSON.parse(store.get('u:200'));k.t0=Date.now()-5*86400000;store.set('u:200',JSON.stringify(k));
  j=await js(await call('/api/status',{initData:initData(200)}));ok('на 5-й день без бонуса: закрыто, но бонус ещё доступен',j.access===false&&j.bonusAvailable===true,j);
  chatStatus='member';j=await js(await call('/api/channel-check',{initData:initData(200)}));ok('подписка на 5-й день снова открывает доступ',j.access===true&&j.reason==='bonus',j);
  // --- платёж
  r=await call('/api/invoice',{initData:initData(100)});j=await js(r);const inv=tgCalls.filter(c=>c.m==='createInvoiceLink').pop();
  ok('счёт: ссылка, Stars, 250, 30 дней',j.url==='https://t.me/$inv_abc'&&inv.body.currency==='XTR'&&inv.body.prices[0].amount===250&&inv.body.subscription_period===2592000&&inv.body.payload==='pro:100'&&!('provider_token' in inv.body),inv&&inv.body);
  invoiceOk=false;r=await call('/api/invoice',{initData:initData(100)});ok('ошибка счёта → 502',r.status===502);invoiceOk=true;
  await call('/api/tg-webhook',{},env);// без секрета
  r=await call('/api/tg-webhook',{pre_checkout_query:{id:'q1',invoice_payload:'pro:100',currency:'XTR'}},env,'POST',{});ok('вебхук без секрета: 403',r.status===403);
  const H={'X-Telegram-Bot-Api-Secret-Token':'whs'};
  r=await call('/api/tg-webhook',{pre_checkout_query:{id:'q1',invoice_payload:'pro:100',currency:'XTR',total_amount:250}},env,'POST',H);
  ok('pre_checkout подтверждён',r.status===200&&tgCalls.some(c=>c.m==='answerPreCheckoutQuery'&&c.body.ok===true&&c.body.pre_checkout_query_id==='q1'));
  await call('/api/tg-webhook',{pre_checkout_query:{id:'q2',invoice_payload:'evil',currency:'USD'}},env,'POST',H);
  ok('чужой/неверный платёж отклонён',tgCalls.some(c=>c.m==='answerPreCheckoutQuery'&&c.body.ok===false&&c.body.pre_checkout_query_id==='q2'));
  const exp=Math.floor((Date.now()+30*86400000)/1000);
  const pay={message:{from:{id:100},successful_payment:{currency:'XTR',total_amount:250,invoice_payload:'pro:100',telegram_payment_charge_id:'ch1',subscription_expiration_date:exp,is_recurring:true}}};
  r=await call('/api/tg-webhook',pay,env,'POST',H);j=await js(await call('/api/status',{initData:initData(100)}));
  ok('оплата: подписка активна, срок из Telegram',j.access&&j.reason==='subscribed'&&j.subUntil===exp*1000,j);
  ok('пользователю ушло подтверждение',tgCalls.some(c=>c.m==='sendMessage'&&c.body.chat_id===100&&c.body.text.includes('ATOM Pro активен')));
  const n=tgCalls.length;await call('/api/tg-webhook',pay,env,'POST',H);ok('повторная доставка платежа игнорируется',tgCalls.length===n&&JSON.parse(store.get('u:100')).pays.length===1);
  const pay2={message:{from:{id:100},successful_payment:{currency:'XTR',total_amount:250,invoice_payload:'pro:100',telegram_payment_charge_id:'ch2'}}};
  await call('/api/tg-webhook',pay2,env,'POST',H);const sub2=JSON.parse(store.get('u:100')).sub;ok('платёж без даты продлевает на 30 дней',sub2>exp*1000);
  // новый пользователь платит до первого входа
  await call('/api/tg-webhook',{message:{from:{id:300},successful_payment:{currency:'XTR',total_amount:250,invoice_payload:'pro:300',telegram_payment_charge_id:'ch9'}}},env,'POST',H);
  j=await js(await call('/api/status',{initData:initData(300)}));ok('оплатил до первого входа — подписка есть',j.reason==='subscribed'||j.access,j);
  // --- токен для установленного приложения
  r=await call('/api/link-token',{initData:initData(100)});const tok=(await js(r)).token;ok('токен выдан',/^v1\./.test(tok));
  j=await js(await call('/api/status',{token:tok}));ok('статус по токену работает',j.access&&j.reason==='subscribed');
  r=await call('/api/link-token',{token:tok});ok('токен нельзя обменять на новый токен',r.status===403);
  r=await call('/api/status',{token:tok.slice(0,-3)+'abc'});ok('подделанный токен отклонён',r.status===401);
  const old=await W.atomMakeToken(100,env,-1);ok('просроченный токен отклонён',(await W.atomVerifyToken(old,env))===null);
  const t2=await W.atomMakeToken(100,{...env,TOKEN_SECRET:'x'});ok('токен привязан к секрету',(await W.atomVerifyToken(t2,env))===null);
  // --- защита платных функций
  r=await W.atomRequireAccess(new Request('https://w.test/ai-chat',{method:'POST'}),env);ok('requireAccess: без данных 401',r&&r.status===401);
  r=await W.atomRequireAccess(new Request('https://w.test/ai-chat',{method:'POST',headers:{'X-Telegram-Init-Data':initData(100)}}),env);ok('requireAccess: с подпиской пропускает',r===null);
  const k8=JSON.parse(store.get('u:101'));k8.t0=Date.now()-30*86400000;k8.bonus=0;store.set('u:101',JSON.stringify(k8));
  r=await W.atomRequireAccess(new Request('https://w.test/ai-chat',{method:'POST',headers:{'X-Telegram-Init-Data':initData(101)}}),env);ok('requireAccess: просрочено → 402',r&&r.status===402);
  r=await W.atomRequireAccess(new Request('https://w.test/ai-chat',{method:'POST'}),{});ok('requireAccess: платная часть не настроена → пропускает',r===null);
  // --- /start
  let n0=tgCalls.length;await call('/api/tg-webhook',{message:{chat:{id:55,type:'private'},from:{id:55,first_name:'Аня'},text:'/start'}},env,'POST',H);
  const sm=tgCalls.slice(n0).find(c=>c.m==='sendMessage');
  ok('/start: приветствие с кнопкой запуска приложения',sm&&sm.body.chat_id===55&&sm.body.text.includes('Аня')&&sm.body.reply_markup.inline_keyboard[0][0].web_app.url.startsWith('https://prostovladon-prog.github.io/'),sm);
  n0=tgCalls.length;await call('/api/tg-webhook',{message:{chat:{id:-9,type:'supergroup'},from:{id:5},text:'/start'}},env,'POST',H);ok('/start в группе игнорируется',!tgCalls.slice(n0).some(c=>c.m==='sendMessage'));
  n0=tgCalls.length;await call('/api/tg-webhook',{message:{chat:{id:56,type:'private'},from:{id:56},text:'/start ref123'}},env,'POST',H);ok('/start с параметром тоже работает',tgCalls.slice(n0).some(c=>c.m==='sendMessage'));
  n0=tgCalls.length;await call('/api/tg-webhook',{message:{chat:{id:57,type:'private'},from:{id:57},text:'просто текст'}},env,'POST',H);ok('обычный текст не вызывает ответов',!tgCalls.slice(n0).some(c=>c.m==='sendMessage'));
  // --- статистика
  const stt=JSON.parse(store.get('st'));
  ok('статистика: новые/активные/бонус/к оплате/оплатили/выручка',stt.total.new>=3&&stt.total.active>=3&&stt.total.bonus>=2&&stt.total.inv>=1&&stt.total.paid>=2&&stt.total.rev>=500&&stt.total.renew===1,stt.total);
  const day=new Date().toISOString().slice(0,10);ok('статистика: дневная корзина',stt.days[day]&&stt.days[day].new>=3);
  const a0=stt.total.active;await call('/api/status',{initData:initData(100)});ok('повторный заход в тот же день не раздувает «активных»',JSON.parse(store.get('st')).total.active===a0);
  r=await call('/api/admin',null,{...env,ADMIN_KEY:'k1'},'GET');ok('админка без ключа: 404',r.status===404);
  r=await W.atomAccessHandle(new Request('https://w.test/api/admin?key=k1'),{...env,ADMIN_KEY:'k1'});const html=await r.text();ok('админка с ключом: страница со статистикой',r.status===200&&html.includes('статистика')&&html.includes('Воронка'));
  r=await W.atomAccessHandle(new Request('https://w.test/api/admin?key=bad'),{...env,ADMIN_KEY:'k1'});ok('админка с чужим ключом: 404',r.status===404);
  r=await W.atomAccessHandle(new Request('https://w.test/api/admin?key=k1'),env);ok('без ADMIN_KEY в настройках админка закрыта',r.status===404);
  // --- метки источников и рефералка
  const wh=(uid,text)=>call('/api/tg-webhook',{message:{chat:{id:uid,type:'private'},from:{id:uid,first_name:'Т'},text}},env,'POST',H);
  await wh(900,'/start ig_kz1');
  ok('метка: запомнена',JSON.parse(store.get('a:900')).src==='ig_kz1');
  await call('/api/status',{initData:initData(900)});
  ok('метка: пользователь получил src',JSON.parse(store.get('u:900')).src==='ig_kz1');
  let s2=JSON.parse(store.get('st'));ok('метка: счётчики start/new по источнику',s2.src.ig_kz1.start===1&&s2.src.ig_kz1.new===1,s2.src);
  await wh(901,'/start BL_Name');ok('метка приводится к нижнему регистру',JSON.parse(store.get('a:901')).src==='bl_name');
  await wh(902,'/start');await call('/api/status',{initData:initData(902)});ok('без метки: direct',JSON.parse(store.get('u:902')).src==='direct');
  await wh(900,'/start other');ok('уже открывший приложение: метка не перезаписывается',JSON.parse(store.get('u:900')).src==='ig_kz1'&&!store.has('a:900x'));
  // реферал
  await call('/api/status',{initData:initData(910)});
  const refBefore=(await js(await call('/api/status',{initData:initData(910)})));
  const n1=tgCalls.length;
  await wh(911,'/start ref_910');
  j=await js(await call('/api/status',{initData:initData(911)}));
  ok('реферал: новичок получил +7 дней',j.access&&j.trialEndsAt-JSON.parse(store.get('u:911')).t0>=(4+7)*86400000-1000,j);
  const j10=await js(await call('/api/status',{initData:initData(910)}));
  ok('реферал: пригласивший получил +7 дней и refs=1',j10.refs===1&&j10.trialEndsAt-refBefore.trialEndsAt>=7*86400000-1000,j10);
  ok('реферал: пригласивший уведомлён',tgCalls.slice(n1).some(c=>c.m==='sendMessage'&&c.body.chat_id===910&&c.body.text.includes('+7')));
  await call('/api/status',{initData:initData(911)});ok('реферал: награда не повторяется',JSON.parse(store.get('u:910')).refs===1);
  await wh(912,'/start ref_912');await call('/api/status',{initData:initData(912)});ok('сам себя пригласить нельзя',!JSON.parse(store.get('u:912')).ref&&!JSON.parse(store.get('u:912')).freeUntil);
  await wh(913,'/start ref_99999');await call('/api/status',{initData:initData(913)});ok('несуществующий пригласивший: без ошибок и без награды',!JSON.parse(store.get('u:913')).freeUntil);
  await call('/api/status',{initData:initData(914)});await wh(914,'/start ref_910');ok('старый пользователь по чужой ссылке награды не получает',JSON.parse(store.get('u:910')).refs===1);
  j=await js(await call('/api/status',{initData:initData(910)}));ok('статус отдаёт uid для ссылки',j.uid===910&&j.refDays===7);
  r=await W.atomAccessHandle(new Request('https://w.test/api/admin?key=k1'),{...env,ADMIN_KEY:'k1'});const h2=await r.text();ok('админка: таблица источников',h2.includes('ig_kz1')&&h2.includes('Источники')&&h2.includes('Нажали /start'));
  console.log(`\nИТОГО: ${pass}/${pass+fail}`);process.exit(fail?1:0);
})();
