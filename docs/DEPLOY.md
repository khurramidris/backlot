# Deploying Backlot

Everything below is a one-time setup. After it, every push to `main` that passes CI can be deployed as is.

```
                 ┌──────────────── Railway ────────────────┐
 customers ────▶ │  backlot image (Dockerfile)             │ ──▶ Anthropic (scripts, planning)
                 │  web app + API + job worker + FFmpeg    │ ──▶ MiniMax API (reference images, voices)
                 └──────┬───────────────┬──────────────────┘ ──▶ Stripe (payments)
                        │               │ jobs / status / cancel / scaling
                 Supabase:              ▼
                 Auth, Postgres,   RunPod Serverless: gpu-worker image + H3 weights on a network volume
                 Storage (S3)      (autoscaled GPU workers upload clips straight to Supabase Storage)
```

## 1. Supabase (sign-in, database, file storage)

1. Create a project at supabase.com (pick the region closest to your customers and to RunPod).
2. **Auth → Providers**: keep Email on. For Google, create an OAuth client in Google Cloud, paste its id and
   secret, and add `https://<your-domain>/dashboard` to **Auth → URL configuration → Redirect URLs**. Set the
   Site URL to `https://<your-domain>`.
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

## 3. Stripe

1. Create the account and switch to live mode when ready. Copy the secret key → `STRIPE_SECRET_KEY`.
2. **Developers → Webhooks → Add endpoint**: `https://<your-domain>/webhooks/stripe`, with events
   `checkout.session.completed` and `checkout.session.async_payment_succeeded`. Copy the signing secret →
   `STRIPE_WEBHOOK_SECRET`.

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
2. Buy the smallest credit pack with a Stripe test card, then check the balance on /credits.
3. Create a microdrama from one sentence. It should stop at "Your approval" with script, cast and price.
4. Press "Make my video", wait for "Finished", play and download the MP4.
5. "Fix this shot" on one shot: the balance drops by that shot's price and a new edit appears.
6. As an admin (`ADMIN_USER_IDS`), open `/v1/admin/capacity`: RunPod workers and the controller's decision.
