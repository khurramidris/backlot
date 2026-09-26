# Deploying Backlot

Two pieces:

| Piece | What it is | Where it runs |
|---|---|---|
| **Engine** (this repo) | API + job worker + FFmpeg. Every paid call, all rendering, credits and payments. | Any Docker host: Railway, Render, Fly.io or a VM |
| **App** (`scene-scribe-studio-91`) | Landing page, sign-in, create, watch, credits. Talks to the engine over HTTPS. | Lovable (Publish), or any static/edge host |

## What you need to create first

- **Postgres for the engine.** Use its **own** database, for example Railway Postgres. Do **not** point it at the
  Lovable app's Supabase database: both use tables called `projects`, `episodes`, `scenes` and `shots`.
- **File storage.** A private S3-compatible bucket: Cloudflare R2, AWS S3, or a Supabase Storage bucket through its
  S3 connection.
- **Anthropic API key.** Used to write scripts, break them down and plan shots.
- **Video provider.** A MiniMax-H3-compatible endpoint and key: MiniMax's API, or your own server exposing
  the same API (set `MINIMAX_BASE_URL`).
- **Stripe account.** A secret key, plus a webhook endpoint (below).
- **Supabase** stays as-is. The engine only uses it to check who is signed in.

## Engine environment

Required in production:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` (turns credit enforcement on) |
| `DATABASE_URL` | the engine's own Postgres connection string |
| `FILE_SIGNING_SECRET` | a long random string (the engine refuses to start without it) |
| `PUBLIC_BASE_URL` | the engine's public URL, e.g. `https://engine.backlot.app` |
| `CORS_ORIGINS` | the app's origin(s), comma separated, e.g. `https://backlot.app` |
| `APP_URL` | the app's URL; Stripe Checkout returns customers to `APP_URL/credits` |
| `SUPABASE_URL` | the app's Supabase URL |
| `SUPABASE_ANON_KEY` | the app's Supabase publishable/anon key (lets the engine confirm sessions) |
| `STORAGE_DRIVER` | `s3` |
| `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | your bucket |
| `ANTHROPIC_API_KEY` | Anthropic key |
| `MINIMAX_API_KEY` (+ `MINIMAX_BASE_URL` if self-hosted) | video/image/voice provider |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe |

Pricing (what customers pay; all optional):

| Variable | Default | Meaning |
|---|---|---|
| `SELL_PER_SECOND_768P` / `SELL_PER_SECOND_2K` | `0.16` / `0.26` | credits per second of finished video |
| `SETUP_FEE_USD` | `0.5` | per video: script, cast, sets and shot plan |
| `CREDIT_PACKS` | `starter:10,creator:50,studio:200` | packs on the credits page (USD) |
| `SIGNUP_CREDIT_USD` | `0` | free credit for new accounts |
| `MAX_RUNTIME_SECONDS` | `600` | longest video one project can make |
| `MAX_ACTIVE_RENDERS_PER_USER` | `6` | fairness between customers |

Your own provider costs (`PRICE_768P`, `PRICE_2K`, `PRICE_IMAGE`, `PRICE_VOICE_CHAR`) are only used for spend
reports. Customer prices never change when your costs do.

Scaling: one container runs the API and the worker. For more throughput, run extra containers with `npm run worker`
(and `RUN_WORKER=0` on the API). The queue is safe to share.

## Stripe

1. Stripe Dashboard → Developers → Webhooks → Add endpoint: `https://<engine>/webhooks/stripe`.
2. Events: `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
3. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

Credits are added once per Checkout Session, whatever Stripe retries.

## App environment (Lovable)

Add `VITE_ENGINE_URL=https://<engine>` and publish. Nothing else changes: sign-in stays on the existing Supabase
project.

## After deploying: smoke test

1. `GET https://<engine>/health` → `{"ok":true,"mock":false}`.
2. Sign in on the app, then buy the smallest pack with a Stripe test card: the balance updates on the credits page.
3. Create a microdrama from one sentence. It should stop at "Your approval" with a script, cast and price.
4. Press "Make my video", wait for "Finished", play and download the MP4.
5. Use "Fix this shot" on one shot: the balance drops by that shot's price and a new edit appears.

## Local development

```bash
MOCK_PROVIDERS=1 ALLOW_DEV_TOKENS=1 DATABASE_URL=postgres://postgres@localhost:5432/studio npm run dev
DATABASE_URL=postgres://postgres@localhost:5432/vibe npx tsx test/vibe.e2e.ts   # prompt → paid, finished video
DATABASE_URL=postgres://postgres@localhost:5432/e2e npx tsx test/e2e.ts         # step-by-step pipeline
npm test                                                                          # unit tests
```
Each end-to-end run needs an empty database.
