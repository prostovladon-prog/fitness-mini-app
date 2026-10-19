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

// ---------- хранилище пользователей (KV) ----------
async function atomGetUser(env, uid, create) {
  let u = await env.ATOM_KV.get('u:' + uid, 'json');
  if (!u && create) {
    u = { t0: Date.now(), bonus: 0, sub: 0, pays: [] };
    await env.ATOM_KV.put('u:' + uid, JSON.stringify(u));
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
    await atomSaveUser(env, uid, u);
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
  if (request.method !== 'POST') return atomJson({ error: 'method_not_allowed' }, 405, env);

  let body = {};
  try { body = await request.json(); } catch (e) { /* пустое тело — нормально */ }
  const a = await atomAuth(request, body, env);
  if (!a) return atomJson({ error: 'unauthorized' }, 401, env);

  if (p === '/api/status') {
    const u = await atomGetUser(env, a.uid, true);
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
