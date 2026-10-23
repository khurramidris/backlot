# Backlot API: the plan

A public, pay-as-you-go API for developers: send a prompt (and pictures, a video or a voice), get back a video with
sound, at Backlot's per-second price. This is the build plan; nothing here is built yet.

## Scope and decisions

| Decision | Choice |
|---|---|
| What v1 makes | **Quick clips only**: text, image (first frame), references (up to 9 pictures and a voice), remix (a video). 5–15 s, 768P, MP4 (H.264 + AAC). Films via the API come later: they're long, multi-step and have an approval step. |
| Who can use it | Anyone with prepaid credit. **No subscription needed** (like fal.ai and Replicate). App users with a plan can use their credit through the API too. |
| Price | The same per second as the app (`SELL_PER_SECOND_768P`). Plan credit is spent first, then top-ups. |
| How long outputs are kept | **7 days** after a video finishes (1 day after a failure), then deleted. API videos don't count against the 10 GB app allowance. |
| Rights and content | The same content check as the app, on every request. Each request with pictures, video or voice must send `rights_confirmed: true`. |
| Launch | Built behind `API_ENABLED` (off). It's switched on after the GPU test, once the price is set. |

## How it fits

```
developer ──Bearer bk_live_…──▶ /api/v1 (new Hono app in the engine)
                                  │ key auth · limits · idempotency · request log
                                  ▼
                     safe media fetch (URLs / data URIs) ──▶ createClip()  ← the app's own clip pipeline
                                                               │ checks, content check, hold, render, refund
                                                               ▼
                                         take finishes ──▶ refreshClip() ──▶ webhook job + expiry date
```

The API is a thin, stable layer over code the app already runs every day. A video is a clip project with
`origin = 'api'`, so holds, settlement, refunds, cancel-on-delete, the RunPod path and the dashboard's cost ledger work
unchanged.

`/api/v1` is separate from `/v1`, the web app's private API. `/api/v1` is a frozen, documented contract (additive
changes only), while `/v1` can keep changing with the UI.

## The contract

### Authentication
`Authorization: Bearer bk_live_<32 base62 chars>`. Keys are created on the new **Developers** page. The full key is
shown once; we store only its SHA-256 and a display prefix (`bk_live_AbC1…`). Each account can have up to 10 active
keys, each optionally with a monthly spend limit.

### Endpoints

| Method and path | What it does |
|---|---|
| `POST /api/v1/videos` | Make a video. Returns `201` with the video object once inputs are checked and the render is queued (usually under 10 s). |
| `GET /api/v1/videos/{id}` | Status, cost, output links (signed, valid 24 h; call again for fresh ones until it expires). |
| `GET /api/v1/videos?limit=20&starting_after={id}` | List, newest first, cursor pagination. |
| `DELETE /api/v1/videos/{id}` | Cancel if still rendering (the hold is refunded), and delete its files. |
| `GET /api/v1/account` | Balance, limits and how many videos are in progress. |
| `GET /api/v1/pricing` (no key needed) | Price per second, lengths, aspect ratios and limits, so developers can show prices. |
| `GET /api/v1/openapi.json` (no key needed) | The machine-readable spec. |

### Making a video

```json
POST /api/v1/videos
Idempotency-Key: 7f0c…            (optional, recommended)
{
  "prompt": "Maya in image 1 holds up the sneaker in image 2 and says: These changed my mornings.",
  "duration": 5,                       // whole seconds, 5–15
  "aspect_ratio": "9:16",              // 9:16 | 16:9 | 1:1
  "first_frame": { "url": "https://…/start.png" },                      // image to video
  "images": [ { "url": "https://…/maya.png", "label": "Maya" }, { "url": "data:image/png;base64,…" } ],
  "video": { "url": "https://…/source.mp4" },                           // remix
  "audio": { "url": "https://…/maya.mp3", "label": "Maya" },            // a voice
  "rights_confirmed": true,
  "webhook_url": "https://example.com/hooks/backlot",
  "metadata": { "order": "A-1042" }                                      // returned as is, ≤ 1 KB
}
```

The mode is inferred from the inputs:
- nothing: text to video
- `first_frame`: image to video
- `images` and/or `audio`: references
- `video`: remix

Invalid combinations get a clear `400`, using the same rules as the app (`checkClipForm`). Prompts may say
`image 2`, `video 1` or `voice 1`, or use the model's own tags `<Picture 2>`, `<Video 1>` or `<Audio 1>`; both become
the wording the model needs.

### The video object

