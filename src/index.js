const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders }
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

async function parseJsonResponse(response) {
  const text = await response.text();
  if (!text) return {};
  try { return JSON.parse(text); }
  catch { return { raw: text }; }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function brevoFetch(path, env, options = {}) {
  const response = await fetchWithTimeout(`https://api.brevo.com/v3${path}`, {
    ...options,
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "api-key": env.BREVO_API_KEY,
      ...(options.headers || {})
    }
  });

  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Brevo ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function addContact(email, firstName, env) {
  const response = await fetchWithTimeout("https://api.brevo.com/v3/contacts", {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
      "api-key": env.BREVO_API_KEY
    },
    body: JSON.stringify({
      email,
      attributes: firstName ? { FNAME: firstName } : {},
      listIds: [Number(env.BREVO_LIST_ID)],
      updateEnabled: true
    })
  });

  const body = await parseJsonResponse(response);
  if (!response.ok) {
    throw new Error(`Brevo ${response.status}: ${JSON.stringify(body)}`);
  }

  return {
    status: response.status === 204 ? "duplicate" : "created",
    body
  };
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

async function verifyTurnstile(token, remoteip, env) {
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  if (remoteip) form.append("remoteip", remoteip);

  const response = await fetchWithTimeout("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form
  });

  const result = await parseJsonResponse(response);
  return {
    ok: response.ok && result.success === true && result.action === "waitlist_signup",
    result
  };
}

async function listBrevoContacts(env) {
  return brevoFetch(
    `/contacts?limit=1000&offset=0&listIds=${encodeURIComponent(env.BREVO_LIST_ID)}`,
    env,
    { method: "GET" }
  );
}

function requireAdmin(request, env) {
  if (!env.ADMIN_TOKEN) return false;
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

function welcomeHtml() {
  return `
  <html>
    <body style="font-family:Arial,sans-serif;line-height:1.6;max-width:640px;margin:40px auto;padding:20px">
      <h1>Welcome to moveAPT</h1>
      <p>Thanks for joining the early-access list — you're in.</p>
      <p>We'll email you as soon as we launch.</p>
      <p>— The moveAPT team</p>
    </body>
  </html>`;
}

async function handleSignup(request, env, ctx) {
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "Invalid JSON" }, 400); }

  const email = String(body.email || "").trim().toLowerCase();
  const firstName = String(body.firstName || "").trim();
  const token = String(body.token || "").trim();
  const remoteip = body.remoteip ? String(body.remoteip) : undefined;

  if (!emailLooksValid(email)) {
    return json({ error: "Please provide a valid email address." }, 400);
  }

  if (!token) {
    return json({ error: "Missing verification token." }, 400);
  }

  if (!env.BREVO_API_KEY || !env.BREVO_LIST_ID || !env.TURNSTILE_SECRET) {
    console.error("Missing BREVO_API_KEY, BREVO_LIST_ID, or TURNSTILE_SECRET");
    return json({ error: "Server email configuration is incomplete." }, 503);
  }

  const listId = Number(env.BREVO_LIST_ID);
  if (!Number.isInteger(listId) || listId <= 0) {
    console.error("BREVO_LIST_ID must be a positive integer");
    return json({ error: "Server email configuration is invalid." }, 503);
  }

  try {
    const verification = await verifyTurnstile(token, remoteip, env);
    if (!verification.ok) {
      console.warn("Turnstile verification failed", verification.result);
      return json({ error: "Verification failed. Please refresh and try again." }, 403);
    }

    const contact = await addContact(email, firstName, env);

    if (contact.status === "created" && env.BREVO_SENDER_EMAIL) {
      ctx.waitUntil(
        sendEmail({
          to: email,
          subject: "You're on the moveAPT waitlist",
          htmlContent: welcomeHtml(),
          env
        }).catch(error => console.error("Welcome email failed", error))
      );
    }

    return json({
      ok: true,
      status: contact.status,
      message: contact.status === "duplicate"
        ? "You're already on the list! We'll reach out when we launch."
        : "You're on the list! We'll be in touch soon."
    });
  } catch (error) {
    console.error("Signup failed", error);
    return json({ error: "Could not add contact. Please try again." }, 502);
  }
}

async function handleTestSend(request, env) {
  if (!requireAdmin(request, env)) return json({ error: "Unauthorized" }, 401);
  if (!env.BREVO_API_KEY || !env.BREVO_SENDER_EMAIL) {
    return json({ error: "BREVO_API_KEY and BREVO_SENDER_EMAIL are required." }, 503);
  }

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
  if (!env.BREVO_API_KEY || !env.BREVO_LIST_ID || !env.BREVO_SENDER_EMAIL) {
    return json({ error: "BREVO_API_KEY, BREVO_LIST_ID, and BREVO_SENDER_EMAIL are required." }, 503);
  }

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
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get("origin") || "*";

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin)
      });
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({
        ok: true,
        service: "moveAPT email engine",
        configured: {
          brevo: Boolean(env.BREVO_API_KEY && env.BREVO_LIST_ID),
          sender: Boolean(env.BREVO_SENDER_EMAIL),
          turnstile: Boolean(env.TURNSTILE_SECRET),
          admin: Boolean(env.ADMIN_TOKEN)
        }
      });
    }

    if (url.pathname === "/api/signup" && request.method === "POST") {
      const response = await handleSignup(request, env, ctx);
      const headers = new Headers(response.headers);
      Object.entries(corsHeaders(origin)).forEach(([k, v]) => headers.set(k, v));
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
    ctx.waitUntil(sendWeekly(env));
  }
};
