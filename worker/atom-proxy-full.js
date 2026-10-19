/* =====================================================================
   ATOM — доступ к приложению: пробный период, подписка Telegram Stars,
   бонус за подписку на канал.

   Как подключить — см. worker/README.md. Коротко:
   1) вставьте ВЕСЬ этот файл в ваш воркер (в начало файла, без изменений);
   2) в самом начале вашего fetch-обработчика добавьте:

        const atomResponse = await atomAccessHandle(request, env);
        if (atomResponse) return atomResponse;

   Нужны: KV-привязка ATOM_KV, секреты BOT_TOKEN и WEBHOOK_SECRET.
   Необязательно: CHANNEL, BOT_USERNAME, TOKEN_SECRET, PRICE_STARS,
   TRIAL_DAYS, BONUS_DAYS, ALLOWED_ORIGIN, INITDATA_MAX_AGE.

   Файл намеренно без import/export — его можно вставить прямо в редактор Cloudflare.
   ===================================================================== */

const ATOM_DAY = 86400000;
const ATOM_ENC = new TextEncoder();

function atomCfg(env) {
  const channel = String(env.CHANNEL || '').trim();
  return {
    trialDays: Number(env.TRIAL_DAYS) || 4,
    bonusDays: Number(env.BONUS_DAYS) || 3,
    price: Number(env.PRICE_STARS) || 250,
    channel,                                            // @name или числовой id (-100...)
    channelUrl: channel.startsWith('@') ? 'https://t.me/' + channel.slice(1) : String(env.CHANNEL_URL || ''),
    bot: String(env.BOT_USERNAME || '').replace(/^@/, ''),
    maxAge: Number(env.INITDATA_MAX_AGE) || 86400       // сколько живёт подпись Telegram, сек
  };
}

function atomCors(env) {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data, X-Atom-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400'
  };
}

function atomJson(data, status, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, atomCors(env))
  });
}

// ---------- криптография ----------
async function atomHmac(key, data) {
  const k = await crypto.subtle.importKey('raw', typeof key === 'string' ? ATOM_ENC.encode(key) : key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, typeof data === 'string' ? ATOM_ENC.encode(data) : data));
}
function atomHex(u8) { return Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join(''); }
function atomB64u(u8) {
  let s = ''; u8.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function atomB64uDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}
function atomSafeEq(a, b) {
  a = String(a); b = String(b);
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// Проверка подписи Telegram Mini App (initData). Возвращает {uid} или null.
async function atomVerifyInitData(initData, env) {
  try {
    if (!initData || !env.BOT_TOKEN) return null;
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');
    const dcs = Array.from(params.entries()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(e => e[0] + '=' + e[1]).join('\n');
    const secret = await atomHmac('WebAppData', env.BOT_TOKEN);
    const expected = atomHex(await atomHmac(secret, dcs));
    if (!atomSafeEq(expected, hash)) return null;
    const age = Date.now() / 1000 - Number(params.get('auth_date') || 0);
    if (!(age >= -300 && age <= atomCfg(env).maxAge)) return null;
    const user = JSON.parse(params.get('user') || 'null');
    if (!user || !Number.isFinite(user.id)) return null;
    return { uid: user.id };
  } catch (e) { return null; }
}

// Долгий токен для установленного на главный экран приложения (там нет initData)
async function atomMakeToken(uid, env, days) {
  const payload = atomB64u(ATOM_ENC.encode(JSON.stringify({ u: uid, e: Date.now() + (days || 365) * ATOM_DAY })));
  const sig = atomB64u(await atomHmac(env.TOKEN_SECRET || (env.BOT_TOKEN + ':atom-link'), payload));
  return 'v1.' + payload + '.' + sig;
}
async function atomVerifyToken(token, env) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return null;
    const sig = atomB64u(await atomHmac(env.TOKEN_SECRET || (env.BOT_TOKEN + ':atom-link'), parts[1]));
    if (!atomSafeEq(sig, parts[2])) return null;
    const p = JSON.parse(new TextDecoder().decode(atomB64uDecode(parts[1])));
    if (!p || !Number.isFinite(p.u) || !(p.e > Date.now())) return null;
    return p.u;
  } catch (e) { return null; }
}