```json
{
  "id": "6f1d…", "object": "video", "status": "succeeded",
  "mode": "reference", "prompt": "…", "duration": 5, "aspect_ratio": "9:16", "resolution": "768P",
  "cost_usd": 0.80,
  "output": { "url": "https://…signed…", "thumbnail_url": "https://…", "width": 720, "height": 1280, "duration": 5.04, "has_audio": true },
  "error": null,
  "webhook": { "url": "https://example.com/hooks/backlot", "status": "delivered", "attempts": 1 },
  "metadata": { "order": "A-1042" },
  "created_at": "…", "completed_at": "…", "expires_at": "…"
}
```

**Statuses:**
- `queued`: waiting for a GPU
- `processing`: rendering
- `succeeded`: charged once
- `failed`: refunded
- `refused`: refused by the content check, never charged
- `expired`: files deleted after the retention period

### Errors
All errors share one shape: `{ "error": { "type", "code", "message", "param" } }`. Every response carries an
`X-Request-Id`.

| HTTP | type | When |
|---|---|---|
| 400 | `invalid_request` | bad JSON, wrong combination, file unreadable or too small, `rights_confirmed` missing |
| 401 | `authentication_error` | missing, unknown or revoked key |
| 402 | `insufficient_credit` | the balance can't cover the hold (nothing created) |
| 403 | `permission_error` | API access suspended, or the key's monthly limit reached |
| 404 | `not_found` | not yours, or doesn't exist |
| 409 | `idempotency_error` | the same key is still being processed |
| 422 | `content_refused` / `idempotency_error` | refused by the content check; or the same key was sent with a different body |
| 429 | `rate_limited` | too many requests or videos in progress (`Retry-After` and `X-RateLimit-*` headers) |
| 5xx | `server_error` | our fault; safe to retry with the same `Idempotency-Key` |

### Webhooks
- **Events:** `video.succeeded` and `video.failed` (`refused` arrives as `video.failed` with code `content_refused`).
  The body is the video object.
- **Signing:** `Backlot-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + raw body)>`, Stripe-style. Each
  account has one signing secret, shown and rotated on the Developers page.
- **Retries:** delivered by the durable job queue. A delivery succeeds on a 2xx within 10 s. Otherwise it is retried
  after 1 min, 5 min, 30 min, 2 h, 6 h and 12 h, then marked `failed`. The latest state is visible on the video
  object.

### Idempotency
- The `Idempotency-Key` header (≤ 255 characters) is kept for 24 h per account.
- The same key and the same body replay the first response, with no second charge.
- The same key with a different body gets `422`.
- While the first request is still running, a repeat gets `409`.

### Limits (all settings)
- 300 requests a minute per key, and 30 new videos a minute per account.
- 20 videos queued or rendering per account. GPU slots per account still follow `MAX_ACTIVE_RENDERS_PER_USER`.
- Media: pictures ≤ 20 MB, video ≤ 100 MB (the first 15 s is used), voice ≤ 25 MB. Request body ≤ 40 MB, for data
  URIs.

## Data model: `engine/db/migrations/009_api.sql`

```sql
create table api_keys (
  id uuid primary key default gen_random_uuid(),
  owner_id uuid not null,
  name text not null,
  prefix text not null,                 -- shown in the UI
  hash text not null unique,            -- sha256 of the full key
  monthly_limit_usd numeric,            -- optional spend cap
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index on api_keys (owner_id);

create table api_accounts (             -- one row per developer
  owner_id uuid primary key,
  webhook_secret text not null,         -- whsec_…, rotatable
  suspended_at timestamptz, suspended_reason text,
  created_at timestamptz not null default now()
);

alter table projects
  add column origin text not null default 'app',  -- 'app' | 'api'
  add column api_key_id uuid references api_keys(id),
  add column webhook_url text,
  add column api_metadata jsonb,
  add column expires_at timestamptz;
create index on projects (expires_at) where expires_at is not null;
create index on projects (owner_id, origin, created_at desc);

create table api_idempotency (
  owner_id uuid not null, key text not null,
  request_hash text not null, status int, response jsonb, project_id uuid,
  created_at timestamptz not null default now(),
  primary key (owner_id, key)
);

create table api_requests (             -- the request log: usage pages, abuse checks, support; kept 30 days
  id bigserial primary key, owner_id uuid, key_id uuid,
  method text, path text, status int, error_code text, project_id uuid, ms int,
  created_at timestamptz not null default now()
);
create index on api_requests (owner_id, created_at desc);
create index on api_requests (key_id, created_at desc);

create table webhook_deliveries (
  id bigserial primary key, project_id uuid not null, take_id uuid not null, event text not null,
  url text not null, status text not null default 'pending', attempts int not null default 0,
  last_status int, last_error text, created_at timestamptz not null default now(), delivered_at timestamptz,
  unique (take_id, event)
);
-- and, as in 002/008: enable row level security on every new table (the engine's role bypasses it)
```

