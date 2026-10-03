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
  const hookah = attending && data.hookah === "yes" ? "yes" : "no";
  const alcoholOther = attending ? clean(data.alcoholOther, 100) : "";
  const wine = attending ? clean(data.wine, 40) : "";
  if (companions.some((name) => !name) || companions.length !== types.length) {
    return json({ error: "Укажите имена всех сопровождающих" }, 400);
  }

  const result = await env.DB.prepare(`INSERT INTO rsvps
    (first_name, last_name, attendance, companion_names, companion_types, diet, alcohol, alcohol_other, wine, hookah)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(firstName, lastName, attendance, JSON.stringify(companions), JSON.stringify(types), diet, JSON.stringify(alcohol), alcoholOther, wine, hookah)
    .run();

  if (env.TELEGRAM_BOT_TOKEN && env.DB) {
    const organizers = (await env.DB.prepare("SELECT chat_id FROM telegram_organizers WHERE is_active = 1").all()).results;
    const guests = attendance === "yes" ? 1 + companions.length : 0;
    const companionsLine = companions.length ? `\n+${companions.map((name, index) => `${name} (${types[index] === "child" ? "ребенок" : "взрослый"})`).join(", ")}` : "";
    const drinkChoices = alcohol.filter((item) => item !== "Свой вариант");
    if (alcohol.includes("Свой вариант") && alcoholOther) drinkChoices.push(alcoholOther);
    const message = `Новая анкета №${result.meta.last_row_id}\n${firstName} ${lastName}: ${attendance === "yes" ? `придёт (${guests} чел.)` : "не придёт"}${companionsLine}${diet ? `\nОсобенности питания: ${diet}` : ""}${attendance === "yes" ? `\nКальян: ${hookah === "yes" ? "да" : "нет"}` : ""}${drinkChoices.length ? `\nНапитки: ${drinkChoices.join(", ")}` : ""}${wine ? `\nВино: ${wine}` : ""}`;
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

function storedArray(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function guestListLine(row) {
  const companions = storedArray(row.companion_names);
  const types = storedArray(row.companion_types);
  const details = companions.map((name, index) => `${htmlSafe(name)} (${types[index] === "child" ? "ребенок" : "взрослый"})`);
  return `${htmlSafe(row.first_name)} ${htmlSafe(row.last_name)}${details.length ? ` + ${details.join(", ")}` : ""}`;
}

function drinksForResponse(row) {
  const selected = storedArray(row.alcohol);
  const drinks = selected.filter((item) => item === "Водка" || item === "Коньяк");
  if (selected.includes("Свой вариант") && row.alcohol_other) drinks.push(row.alcohol_other);
  const sweetness = String(row.wine || "").trim().toLowerCase();
  if (sweetness && selected.includes("Красное вино")) drinks.push(`Красное ${sweetness}`);
  if (sweetness && selected.includes("Белое вино")) drinks.push(`Белое ${sweetness}`);
  return drinks;
}

async function telegram(request, env) {
  if (!env.TELEGRAM_BOT_TOKEN || request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.TELEGRAM_WEBHOOK_SECRET) return new Response("Forbidden", { status: 403 });
  const update = await request.json();
  const message = update.message;
  if (!message?.text || !env.DB) return new Response("ok");
  const chatId = String(message.chat.id);
  const menuKeyboard = {
    keyboard: [
      [{ text: "📊 Сводка" }, { text: "✅ Кто придет" }],
      [{ text: "🚫 Кто не придёт" }, { text: "🥗 Питание и аллергии" }],
      [{ text: "🥂 Напитки" }, { text: "🔎 Найти гостя" }],
      [{ text: "Кальян" }],
      [{ text: "🔕 Отключить уведомления" }]
    ],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Выберите действие"
  };
  const messageText = message.text.trim();
  const [rawCommand, ...initialArgs] = messageText.split(/\s+/);
  let args = initialArgs;
  let command = rawCommand.split("@")[0].toLowerCase();
  const buttonCommands = new Map([
    ["📊 Сводка", "/stats"],
    ["✅ Кто придет", "/guests"],
    ["✅ Кто придёт", "/guests"],
    ["🚫 Кто не придёт", "/no"],
    ["🥗 Питание и аллергии", "/allergies"],
    ["🥂 Напитки", "/drinks"],
    ["Кальян", "/hookah"],
    ["🔕 Отключить уведомления", "/stop"]
  ]);
  let temporaryAction = false;
  let relatedMessageIds = [];
  const send = async (text, replyMarkup) => {
    const response = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "HTML", ...(replyMarkup ? { reply_markup: replyMarkup } : {}) })
    });
    if (temporaryAction && response.ok) {
      const result = await response.json();
      const ids = [...new Set([...relatedMessageIds, result.result?.message_id].filter(Number.isInteger))];
      const deleteAt = Math.floor(Date.now() / 1000) + 60;
      await Promise.allSettled(ids.map((messageId) => env.DB.prepare(
        "INSERT INTO telegram_message_cleanup (chat_id, message_id, delete_at) VALUES (?, ?, ?)"
      ).bind(chatId, messageId, deleteAt).run()));
    }
    return response;
  };
  if (buttonCommands.has(messageText)) command = buttonCommands.get(messageText);
  if (buttonCommands.has(messageText)) {
    temporaryAction = true;
    relatedMessageIds = [message.message_id];
  }
  const searchPrompt = "Введите имя или фамилию гостя.";
  if (messageText === "🔎 Найти гостя") {
    temporaryAction = true;
    relatedMessageIds = [message.message_id];
    await send(searchPrompt, { force_reply: true, input_field_placeholder: "Имя или фамилия" });
    return new Response("ok");
  }
  if (message.reply_to_message?.text === searchPrompt) {
    command = "/guest";
    args = [messageText];
    temporaryAction = true;
    relatedMessageIds = [message.message_id, message.reply_to_message.message_id];
  }
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
    await send("Вы подключены к уведомлениям. Выберите действие на клавиатуре ниже.", menuKeyboard);
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
    await send("Уведомления отключены. Чтобы подключиться снова, откройте ссылку-приглашение.", { remove_keyboard: true });
    return new Response("ok");
  }
  if (command === "/start" || command === "/help") {
    await send("Выберите действие на клавиатуре ниже. Для поиска гостя нажмите «🔎 Найти гостя» и введите имя или фамилию.", menuKeyboard);
  } else if (command === "/stats") {
    const rows = (await env.DB.prepare("SELECT attendance, companion_names, companion_types FROM rsvps").all()).results;
    const accepted = rows.filter((row) => row.attendance === "yes");
    const declined = rows.filter((row) => row.attendance === "no").length;
    const guestCount = accepted.reduce((sum, row) => sum + 1 + storedArray(row.companion_names).length, 0);
    const adultCount = accepted.reduce((sum, row) => sum + 1 + storedArray(row.companion_types).filter((type) => type === "adult").length, 0);
    const childCount = accepted.reduce((sum, row) => sum + storedArray(row.companion_types).filter((type) => type === "child").length, 0);
    await send(`Всего анкет: ${rows.length}\nПридут: ${guestCount} | Не придут: ${declined}\nВзрослых: ${adultCount} | Детей: ${childCount}`);
  } else if (command === "/drinks") {
    const rows = (await env.DB.prepare("SELECT * FROM rsvps WHERE attendance = 'yes' ORDER BY last_name, first_name").all()).results;
    const totals = { vodka: 0, cognac: 0, redSweet: 0, redDry: 0, whiteSweet: 0, whiteDry: 0 };
    const extraTotals = new Map();
    for (const row of rows) {
      const selected = storedArray(row.alcohol);
      if (selected.includes("Водка")) totals.vodka += 1;
      if (selected.includes("Коньяк")) totals.cognac += 1;
      if (selected.includes("Красное вино") && row.wine === "Полусладкое") totals.redSweet += 1;
      if (selected.includes("Красное вино") && row.wine === "Полусухое") totals.redDry += 1;
      if (selected.includes("Белое вино") && row.wine === "Полусладкое") totals.whiteSweet += 1;
      if (selected.includes("Белое вино") && row.wine === "Полусухое") totals.whiteDry += 1;
      if (selected.includes("Свой вариант") && row.alcohol_other) {
        extraTotals.set(row.alcohol_other, (extraTotals.get(row.alcohol_other) || 0) + 1);
      }
    }
    const totalCount = Object.values(totals).reduce((sum, count) => sum + count, 0)
      + [...extraTotals.values()].reduce((sum, count) => sum + count, 0);
    const summary = [
      `Всего выбранных напитков: ${totalCount}`,
      `Водка: ${totals.vodka} | Коньяк: ${totals.cognac}`,
      `Красное полусладкое: ${totals.redSweet} | Красное полусухое: ${totals.redDry}`,
      `Белое полусладкое: ${totals.whiteSweet} | Белое полусухое: ${totals.whiteDry}`,
      ...[...extraTotals.entries()].map(([name, count]) => `${htmlSafe(name)}: ${count}`)
    ].join("\n");
    const details = rows.map((row) => {
      const drinks = drinksForResponse(row).map(htmlSafe);
      return `${htmlSafe(row.first_name)} ${htmlSafe(row.last_name)}: ${drinks.join(", ") || "не указаны"}`;
    });
    const output = `${summary}\n\nПо анкетам:\n${details.length ? details.join("\n") : "Пока нет ответов от тех, кто придет."}`;
    await send(output.length > 3900 ? `${output.slice(0, 3750)}\n…Остальные анкеты не поместились в сообщение.` : output);
  } else if (command === "/hookah") {
    const rows = (await env.DB.prepare("SELECT * FROM rsvps WHERE attendance = 'yes' AND hookah = 'yes' ORDER BY last_name, first_name").all()).results;
    const adultCount = rows.reduce((sum, row) => sum + 1 + storedArray(row.companion_types).filter((type) => type === "adult").length, 0);
    const lines = rows.map((row) => {
      const adultCompanions = storedArray(row.companion_names).filter((_, index) => storedArray(row.companion_types)[index] === "adult");
      return `${htmlSafe(row.first_name)} ${htmlSafe(row.last_name)}${adultCompanions.length ? ` + ${adultCompanions.map(htmlSafe).join(", ")}` : ""}`;
    });
    const output = `Кальян будут курить ${adultCount} человек.\nПо анкетам:\n${lines.length ? lines.join("\n") : "Пока никто не выбрал кальян."}`;
    await send(output.length > 3900 ? `${output.slice(0, 3750)}\n…Остальные анкеты не поместились в сообщение.` : output);
  } else if (["/guests", "/no", "/allergies", "/drinks"].includes(command)) {
    const rows = (await env.DB.prepare("SELECT * FROM rsvps ORDER BY last_name, first_name").all()).results;
    const selected = rows.filter((row) => command === "/guests" ? row.attendance === "yes" : command === "/no" ? row.attendance === "no" : command === "/allergies" ? Boolean(row.diet) : Boolean(JSON.parse(row.alcohol).length || row.wine || row.alcohol_other));
    const lines = selected.map((row) => {
      const name = `${htmlSafe(row.first_name)} ${htmlSafe(row.last_name)}`;
      if (command === "/allergies") return `${name}: ${htmlSafe(row.diet)}`;
      if (command === "/drinks") return `${name}: ${drinksForResponse(row).map(htmlSafe).join(", ")}`;
      if (command === "/guests") return guestListLine(row);
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
  } else await send("Выберите действие на клавиатуре ниже или напишите /help.", menuKeyboard);
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
  },

  async scheduled(event, env) {
    const now = Math.floor(Date.now() / 1000);
    const due = (await env.DB.prepare("SELECT chat_id, message_id FROM telegram_message_cleanup WHERE delete_at <= ? ORDER BY delete_at LIMIT 100").bind(now).all()).results;
    for (const item of due) {
      try {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/deleteMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: item.chat_id, message_id: item.message_id })
        });
      } finally {
        await env.DB.prepare("DELETE FROM telegram_message_cleanup WHERE chat_id = ? AND message_id = ?")
          .bind(item.chat_id, item.message_id).run();
      }
    }
  }
};
