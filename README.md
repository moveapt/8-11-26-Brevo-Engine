# moveAPT Brevo Email Worker --No Turnstile

Cloudflare Worker used by the moveAPT Pages waitlist.

Flow:

`Browser -> Cloudflare Pages /api/waitlist -> Worker /api/signup -> Brevo Contacts`

## Required Worker variables / secrets

Set these in Cloudflare **Workers & Pages -> this Worker -> Settings -> Variables and Secrets**:

- `BREVO_API_KEY` — Brevo API key (secret)
- `BREVO_LIST_ID` — numeric Brevo list ID
- `BREVO_SENDER_EMAIL` — verified Brevo sender email (needed for welcome/weekly email)
- `BREVO_SENDER_NAME` — optional sender display name
- `ADMIN_TOKEN` — secret bearer token for admin endpoints

**No `TURNSTILE_SECRET` is required. Turnstile is intentionally removed.**

## Endpoints

- `GET /api/health` — configuration health check
- `POST /api/signup` — adds a waitlist email to Brevo
- `POST /api/test-send` — admin-only test email
- `POST /api/send-weekly` — admin-only weekly send

The signup endpoint accepts the payload forwarded by the Pages function, including `email`, `movingTo`, `howHeard`, `companyWebsite`, and `formStartedAt`. `companyWebsite` is treated as a honeypot and very fast submissions may be silently filtered.

## Deploy

Connect this repository to the Cloudflare Worker build/deploy flow, or run `npm install` then `npm run deploy`. Existing dashboard variables are preserved by `keep_vars = true`.
