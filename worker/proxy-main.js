// ===== Поиск продукта по штрихкоду =====
// Сначала своя база (D1) по колонке code — с учётом лишних нулей (EAN-13 / UPC-A),
// если не нашли — Open Food Facts (бесплатная открытая база, есть российские продукты).
function atomMapRow(row) {
  return {
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
  };
}

async function atomOffLookup(code) {
  const variants = [code];
  if (code.length === 12) variants.push('0' + code);
  if (code.length === 13 && code[0] === '0') variants.push(code.slice(1));
  for (const c of variants) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 4000);
      const r = await fetch('https://world.openfoodfacts.org/api/v2/product/' + c + '.json?fields=code,product_name,product_name_ru,generic_name,brands,serving_size,nutriments', {
        headers: { 'User-Agent': 'ATOM-fitness-app/1.0 (Telegram Mini App)' },
        signal: ac.signal,
        cf: { cacheTtl: 86400, cacheEverything: true }
      });
      clearTimeout(t);
      if (!r.ok) continue;
      const j = await r.json();
      const p = j && j.status === 1 && j.product;
      if (!p) continue;
      const n = p.nutriments || {};
      let kcal = Number(n['energy-kcal_100g']);
      if (!isFinite(kcal) && isFinite(Number(n['energy_100g']))) kcal = Number(n['energy_100g']) / 4.184;
      const name = (p.product_name_ru || p.product_name || p.generic_name || '').trim();
      if (!name || !isFinite(kcal)) continue;
      return [{
        product_name: name,
        brands: p.brands || '',
        serving_size: p.serving_size || '',
        code: p.code || c,
        nutriments: {
          'energy-kcal_100g': Math.round(kcal),
          'proteins_100g': Number(n['proteins_100g']) || 0,
          'fat_100g': Number(n['fat_100g']) || 0,
          'carbohydrates_100g': Number(n['carbohydrates_100g']) || 0
        }
      }];
    } catch (e) { /* пробуем следующий вариант */ }
  }
  return [];
}


// ===== Текстовый поиск: каждое слово ищем и в названии, и в бренде =====
function atomNorm(s) { return String(s || '').toLowerCase().replace(/ё/g, 'е'); }
// «основа» слова: отрезаем окончание, чтобы «куриная»/«курица», «копченная»/«копчёная» находились
function atomStem(w) { return w.length >= 6 ? w.slice(0, Math.max(4, w.length - 3)) : w; }
function atomTokens(q) {
  return atomNorm(q).split(/[^a-zа-я0-9%]+/i).filter(w => w.length >= 2).slice(0, 6).map(atomStem);
}

async function atomOffSearch(q, tokens) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 4500);
    const r = await fetch('https://world.openfoodfacts.org/cgi/search.pl?search_terms=' + encodeURIComponent(q)
      + '&search_simple=1&action=process&json=1&page_size=24&fields=code,product_name,product_name_ru,generic_name,brands,serving_size,nutriments', {
      headers: { 'User-Agent': 'ATOM-fitness-app/1.0 (Telegram Mini App)' },
      signal: ac.signal,
      cf: { cacheTtl: 3600, cacheEverything: true }
    });
    clearTimeout(t);
    if (!r.ok) return [];
    const j = await r.json();
    const out = [];
    for (const p of (j.products || [])) {
      const n = p.nutriments || {};
      let kcal = Number(n['energy-kcal_100g']);
      if (!isFinite(kcal) && isFinite(Number(n['energy_100g']))) kcal = Number(n['energy_100g']) / 4.184;
      const name = String(p.product_name_ru || p.product_name || p.generic_name || '').trim();
      if (!name || !isFinite(kcal)) continue;
      const hay = atomNorm(name + ' ' + (p.brands || ''));
      if (!tokens.every(tk => hay.includes(tk))) continue; // OFF ищет нечётко — оставляем только то, где есть все слова
      out.push({
        product_name: name, brands: p.brands || '', serving_size: p.serving_size || '', code: p.code || '',
        nutriments: {
          'energy-kcal_100g': Math.round(kcal),
          'proteins_100g': Number(n['proteins_100g']) || 0,
          'fat_100g': Number(n['fat_100g']) || 0,
          'carbohydrates_100g': Number(n['carbohydrates_100g']) || 0
        }
      });
    }
    return out;
  } catch (e) { return []; }
}

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

        // Штрихкод (только цифры, 6–14 знаков): ищем по коду, а не по названию
        if (/^\d{6,14}$/.test(query.trim())) {
          const code = query.trim();
          let found = [];
          try {
            const r = await env.DB.prepare(
              "SELECT name, brand, serving_size, code, calories, protein, fat, carbs FROM products WHERE LTRIM(CAST(code AS TEXT), '0') = ? LIMIT 5"
            ).bind(code.replace(/^0+/, '')).all();
            found = (r.results || []).map(atomMapRow);
          } catch (e) { /* нет колонки/таблицы — пробуем внешнюю базу */ }
          let source = 'db';
          if (!found.length) { found = await atomOffLookup(code); source = 'off'; }
          return new Response(JSON.stringify({ products: found, count: found.length, query: code, barcode: true, source }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const q = query.trim().toLowerCase();
        const likeStart = q + '%';
        const likeAny = '%' + q + '%';
        const tokens = atomTokens(q);
        const nm = "REPLACE(name_lower,'ё','е')", br = "REPLACE(brand_lower,'ё','е')";
        const tokCond = tokens.map(() => '(' + nm + ' LIKE ? OR ' + br + ' LIKE ?)').join(' AND ');
        const tokBind = [];
        tokens.forEach(tk => { tokBind.push('%' + tk + '%', '%' + tk + '%'); });
        const stmt = env.DB.prepare(`
          SELECT name, brand, serving_size, code, calories, protein, fat, carbs
          FROM products
          WHERE
            ${tokens.length ? '(' + tokCond + ') OR' : ''}
            name_lower LIKE ?
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
        `).bind(...tokBind, likeAny, likeAny, likeStart, likeAny, likeStart);

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

        // Мало нашли в своей базе — добавляем результаты Open Food Facts (там есть белорусские и российские товары)
        let source = 'db';
        if (products.length < 8 && tokens.length) {
          const extra = await atomOffSearch(q, tokens);
          const seen = new Set(products.map(p => atomNorm(p.product_name) + '|' + atomNorm(p.brands)));
          for (const e of extra) {
            const k = atomNorm(e.product_name) + '|' + atomNorm(e.brands);
            if (!seen.has(k)) { seen.add(k); products.push(e); }
          }
          if (extra.length) source = 'db+off';
        }

        return new Response(JSON.stringify({
          products,
          count: products.length,
          query: q,
          source
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
