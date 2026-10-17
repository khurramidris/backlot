# Deploying Backlot

**First time? Follow `docs/BETA.md`: the same setup in plain language, in order, with a built-in Setup check.**
This file is the detailed reference.

Everything below is a one-time setup. After it, every push to `main` that passes CI can be deployed as is.

```
                 ┌──────────────── Railway ────────────────┐
 customers ────▶ │  backlot image (Dockerfile)             │ ──▶ Anthropic (scripts, planning)
                 │  web app + API + job worker + FFmpeg    │ ──▶ MiniMax API (reference images, voices)
                 └──────┬───────────────┬──────────────────┘ ──▶ Lemon Squeezy (subscriptions, top-ups, tax)
                        │               │ jobs / status / cancel / scaling
                 Supabase:              ▼
                 Auth, Postgres,   RunPod Serverless: gpu-worker image + H3 weights on a network volume
                 Storage (S3)      (autoscaled GPU workers upload clips straight to Supabase Storage)
```

## 1. Supabase (sign-in, database, file storage)

1. Create a project at supabase.com (pick the region closest to your customers and to RunPod).
2. **Auth → Providers**: keep Email on. For Google, create an OAuth client in Google Cloud and paste its id and
   secret.
   - **Auth → URL configuration**: set the Site URL to `https://<your-domain>`, and add these Redirect URLs:
     `https://<your-domain>/dashboard` (sign-up and Google), `https://<your-domain>/reset-password` (forgot
     password) and `https://<your-domain>/account` (change email).
   - **Auth → SMTP settings**: add your own email provider (Resend, Postmark, SES…). Supabase's built-in sender
     only allows a few emails an hour, which isn't enough for sign-up confirmations and password resets.
3. **Project Settings → API**: copy the Project URL → `SUPABASE_URL`, and the anon/publishable key →
   `SUPABASE_ANON_KEY`.
4. **Connect → Session pooler**: copy the connection string → `DATABASE_URL`. The engine creates its tables on
   first boot.
5. **Storage**: create a **private** bucket `backlot`. **Storage → S3 connection**: create access keys →
   `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_BUCKET=backlot`,
   `STORAGE_DRIVER=s3`.

## 2. RunPod (the video model)

Follow `gpu-worker/README.md`:
1. Build and push the `gpu-worker` image.
2. Put the H3 weights on a network volume.
3. Create a Serverless endpoint.
   - To prove the whole path before the model is ready, set `MODEL_BACKEND=fake`: it renders test patterns.
4. Copy the endpoint id → `RUNPOD_ENDPOINT_ID`, and create an API key → `RUNPOD_API_KEY`.

### Scaling settings (engine env)

| Variable | Start with | Meaning |
|---|---|---|
| `RUNPOD_MAX_WORKERS` | 5 | Budget cap: never more GPUs than this |
| `RUNPOD_WARM_WORKERS` | 1 | GPUs kept warm while customers are active |
| `RUNPOD_WARM_MINUTES` | 15 | How long after the last render to stay warm before scaling to 0 |
| `RUNPOD_JOBS_PER_WORKER` | 2 | Queue depth per GPU before the floor rises |
| `VIDEO_MAX_INFLIGHT` | 10 | Renders sent to RunPod at once (≈ max workers × 2) |
| `RUNPOD_MANAGE_SCALING` | 0, then 1 | Start at 0, watch `/v1/admin/capacity`, then let the controller act |
| `RUNPOD_GPU_PRICE_PER_SECOND` | your rate | Records real GPU cost per clip, for margin reports |

As demand grows, raise `RUNPOD_MAX_WORKERS` (and your RunPod quota). Everything else adapts: RunPod adds
workers when the queue backs up, and the controller drops the floor to zero when nobody is rendering.

## 3. Lemon Squeezy (payments)

Lemon Squeezy is the Merchant of Record: it charges customers, adds and pays VAT and sales tax, and sends
invoices. Start in **test mode**, and switch the store to live once the launch check passes.

1. Create a store. **Settings → Stores**: copy the store's number → `LEMONSQUEEZY_STORE_ID`.
2. **Products → New product "Basic"**: pricing **Subscription**, $20, every 1 month. Publish it, then open the
   variant and copy its id → `LEMONSQUEEZY_BASIC_VARIANT_ID`. (Variant ids are in the product's "…" menu →
   "Copy ID", or from `GET https://api.lemonsqueezy.com/v1/variants`.)
3. **Credit packs**: one product each, pricing **Single payment**: Starter $10, Creator $50, Studio $200.
   Copy each variant id into `CREDIT_PACKS=starter:10:<id>,creator:50:<id>,studio:200:<id>`. The first
   number is the credit the customer gets, so keep it equal to the product price. The engine never trusts the
   amount paid, which includes tax.
4. **Settings → API**: create an API key → `LEMONSQUEEZY_API_KEY`. Test-mode and live-mode keys are separate.
5. **Settings → Webhooks → +**: URL `https://<your-domain>/webhooks/lemonsqueezy`, a long random signing
   secret (`openssl rand -hex 32`) → `LEMONSQUEEZY_WEBHOOK_SECRET`, and these events:
   `order_created`, `subscription_created`, `subscription_updated`, `subscription_cancelled`,
   `subscription_resumed`, `subscription_expired`, `subscription_paused`, `subscription_unpaused`,
   `subscription_payment_success`.
6. **Settings → Customer portal**: turn it on, and allow cancelling and updating the payment method. The
   Billing page's "Manage subscription" button opens it.
7. Set `APP_URL=https://<your-domain>`: checkout sends customers back to `/billing?paid=1`.