## Code layout

New, in `engine/src/api/`:

| File | Contents |
|---|---|
| `keys.ts` | generate (`crypto.randomBytes` → base62), hash, create, list, revoke, monthly spend per key |
| `auth.ts` | `requireApiKey` middleware: parse → hash lookup → not revoked and not suspended → set `uid` and `keyId`. Updates `last_used_at` at most once a minute. Never logs the key. |
| `schemas.ts` | zod request and response schemas. The OpenAPI document is generated from them (`z.toJSONSchema`), so the docs can't drift from what's enforced. |
| `media.ts` | **safe fetch**: https only, no credentials in URLs, DNS resolved with a `lookup` hook that rejects private, loopback, link-local, CGNAT, multicast and reserved IPv4/IPv6 (including IPv4-mapped IPv6 and the metadata address), and pins the checked IP (no DNS-rebinding). Redirects are followed by hand (max 3) and re-checked. 5 s connect and 30 s total timeouts. Size caps enforced while streaming. Also decodes `data:` URIs. Everything then goes through the existing FFmpeg prep, which re-encodes it. |
| `videos.ts` | request → `ClipForm` → `createClip()` with `{ origin: 'api', apiKeyId, webhookUrl, metadata }`; the video object from a clip project and its newest take; list, delete (reuses project delete: refund + cancel + files) |
| `idempotency.ts` | claim the key in a row first (in progress), store the response, replay, 24 h expiry |
| `webhooks.ts` | sign, enqueue on finish (deduplicated per take), `webhook.deliver` job using `again` for the retry schedule, the same safe-fetch rules for the target URL |
| `retention.ts` | `system.cleanup` hourly job: delete expired API projects' files (`storage.delProject`), mark them `expired`, prune old request-log, idempotency and delivery rows |
| `errors.ts` | `PermanentError` codes → the error table above |
| `routes.ts` | the `/api/v1` Hono app: limits, request log, routes, JSON body limit, CORS open (keys are bearer tokens) |

Changed:
- **`server.ts`:**
  - mount `/api/v1` (404 when `API_ENABLED` is off)
  - keep the web catch-all off `/api`
  - session routes for the Developers page: `/v1/api-keys` (list, create, rename or limit, revoke), `/v1/api-account` (webhook secret: reveal or rotate) and `/v1/api-usage?days=30`
- **`pipeline/clips.ts`:**
  - `createClip` takes the API fields and writes them to the project
  - `refreshClip` sets `expires_at` and enqueues the webhook when an API video finishes
  - `normalizeRefs` also maps `<Picture n>`, `<Video n>` and `<Audio n>`
- **`billing.ts`:** `storageUsed` counts `origin = 'app'` projects only; a `requireApiAccess` check (credit, not suspended, key spend limit) replaces `requirePlan` on the API path.
- **`lemonsqueezy.ts`:** top-ups no longer need a plan, so API customers can buy credit. Creating in the app still needs one.
- **`ratelimit.ts`:** add `X-RateLimit-*` headers and per-key buckets.
- **The price guard:** before a video is accepted, the configured video service must cost us less per second than we charge. That's MiniMax's list price, or RunPod's measured cost from the last 7 days. Otherwise the API answers `503 pricing_misconfigured` and `/setup` turns red. The app gets the same guard.
- **Abuse:** 5 refusals by the content check within 24 h suspends the account's API access, shows it under Problems on the dashboard, and reports it to Sentry. You lift it from the customer's admin page.
- **`business.ts`, `admin.ts`:** split usage and spend into app and API, count API accounts, requests, errors and suspensions, and add a suspend/resume button on the customer page.
- **`preflight.ts`:** API checks (switched on? price guard OK? retention job running?).
- **`/v1/projects`:** the app's dashboard lists `origin = 'app'` only, so thousands of API videos don't flood it.

Web (`web/src`):
- **`routes/_authenticated/developers.tsx`:**
  - keys: create (shown once with a copy button), name, monthly limit, last used, revoke
  - the webhook signing secret
  - 30-day usage (requests, videos, spend) and the latest 50 requests with their status
- **Billing:** top-ups are offered without a plan, with copy explaining API credit.
- **`routes/docs.api.tsx` (public):** quick start, authentication, every endpoint, webhooks with signature-check code, errors, limits and pricing. Copy-paste examples in curl, Python and JavaScript, and a link to `openapi.json`.
- **The landing page's pricing section:** an "API" line.