// Кто делает запрос: из Telegram (initData) или по токену. Возвращает {uid, via} или null.
async function atomAuth(request, body, env) {
  const initData = (body && body.initData) || request.headers.get('X-Telegram-Init-Data') || '';
  const token = (body && body.token) || request.headers.get('X-Atom-Token') || '';
  if (initData) {
    const r = await atomVerifyInitData(initData, env);
    if (r) return { uid: r.uid, via: 'tg' };
  }
  if (token) {
    const u = await atomVerifyToken(token, env);
    if (u) return { uid: u, via: 'token' };
  }
  return null;
}

// ---------- статистика (один документ в KV: итоги + последние 60 дней) ----------
// События: new (новый пользователь), active (заходил в этот день), bonus, inv (дошёл до оплаты),
// paid (первая оплата), renew (повторные платежи), rev (звёзды). Для аналитики; точность ±1 при гонках.
async function atomCount(env, ev, n) {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const st = (await env.ATOM_KV.get('st', 'json')) || { total: {}, days: {} };
    st.total[ev] = (st.total[ev] || 0) + (n || 1);
    const d = st.days[day] || (st.days[day] = {});
    d[ev] = (d[ev] || 0) + (n || 1);
    const keys = Object.keys(st.days).sort();
    while (keys.length > 60) delete st.days[keys.shift()];
    await env.ATOM_KV.put('st', JSON.stringify(st));
  } catch (e) { /* статистика не должна ломать основную работу */ }
}

// ---------- хранилище пользователей (KV) ----------
async function atomGetUser(env, uid, create) {
  let u = await env.ATOM_KV.get('u:' + uid, 'json');
  if (!u && create) {
    u = { t0: Date.now(), bonus: 0, sub: 0, pays: [] };
    await env.ATOM_KV.put('u:' + uid, JSON.stringify(u));
    await atomCount(env, 'new');
  }
  return u;
}
async function atomSaveUser(env, uid, u) {
  await env.ATOM_KV.put('u:' + uid, JSON.stringify(u));
}

// Состояние доступа
function atomStatus(u, cfg, now) {
  const base = cfg.trialDays * ATOM_DAY;
  const trialEnd = u.t0 + base + (u.bonus ? cfg.bonusDays * ATOM_DAY : 0);
  const subscribed = (u.sub || 0) > now;
  const inTrial = now < trialEnd;
  return {
    enabled: true,
    now,
    access: subscribed || inTrial,
    reason: subscribed ? 'subscribed' : inTrial ? (u.bonus ? 'bonus' : 'trial') : 'expired',
    trialEndsAt: trialEnd,
    subUntil: u.sub || 0,
    bonusGranted: !!u.bonus,
    // бонус ещё имеет смысл, если с учётом +3 дней доступ ещё не закончился
    bonusAvailable: !u.bonus && !!cfg.channel && now < u.t0 + base + cfg.bonusDays * ATOM_DAY,
    channel: cfg.channel ? { url: cfg.channelUrl || null } : null,
    price: cfg.price,
    trialDays: cfg.trialDays,
    bonusDays: cfg.bonusDays
  };
}

// ---------- Telegram Bot API ----------
async function atomTg(env, method, params) {
  try {
    const r = await fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params || {})
    });
    return await r.json();
  } catch (e) { return { ok: false, description: String(e) }; }
}