How the money works:
- **Plan credit** (`PLAN_CREDITS_USD`, $20) is **reset**, not added, on every paid subscription invoice, so
  unused plan credit expires at renewal. The ledger (`credit_events`) records `plan_expired` and `plan_credit`.
- **Top-up credit** from packs, failed-render refunds and refunded setup fees never expire. Spending takes plan
  credit first.
- **Everything is charged.** The setup fee (`SETUP_FEE_USD`) pays for a video's first automatic pass (story, screenplay,
  cast, sets, shot plan); rendering is per second. Afterwards each action has its own price (`SELL_IMAGE_USD`,
  `SELL_VOICE_USD`, `SELL_BREAKDOWN_USD`, `SELL_PLAN_USD`, `SELL_REVISION_USD`), listed for customers on the Billing
  page. Each charge is taken when the work runs and refunded in full (to the never-expiring balance) if it fails, so
  retries and duplicate clicks never cost the customer. Unaffordable actions are refused up front with a 402. Compare
  "charged" with "our cost" on each customer's Admin page and tune the prices.
- Creating, rendering, retakes and uploads need an active plan: `active`, `on_trial`, `past_due` (grace while
  Lemon Squeezy retries the card), or `cancelled` until its `ends_at`. When the subscription expires, the rest
  of the plan credit goes too. Top-ups stay.
- **Storage**: every project file is counted per customer against `PLAN_STORAGE_GB` (50). When a customer is
  over it, new work is refused with "You're using 50.3 of 50 GB. Delete old videos to make room." Renders
  already running finish. Deleting a video deletes its files.
- Webhooks are verified (`X-Signature`) and applied once: `payments` rows are keyed `ls:invoice:<id>` and
  `ls:order:<id>`, so Lemon Squeezy's retries never credit twice.
- **Refunds** issued in the Lemon Squeezy dashboard don't take credit back automatically. If you refund a
  top-up, take the credit back by hand: `update credit_accounts set balance_usd = balance_usd - <usd>` plus a
  `credit_events` row with reason `refund_reversed`.

## 4. Railway (the app)

1. New project → **Deploy from GitHub repo** → `khurramidris/backlot`. Railway reads `railway.json` and builds
   the root `Dockerfile`.
2. **Variables**: paste everything from `engine/env.sample` with real values. The required ones are marked.
   Leave `MOCK_PROVIDERS` and `ALLOW_DEV_TOKENS` unset: the engine refuses to start in production with them.
3. **Settings → Networking**: generate a domain, or add your own. Use it for `PUBLIC_BASE_URL`, `APP_URL`
   and `CORS_ORIGINS`.
4. Deploy. `https://<your-domain>/health` should return `{"ok":true,"mock":false}`.

**Scaling the app itself:** one instance handles the API, the job queue and FFmpeg editing. When editing
backs up, add replicas. The queue is safe to share between instances. To separate the API from background
work, run one service with `RUN_WORKER=0` and more with the start command `node dist/worker.js`.

## 5. Launch check (10 minutes)

1. Sign up with email and with Google.
2. Subscribe to Basic with a Lemon Squeezy test card (`4242 4242 4242 4242`). /billing should show the plan as
   active with $20 of monthly credit within a few seconds. Buy the Starter pack: top-up credit shows $10.
   "Manage subscription" should open the customer portal.
3. Create a microdrama from one sentence. It should stop at "Your approval" with script, cast and price.
4. Press "Make my video", wait for "Finished", play and download the MP4.
5. "Fix this shot" on one shot: the balance drops by that shot's price and a new edit appears.
6. Delete a video from the dashboard: storage on /billing goes down.
7. "Forgot password?" on the sign-in page: the email arrives and its link lets you set a new password.
8. Cancel from the customer portal: /billing shows "Cancelled · ends …" and creating still works until then.
9. As an admin (`ADMIN_USER_IDS`), open `/v1/admin/capacity`: RunPod workers and the controller's decision.

## Operations
- **Admin** (`/admin`, users in `ADMIN_USER_IDS`) shows:
  - the last 7 days: paying customers and monthly revenue, accounts, films finished and failed, payments,
    and provider spend by kind
  - recent failures
  - customer search by email or user id
  - each customer's detail: plan, credits, storage, films with charged vs provider cost, payments and the credit
    ledger, plus credit grants and deductions (with a note; top-up bucket; ledger reasons
    `admin_grant` / `admin_deduct`)
- **Setup check** (`/setup`) tests every production setting and service.
- **Error alerts:** set `SENTRY_DSN`. It reports API errors (5xx), jobs that fail on their last attempt, and
  unhandled rejections.
- **Rate limits** are per customer and in memory, per instance:
  - 600 API requests a minute
  - 30 new videos an hour
  - 30 billing calls an hour
  - 200 renders or retakes an hour
  - 300 asset calls an hour
  Over a limit the API answers 429 with `Retry-After`.
- **Fonts:** the Docker image installs DejaVu Sans, which subtitles and slates use. To use a font file that ships with the
  app instead (the desktop app does), set `SUBTITLE_FONT_FILE` and `SUBTITLE_FONTS_DIR`; with the fonts folder set, text
  drawn into pictures uses libass, so FFmpeg builds without the `drawtext` filter still work.

## 6. Before you take real money

- Fill in the legal entity, jurisdiction, address and support email in `web/src/lib/legal.ts`.
- Have a lawyer review `/terms` and `/privacy` (`web/src/routes/terms.tsx`, `privacy.tsx`). They're
  plain-language drafts. In particular, check the retention periods, the list of processors and their data
  locations, the promise not to train on customer content (confirm it with each AI provider's terms), and the
  consumer cancellation and refund rights where you sell.
- Switch the Lemon Squeezy store to live mode, and swap in the live API key, webhook secret and variant ids.
