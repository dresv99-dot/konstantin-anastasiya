const encoder = new TextEncoder();

function json(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const headers = { "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Max-Age": "86400", "Vary": "Origin" };
  if (origin && origin === env.ALLOWED_ORIGIN) headers["Access-Control-Allow-Origin"] = origin;
  return headers;
}

function clean(value, max = 500) {
  return String(value || "").trim().slice(0, max);
}

async function sign(value, secret) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function isAdmin(request, env) {
  if (!env.SESSION_SECRET) return false;
  const token = (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const [expiry, mac] = token.split(".");
  if (!expiry || Number(expiry) < Date.now()) return false;
  return mac === await sign(expiry, env.SESSION_SECRET);
}

async function rsvp(request, env) {
  if (!env.DB) return json({ error: "База данных не настроена" }, 503);
  let data;
  try { data = await request.json(); } catch { return json({ error: "Неверный формат" }, 400); }

  const firstName = clean(data.firstName, 100);
  const lastName = clean(data.lastName, 100);
  const attendance = data.attendance === "yes" ? "yes" : data.attendance === "no" ? "no" : "";
  if (!firstName || !lastName || !attendance) return json({ error: "Заполните имя и ответ о присутствии" }, 400);

  const attending = attendance === "yes";
  const companions = attending && Array.isArray(data.companionNames) ? data.companionNames.slice(0, 5).map((name) => clean(name, 100)) : [];
  const types = attending && Array.isArray(data.companionTypes) ? data.companionTypes.slice(0, 5).map((type) => type === "child" ? "child" : "adult") : [];
  const alcohol = attending && Array.isArray(data.alcohol) ? data.alcohol.slice(0, 10).map((item) => clean(item, 60)) : [];
  const diet = attending ? clean(data.diet) : "";
  const alcoholOther = attending ? clean(data.alcoholOther, 100) : "";
  const wine = attending ? clean(data.wine, 40) : "";
  if (companions.some((name) => !name) || companions.length !== types.length) {
    return json({ error: "Укажите имена всех сопровождающих" }, 400);
  }

  const result = await env.DB.prepare(`INSERT INTO rsvps
    (first_name, last_name, attendance, companion_names, companion_types, diet, alcohol, alcohol_other, wine)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(firstName, lastName, attendance, JSON.stringify(companions), JSON.stringify(types), diet, JSON.stringify(alcohol), alcoholOther, wine)
    .run();

  if (env.TELEGRAM_BOT_TOKEN && env.DB) {
    const organizers = (await env.DB.prepare("SELECT chat_id FROM telegram_organizers WHERE is_active = 1").all()).results;
    const guests = attendance === "yes" ? 1 + companions.length : 0;
    const message = `Новая анкета №${result.meta.last_row_id}\n${firstName} ${lastName}: ${attendance === "yes" ? `придёт (${guests} чел.)` : "не придёт"}${diet ? `\nПитание/аллергии: ${diet}` : ""}${alcohol.length ? `\nНапитки: ${[...alcohol, alcoholOther].filter(Boolean).join(", ")}` : ""}${wine ? `\nВино: ${wine}` : ""}`;
    await Promise.allSettled(organizers.map(({ chat_id }) => fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, text: message })
    })));
  }
  return json({ ok: true });
}

async function adminLogin(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Неверный запрос" }, 400); }
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET || body.password !== env.ADMIN_PASSWORD) return json({ error: "Неверный пароль" }, 401);
  const expiry = String(Date.now() + 8 * 60 * 60 * 1000);
  return json({ token: `${expiry}.${await sign(expiry, env.SESSION_SECRET)}` });
}

async function adminApi(request, env, pathname) {
  if (pathname === "/api/admin/login" && request.method === "POST") return adminLogin(request, env);
  if (!await isAdmin(request, env)) return json({ error: "Нужен вход" }, 401);
  if (!env.DB) return json({ error: "База данных не подключена" }, 503);

  if (pathname === "/api/admin/stats" && request.method === "GET") {
    const row = await env.DB.prepare(`SELECT COUNT(*) AS replies,
      SUM(CASE WHEN attendance='yes' THEN 1 ELSE 0 END) AS accepted,
      SUM(CASE WHEN attendance='no' THEN 1 ELSE 0 END) AS declined,
      SUM(CASE WHEN attendance='yes' THEN 1 + json_array_length(companion_names) ELSE 0 END) AS guests
      FROM rsvps`).first();
    return json(row);
  }
  if (pathname === "/api/admin/responses" && request.method === "GET") {
    const results = await env.DB.prepare("SELECT * FROM rsvps ORDER BY created_at DESC, id DESC").all();
    return json(results.results.map((row) => ({ ...row,
      companion_names: JSON.parse(row.companion_names), companion_types: JSON.parse(row.companion_types), alcohol: JSON.parse(row.alcohol)
    })));
  }
  return json({ error: "Не найдено" }, 404);
}

const htmlSafe = (value) => String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

async function telegram(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });
  const update = await request.json();
  const message = update.message;
  if (!message?.text || !env.DB) return new Response("ok");
  const chatId = String(message.chat.id);
  const send = (text) => fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML" })
  });

  const [rawCommand, ...args] = message.text.trim().split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();
  const userId = String(message.from?.id || "");
  const inviteCode = args[0] || "";
  if (message.chat.type !== "private") {
    await send("Откройте бота в личном чате, чтобы получить доступ.");
    return new Response("ok");
  }
  if (command === "/start" && inviteCode && env.ORGANIZER_INVITE_CODE && inviteCode === env.ORGANIZER_INVITE_CODE) {
    await env.DB.prepare(`INSERT INTO telegram_organizers
      (user_id, chat_id, username, first_name, last_name, is_active, updated_at)
      VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        chat_id = excluded.chat_id,
        username = excluded.username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        is_active = 1,
        updated_at = CURRENT_TIMESTAMP`)
      .bind(userId, chatId, clean(message.from?.username, 100), clean(message.from?.first_name, 100), clean(message.from?.last_name, 100))
      .run();
    await send("Вы подключены к уведомлениям. Команды: /stats, /guests, /no, /allergies, /drinks, /guest имя, /help. Отключить уведомления: /stop.");
    return new Response("ok");
  }
  const organizer = await env.DB.prepare("SELECT is_active FROM telegram_organizers WHERE user_id = ?")
    .bind(userId).first();
  if (!organizer?.is_active) {
    await send("Доступ не найден. Попросите у организаторов личную ссылку-приглашение.");
    return new Response("ok");
  }
  if (command === "/stop") {
    await env.DB.prepare("UPDATE telegram_organizers SET is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?")
      .bind(userId).run();
    await send("Уведомления отключены. Чтобы подключиться снова, откройте ссылку-приглашение.");
    return new Response("ok");
  }
  if (command === "/start" || command === "/help") {
    await send("Команды организатора:\n/stats — сводка\n/guests — кто придёт\n/no — кто не придёт\n/allergies — питание и аллергии\n/drinks — напитки\n/guest имя — найти анкету");
  } else if (command === "/stats") {
    const stats = await env.DB.prepare(`SELECT COUNT(*) AS replies,
      SUM(CASE WHEN attendance='yes' THEN 1 ELSE 0 END) AS yes,
      SUM(CASE WHEN attendance='no' THEN 1 ELSE 0 END) AS no,
      SUM(CASE WHEN attendance='yes' THEN 1 + json_array_length(companion_names) ELSE 0 END) AS guests FROM rsvps`).first();
    await send(`Ответили: ${stats.replies || 0}\nПридут: ${stats.yes || 0} анкет, всего гостей: ${stats.guests || 0}\nНе придут: ${stats.no || 0}`);
  } else if (["/guests", "/no", "/allergies", "/drinks"].includes(command)) {
    const rows = (await env.DB.prepare("SELECT * FROM rsvps ORDER BY last_name, first_name").all()).results;
    const selected = rows.filter((row) => command === "/guests" ? row.attendance === "yes" : command === "/no" ? row.attendance === "no" : command === "/allergies" ? Boolean(row.diet) : Boolean(JSON.parse(row.alcohol).length || row.wine || row.alcohol_other));
    const lines = selected.map((row) => {
      const name = `${htmlSafe(row.first_name)} ${htmlSafe(row.last_name)}`;
      if (command === "/allergies") return `${name}: ${htmlSafe(row.diet)}`;
      if (command === "/drinks") return `${name}: ${[...JSON.parse(row.alcohol), row.alcohol_other, row.wine].filter(Boolean).map(htmlSafe).join(", ")}`;
      const companions = JSON.parse(row.companion_names);
      return `${name}${companions.length ? ` + ${companions.map(htmlSafe).join(", ")}` : ""}`;
    });
    const output = lines.length ? lines.join("\n") : "Пока нет таких ответов.";
    await send(output.length > 3800 ? `${output.slice(0, 3700)}\n…Откройте панель организатора для полного списка.` : output);
  } else if (command === "/guest" && args.length) {
    const query = `%${args.join(" ").slice(0, 100)}%`;
    const rows = (await env.DB.prepare("SELECT * FROM rsvps WHERE first_name LIKE ? OR last_name LIKE ? ORDER BY created_at DESC LIMIT 5").bind(query, query).all()).results;
    const lines = rows.map((row) => `${htmlSafe(row.first_name)} ${htmlSafe(row.last_name)} — ${row.attendance === "yes" ? "придёт" : "не придёт"}\nСопровождающие: ${JSON.parse(row.companion_names).map(htmlSafe).join(", ") || "нет"}\nПитание/аллергии: ${htmlSafe(row.diet) || "не указаны"}\nНапитки: ${[...JSON.parse(row.alcohol), row.alcohol_other, row.wine].filter(Boolean).map(htmlSafe).join(", ") || "не указаны"}`).join("\n\n");
    await send(lines || "Ничего не найдено.");
  } else await send("Не знаю такую команду. Напишите /help");
  return new Response("ok");
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const headers = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });

    let response;
    try {
      if (url.pathname === "/api/telegram/webhook" && request.method === "POST") return await telegram(request, env);
      if (url.pathname === "/api/rsvp" && request.method === "POST") response = await rsvp(request, env);
      else if (url.pathname.startsWith("/api/admin/")) response = await adminApi(request, env, url.pathname);
      else response = json({ error: "Не найдено" }, 404);
    } catch {
      response = json({ error: "Внутренняя ошибка. Попробуйте позже." }, 500);
    }
    const responseHeaders = new Headers(response.headers);
    Object.entries(headers).forEach(([key, value]) => responseHeaders.set(key, value));
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
  }
};