// ---------- оплата и вебхук ----------
// Обрабатывает обновление от Telegram. Можно вызвать и из уже существующего бота.
async function atomHandleUpdate(upd, env) {
  const cfg = atomCfg(env);
  const pcq = upd && upd.pre_checkout_query;
  if (pcq) {
    const ok = String(pcq.invoice_payload || '').startsWith('pro:') && pcq.currency === 'XTR';
    await atomTg(env, 'answerPreCheckoutQuery', ok
      ? { pre_checkout_query_id: pcq.id, ok: true }
      : { pre_checkout_query_id: pcq.id, ok: false, error_message: 'Не удалось оформить подписку. Попробуйте ещё раз.' });
    return true;
  }
  const msg = upd && upd.message;
  const sp = msg && msg.successful_payment;
  if (sp && String(sp.invoice_payload || '').startsWith('pro:') && msg.from && Number.isFinite(msg.from.id)) {
    const uid = msg.from.id;
    const u = (await atomGetUser(env, uid, true));
    const chargeId = sp.telegram_payment_charge_id || '';
    if (chargeId && (u.pays || []).some(p => p.id === chargeId)) return true;   // повторная доставка — игнорируем
    const now = Date.now();
    const end = sp.subscription_expiration_date
      ? sp.subscription_expiration_date * 1000
      : Math.max(now, u.sub || 0) + 30 * ATOM_DAY;
    u.sub = Math.max(u.sub || 0, end);
    u.pays = (u.pays || []).concat([{ id: chargeId, at: now, amt: sp.total_amount }]).slice(-20);
    const firstPay = !u.paid;
    u.paid = 1;
    await atomSaveUser(env, uid, u);
    await atomCount(env, firstPay ? 'paid' : 'renew');
    await atomCount(env, 'rev', Number(sp.total_amount) || 0);
    const d = new Date(u.sub);
    const dd = String(d.getUTCDate()).padStart(2, '0') + '.' + String(d.getUTCMonth() + 1).padStart(2, '0') + '.' + d.getUTCFullYear();
    await atomTg(env, 'sendMessage', { chat_id: uid, text: '✅ ATOM Pro активен до ' + dd + '. Спасибо, что с нами! 💪' });
    return true;
  }
  return false;
}

async function atomWebhook(request, env) {
  if (env.WEBHOOK_SECRET && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.WEBHOOK_SECRET) {
    return new Response('forbidden', { status: 403 });
  }
  let upd;
  try { upd = await request.json(); } catch (e) { return new Response('bad request', { status: 400 }); }
  await atomHandleUpdate(upd, env);
  return new Response('ok');
}

// ---------- главный обработчик /api/* ----------
// Возвращает Response для адресов /api/..., иначе null (тогда работает остальной воркер).
async function atomAccessHandle(request, env) {
  const url = new URL(request.url);
  if (!url.pathname.startsWith('/api/')) return null;
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: atomCors(env) });

  const cfg = atomCfg(env);
  const enabled = !!(env.BOT_TOKEN && env.ATOM_KV);
  const p = url.pathname;

  // Публичные настройки: по ним приложение понимает, включена ли платная часть
  if (p === '/api/config') {
    return atomJson({
      enabled, bot: cfg.bot || null, price: cfg.price, trialDays: cfg.trialDays, bonusDays: cfg.bonusDays,
      channel: cfg.channel ? { url: cfg.channelUrl || null } : null
    }, 200, env);
  }
  if (!enabled) return atomJson({ error: 'not_configured' }, 503, env);
  if (p === '/api/tg-webhook') return atomWebhook(request, env);
  if (p === '/api/admin') return atomAdmin(url, env);
  if (request.method !== 'POST') return atomJson({ error: 'method_not_allowed' }, 405, env);

  let body = {};
  try { body = await request.json(); } catch (e) { /* пустое тело — нормально */ }
  const a = await atomAuth(request, body, env);
  if (!a) return atomJson({ error: 'unauthorized' }, 401, env);

  if (p === '/api/status') {
    const u = await atomGetUser(env, a.uid, true);
    const today = new Date().toISOString().slice(0, 10);
    if (u.seen !== today) {            // не чаще одной записи в сутки на пользователя
      u.seen = today; u.days = (u.days || 0) + 1;
      await atomSaveUser(env, a.uid, u);
      await atomCount(env, 'active');
    }
    return atomJson(atomStatus(u, cfg, Date.now()), 200, env);
  }

  if (p === '/api/channel-check') {
    if (!cfg.channel) return atomJson({ error: 'no_channel' }, 400, env);
    const r = await atomTg(env, 'getChatMember', { chat_id: cfg.channel, user_id: a.uid });
    if (!r.ok) return atomJson({ error: 'channel_check_failed', hint: 'Бот должен быть администратором канала' }, 502, env);
    const st = r.result && r.result.status;
    const subscribed = st === 'creator' || st === 'administrator' || st === 'member' || (st === 'restricted' && r.result.is_member === true);
    const u = await atomGetUser(env, a.uid, true);
    const now = Date.now();
    let granted = false;
    if (subscribed && !u.bonus && now < u.t0 + (cfg.trialDays + cfg.bonusDays) * ATOM_DAY) {
      u.bonus = 1; granted = true;
      await atomSaveUser(env, a.uid, u);
      await atomCount(env, 'bonus');
    }
    return atomJson(Object.assign(atomStatus(u, cfg, now), { subscribed, granted }), 200, env);
  }

  if (p === '/api/invoice') {
    const r = await atomTg(env, 'createInvoiceLink', {
      title: 'ATOM Pro — 30 дней',
      description: 'ИИ-тренер, сканер штрих-кодов, база продуктов, программы тренировок и синхронизация. Продлевается каждые 30 дней.',
      payload: 'pro:' + a.uid,
      currency: 'XTR',
      prices: [{ label: 'ATOM Pro', amount: cfg.price }],
      subscription_period: 2592000
    });
    if (!r.ok) return atomJson({ error: 'invoice_failed', hint: r.description || '' }, 502, env);
    const uu = await atomGetUser(env, a.uid, true);
    if (!uu.inv) { uu.inv = Date.now(); await atomSaveUser(env, a.uid, uu); await atomCount(env, 'inv'); }
    return atomJson({ url: r.result }, 200, env);
  }

  if (p === '/api/link-token') {
    if (a.via !== 'tg') return atomJson({ error: 'tg_only' }, 403, env);
    return atomJson({ token: await atomMakeToken(a.uid, env, 365) }, 200, env);
  }

  return atomJson({ error: 'not_found' }, 404, env);
}

