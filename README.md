# moveAPT Email Engine — Cloudflare Worker + Brevo ESP

A small, Cloudflare-native email marketing engine for the moveAPT pre-launch:
- Waitlist signup endpoint
- Brevo contact creation/update
- Weekly automated email via Cloudflare Cron Trigger
- Simple admin endpoints for testing
- No database required for the MVP
- Brevo remains responsible for email delivery

## Architecture

Cloudflare Pages `/api/waitlist` -> Worker `/api/signup` -> Turnstile Siteverify -> Brevo Contacts
Cloudflare Cron -> Worker `scheduled()` -> Brevo transactional email

## Required secrets / variables

Set these in Cloudflare:

- `BREVO_API_KEY` — Brevo API key
- `BREVO_LIST_ID` — Brevo contact-list ID
- `BREVO_SENDER_EMAIL` — verified Brevo sender email
- `BREVO_SENDER_NAME` — e.g. `moveAPT`
- `ADMIN_TOKEN` — random admin secret used for test/manual endpoints
- `TURNSTILE_SECRET` — secret key paired with the website Turnstile site key

Use Wrangler secrets:

```bash
npx wrangler secret put BREVO_API_KEY
npx wrangler secret put BREVO_LIST_ID
npx wrangler secret put BREVO_SENDER_EMAIL
npx wrangler secret put BREVO_SENDER_NAME
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put TURNSTILE_SECRET
```

## Deploy

```bash
npm install
npx wrangler login
npx wrangler deploy
```

Or connect this GitHub repository to Cloudflare Workers Builds for automatic deployments on push.

## Endpoints

### `POST /api/signup`

Body:

```json
{
  "email": "person@example.com",
  "firstName": "Jane",
  "token": "TURNSTILE_TOKEN"
}
```

Validates the Turnstile token server-side, then adds/updates the person in the configured Brevo list. New contacts receive the welcome email when the sender is configured.

### `POST /api/test-send`

Requires:

`Authorization: Bearer YOUR_ADMIN_TOKEN`

Body:

```json
{
  "to": "your@email.com"
}
```

Sends a test email through Brevo.

### `POST /api/send-weekly`

Requires admin token. Sends the weekly email to the configured recipient list.

Body:

```json
{
  "subject": "moveAPT weekly update",
  "html": "<p>...</p>"
}
```

If `recipients` is omitted, the Worker retrieves contacts from the configured Brevo list and sends to them.

### `GET /api/health`

Basic health check.

## Weekly automation

The Worker has a Cloudflare Cron Trigger:

`0 14 * * 1`

That means every Monday at 14:00 UTC.

Edit `wrangler.toml` if you want another schedule.

The scheduled job sends a simple weekly update to contacts in the Brevo list. For a production marketing system, consider using a Brevo marketing campaign/template rather than hard-coding the content here.

## Important

This starter intentionally does not expose Brevo credentials to the browser.

For real marketing sends, make sure your sender/domain is verified in Brevo and that your list consists of properly opted-in recipients. Include an unsubscribe mechanism for marketing emails.
