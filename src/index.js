const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: JSON_HEADERS
  });
}

function corsHeaders(origin = "*") {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "Content-Type, Authorization"
  };
}

function emailLooksValid(email) {
  return typeof email === "string" &&
    email.length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function brevoFetch(path, env, options = {}) {
  const response = await fetch(`https://api.brevo.com/v3${path}`, {
    ...options,
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "api-key": env.BREVO_API_KEY,
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; }
  catch { body = { raw: text }; }

  if (!response.ok) {
    throw new Error(`Brevo ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function addContact(email, firstName, env) {
  return brevoFetch("/contacts", env, {
    method: "POST",
    body: JSON.stringify({
      email,
      attributes: firstName ? { FNAME: firstName } : {},
      listIds: [Number(env.BREVO_LIST_ID)],
      updateEnabled: true
    })
  });
}

async function sendEmail({ to, subject, htmlContent, env }) {
  return brevoFetch("/smtp/email", env, {
    method: "POST",
    body: JSON.stringify({
      sender: {
        email: env.BREVO_SENDER_EMAIL,
        name: env.BREVO_SENDER_NAME || "moveAPT"
      },
      to: Array.isArray(to) ? to : [{ email: to }],
      subject,
      htmlContent
    })
  });
}

async function listBrevoContacts(env) {
  return brevoFetch(
    `/contacts?limit=1000&offset=0&listIds=${encodeURIComponent(env.BREVO_LIST_ID)}`,
    env,
    { method: "GET" }
  );
}

function requireAdmin(request, env) {
  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${env.ADMIN_TOKEN}`;
}

function weeklyHtml() {
  return `
  <html>
    <body style="font-family:Arial,sans-serif;line-height:1.6;max-width:640px;margin:40px auto;padding:20px">
      <h1>moveAPT weekly update</h1>
      <p>We're building moveAPT to help you figure out what furniture will fit in your next apartment.</p>
      <p>Thanks for joining the early-access list.</p>
      <p>More soon.</p>
      <p>— The moveAPT team</p>
    </body>
  </html>`;
}

async function handleSignup(request, env) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const email = String(body.email || "").trim().toLowerCase();
  const firstName = String(body.firstName || "").trim();

  if (!emailLooksValid(email)) {
    return json({ error: "Please provide a valid email address." }, 400);
  }

  if (!env.BREVO_API_KEY || !env.BREVO_LIST_ID) {
    return json({ error: "Server email configuration is incomplete." }, 500);
  }

  try {
    await addContact(email, firstName, env);
    return json({ ok: true, message: "You're on the moveAPT list." });
  } catch (error) {
    console.error(error);
    return json({ error: "Could not add contact." }, 502);
  }
}

async function handleTestSend(request, env) {
  if (!requireAdmin(request, env)) return json({ error: "Unauthorized" }, 401);

  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const to = String(body.to || "").trim();
  if (!emailLooksValid(to)) return json({ error: "Invalid recipient." }, 400);

  try {
    const result = await sendEmail({
      to,
      subject: "moveAPT email engine test",
      htmlContent: "<p>This is a test email from the moveAPT Cloudflare Worker.</p>",
      env
    });
    return json({ ok: true, result });
  } catch (error) {
    console.error(error);
    return json({ error: String(error.message || error) }, 502);
  }
}

async function handleWeeklySend(request, env) {
  if (!requireAdmin(request, env)) return json({ error: "Unauthorized" }, 401);

  let body = {};
  try { body = await request.json(); } catch {}

  return sendWeekly(env, body.subject, body.html);
}

async function sendWeekly(env, subject, html) {
  try {
    const data = await listBrevoContacts(env);
    const contacts = (data.contacts || [])
      .filter(c => c.email && !c.emailBlacklisted)
      .map(c => ({ email: c.email, name: c.attributes?.FNAME || undefined }));

    if (!contacts.length) {
      return json({ ok: true, sent: 0, message: "No contacts in the Brevo list." });
    }

    const result = await sendEmail({
      to: contacts,
      subject: subject || "moveAPT weekly update",
      htmlContent: html || weeklyHtml(),
      env
    });

    return json({
      ok: true,
      sent: contacts.length,
      messageId: result.messageId || null
    });
  } catch (error) {
    console.error(error);
    return json({ error: String(error.message || error) }, 502);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request.headers.get("origin") || "*")
      });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true, service: "moveAPT email engine" });
    }

    // TEMPORARY DEBUG ENDPOINT — remove after troubleshooting.
    // Reveals only the length/first+last char of ADMIN_TOKEN, never the full value.
    if (url.pathname === "/api/debug-token" && request.method === "GET") {
      const t = env.ADMIN_TOKEN || "";
      return json({
        isSet: Boolean(env.ADMIN_TOKEN),
        length: t.length,
        firstChar: t[0] || null,
        lastChar: t[t.length - 1] || null
      });
    }

    if (url.pathname === "/api/signup" && request.method === "POST") {
      const response = await handleSignup(request, env);
      const headers = new Headers(response.headers);
      Object.entries(corsHeaders(request.headers.get("origin") || "*"))
        .forEach(([k, v]) => headers.set(k, v));
      return new Response(response.body, { status: response.status, headers });
    }

    if (url.pathname === "/api/test-send" && request.method === "POST") {
      return handleTestSend(request, env);
    }

    if (url.pathname === "/api/send-weekly" && request.method === "POST") {
      return handleWeeklySend(request, env);
    }

    return new Response(
      "moveAPT email engine is running. Use /api/health.",
      { status: 200, headers: { "content-type": "text/plain" } }
    );
  },

  async scheduled(controller, env, ctx) {
    // Cloudflare invokes this every Monday at the cron time in wrangler.toml.
    // waitUntil keeps the async Brevo request alive after the scheduled event starts.
    ctx.waitUntil(sendWeekly(env));
  }
};