## Tests

Unit (`engine/test/unit.test.ts`):
- key generation, hashing and parsing
- every blocked address range, including IPv6 forms, a redirect to a private address, and an oversized stream
- data URI decoding
- mode inference and combination rules
- `<Picture n>` normalising
- the error mapping
- webhook signatures against a known vector
- the price guard

End to end (`engine/test/api.e2e.ts`, a new CI step with its own database, mock providers, real FFmpeg):
- a key created from the session API
- a text video goes `queued → succeeded`, is charged exactly `duration × price` and downloads as a real MP4
- an image and a reference video sent as data URIs; a URL from a local server (allowed only by a dev-only flag the engine refuses in production, like `MOCK_PROVIDERS`)
- no plan but credit: works. No credit: `402`, nothing created
- the same `Idempotency-Key` twice: one video, one charge; a different body: `422`
- `FORCE_SENSITIVE`: `422`, never charged; five of them: suspended (`403`)
- a revoked key: `401`; another account's video: `404`
- rate limit: `429` with `Retry-After`
- a webhook received and its signature verified; a failing receiver retried and its state shown on the video
- delete while rendering: refunded; expiry: files gone, status `expired`
- the app dashboard doesn't list API videos, and they don't count toward the 10 GB
- `openapi.json` validates, and every documented example passes its schema

## Settings (`engine/env.sample` and `docs/DEPLOY.md`)

```
API_ENABLED=0                       # switch the public API on (after the GPU test and the price are set)
API_RETENTION_DAYS=7                # API videos are deleted this long after they finish
API_REQUESTS_PER_MINUTE=300         # per key
API_CREATES_PER_MINUTE=30           # per account
API_MAX_ACTIVE_PER_ACCOUNT=20       # videos queued or rendering
API_REFUSALS_BEFORE_SUSPEND=5       # content refusals in 24 h before API access is suspended
API_WEBHOOK_TIMEOUT_SEC=10
```

Terms and Privacy get an API section:
- acceptable use, and that the developer answers for the rights to what their users send
- outputs are deleted after 7 days
- request logs are kept for 30 days
- no uptime promise during the beta

## Build order

Each phase ends green (typecheck, unit tests, all e2e suites) and pushed.

| Phase | What | Done when | Estimate |
|---|---|---|---|
| A. Foundation | migration 009, keys (engine and Developers page), `requireApiKey`, error format, request log, `API_ENABLED`, limits and headers, the price guard | a key can be created and revoked and authenticates `GET /api/v1/account` | 1 day |
| B. Videos | safe media fetch, `POST/GET/LIST/DELETE /videos` on `createClip`, idempotency, pricing endpoint, billing changes (no plan, top-ups, storage), retention job | api.e2e creates, charges, downloads, deletes and expires videos | 1.5 days |
| C. Webhooks and abuse | signed durable webhooks with retries, delivery state on the video, refusal strikes and suspension, admin dashboard split and suspend button | the webhook and suspension e2e checks pass | 1 day |
| D. Docs and polish | OpenAPI from the schemas, the public docs page with examples, Terms and Privacy, env and DEPLOY docs, the preflight row | docs examples validated by tests; `/setup` shows the API state | 1 day |

About 4–5 days in total. It's safe to build now: with `API_ENABLED=0` nothing is exposed.

## Later (v2)
- **Test keys** (`bk_test_…`): free, instant sample output, for integrating without paying.
- **`POST /api/v1/files`:** upload once, reuse the file across requests.
- **Films through the API:** an asynchronous project with an approval step done by webhook or auto-approve.
- **Client libraries** (npm and PyPI) generated from the spec.
- **Shared rate limits** in Postgres, once there's more than one engine instance.
- **Priority:** subscribers before API traffic, or a paid fast lane.
- **Auto-recharge** and low-balance emails.
- **Volume pricing.**

## Risks to keep in mind
- **The cheap price depends on the self-hosted GPU.** The price guard stops the API from selling below cost on
  MiniMax by mistake.
- **Bursty traffic.** Developers send bursts. `RUNPOD_MAX_WORKERS` caps spend, and requests over the limit get a
  clear `429` instead of silent waits.
- **Synchronous create.** `POST /videos` fetches and checks inputs while the developer waits, which holds memory for
  large videos. If that becomes a problem, move the fetch into a job, with the same contract (the video starts as
  `queued`).
- **Text-only video on Kablex.** It runs, but its quality is unmeasured until the GPU test. If it's weak, text
  requests can first make a starting picture.