// Защита платных функций вашего воркера (ИИ-чат, поиск продуктов).
// Использование:  const deny = await atomRequireAccess(request, env); if (deny) return deny;
// Возвращает null, если доступ есть (или платная часть ещё не настроена), иначе готовый Response.
async function atomRequireAccess(request, env) {
  if (!(env.BOT_TOKEN && env.ATOM_KV)) return null;
  const a = await atomAuth(request, null, env);
  if (!a) return atomJson({ error: 'unauthorized' }, 401, env);
  const u = await atomGetUser(env, a.uid, true);
  if (!atomStatus(u, atomCfg(env), Date.now()).access) return atomJson({ error: 'payment_required' }, 402, env);
  return null;
}


// ---------- страница статистики для владельца ----------
// Открывается так:  https://<ваш-воркер>/api/admin?key=<ADMIN_KEY>   (&format=json — данные в JSON)
async function atomAdmin(url, env) {
  const key = env.ADMIN_KEY || '';
  const given = url.searchParams.get('key') || '';
  if (!key || !atomSafeEq(given, key)) return new Response('not found', { status: 404 });
  const st = (await env.ATOM_KV.get('st', 'json')) || { total: {}, days: {} };
  const cfg = atomCfg(env);
  if (url.searchParams.get('format') === 'json') return atomJson(st, 200, env);
  const t = st.total, n = k => Number(t[k] || 0), pct = (a, b) => b ? Math.round(a / b * 100) + '%' : '—';
  const rows = Object.keys(st.days).sort().reverse().slice(0, 14).map(d => {
    const x = st.days[d];
    return '<tr><td>' + d + '</td><td>' + (x.new || 0) + '</td><td>' + (x.active || 0) + '</td><td>' + (x.inv || 0) + '</td><td>' + (x.paid || 0) + '</td><td>' + (x.rev || 0) + '</td></tr>';
  }).join('');
  const bar = (label, v, max) => '<div class="b"><span>' + label + '</span><div><i style="width:' + (max ? Math.max(2, Math.round(v / max * 100)) : 2) + '%"></i></div><b>' + v + '</b></div>';
  const users = n('new');
  const html = '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ATOM — статистика</title>'
    + '<style>body{font:15px system-ui,sans-serif;background:#0f1314;color:#fff;margin:0;padding:20px;max-width:640px;margin:auto}h1{font-size:22px}h2{font-size:15px;opacity:.7;margin:26px 0 10px}'
    + '.g{display:grid;grid-template-columns:1fr 1fr;gap:10px}.c{background:#1a1f21;border-radius:14px;padding:14px}.c b{display:block;font-size:26px;color:#00d9a3}.c span{font-size:12px;opacity:.7}'
    + '.b{display:flex;align-items:center;gap:10px;margin:8px 0;font-size:13px}.b span{width:130px}.b div{flex:1;background:#1a1f21;border-radius:8px;height:14px}.b i{display:block;height:100%;background:#00d9a3;border-radius:8px}.b b{width:44px;text-align:right}'
    + 'table{width:100%;border-collapse:collapse;font-size:13px}td,th{padding:7px 4px;border-bottom:1px solid #24292b;text-align:right}td:first-child,th:first-child{text-align:left}</style>'
    + '<h1>⚡ ATOM — статистика</h1><div class="g">'
    + '<div class="c"><b>' + users + '</b><span>открыли приложение (всего)</span></div>'
    + '<div class="c"><b>' + n('paid') + '</b><span>оплатили (конверсия ' + pct(n('paid'), users) + ')</span></div>'
    + '<div class="c"><b>' + n('rev') + ' ⭐</b><span>выручка всего</span></div>'
    + '<div class="c"><b>' + n('renew') + '</b><span>продлений</span></div></div>'
    + '<h2>Воронка</h2>' + bar('Открыли', users, users) + bar('Бонус за канал', n('bonus'), users) + bar('Нажали «Оформить»', n('inv'), users) + bar('Оплатили', n('paid'), users)
    + '<h2>Последние 14 дней</h2><table><tr><th>День (UTC)</th><th>Новые</th><th>Активные</th><th>К оплате</th><th>Оплат</th><th>⭐</th></tr>' + rows + '</table>'
    + '<p style="opacity:.5;font-size:12px;margin-top:24px">Цена: ' + cfg.price + ' ⭐ · триал ' + cfg.trialDays + ' дн. · данные ведутся с момента запуска статистики; при одновременных событиях возможна погрешность ±1.</p>';
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}


// ===================== Основной воркер ATOM =====================
export default {
  async fetch(request, env, ctx) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Telegram-Init-Data, X-Atom-Token",
      "Access-Control-Max-Age": "86400",
    };

    // ATOM: пробный период, подписка Stars, канал (маршруты /api/*)
    const atomResponse = await atomAccessHandle(request, env);
    if (atomResponse) return atomResponse;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      if (path === "/food-search") {
        // ATOM: доступ только с пробным периодом / подпиской
        const denied = await atomRequireAccess(request, env);
        if (denied) return denied;

        const query = url.searchParams.get("q");
        if (!query || query.length < 2) {
          return new Response(JSON.stringify({ products: [] }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const q = query.trim().toLowerCase();
        const likeStart = q + '%';
        const likeAny = '%' + q + '%';
        const likeWords = '%' + q.split(/\s+/).filter(w => w).join('%') + '%';

        const stmt = env.DB.prepare(`
          SELECT name, brand, serving_size, code, calories, protein, fat, carbs
          FROM products
          WHERE
            name_lower LIKE ?
            OR name_lower LIKE ?
            OR name_lower LIKE ?
            OR brand_lower LIKE ?
          ORDER BY
            CASE
              WHEN name_lower LIKE ? THEN 1
              WHEN name_lower LIKE ? THEN 2
              WHEN brand_lower LIKE ? THEN 3
              ELSE 4
            END,
            LENGTH(name) ASC
          LIMIT 30
        `).bind(likeStart, likeAny, likeWords, likeAny, likeStart, likeAny, likeStart);

        const result = await stmt.all();

        const products = (result.results || []).map(row => ({
          product_name: row.name,
          brands: row.brand,
          serving_size: row.serving_size,
          code: row.code,
          nutriments: {
            'energy-kcal_100g': row.calories,
            'proteins_100g': row.protein,
            'fat_100g': row.fat,
            'carbohydrates_100g': row.carbs
          }
        }));

        return new Response(JSON.stringify({
          products,
          count: products.length,
          query: q
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      if (path === "/ai-chat") {
        // ATOM: доступ только с пробным периодом / подпиской
        const denied = await atomRequireAccess(request, env);
        if (denied) return denied;

        const body = await request.json();
        const aiResponse = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
          messages: body.messages,
          max_tokens: 1024
        });
        return new Response(JSON.stringify({
          choices: [{
            message: {
              role: "assistant",
              content: aiResponse.response || "Извини, не смог ответить."
            }
          }]
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      return new Response("ATOM Proxy is running ✅", { status: 200, headers: corsHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message, products: [] }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
