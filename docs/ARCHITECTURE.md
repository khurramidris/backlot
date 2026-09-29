# Architecture

| Folder | What | Stack |
|---|---|---|
| `web/` | The product UI: landing and pricing, sign-in and password reset, create, approve, watch, fix a shot, billing, account, terms and privacy | React 19, Vite, TanStack Router + Query, Tailwind v4, shadcn/Radix |
| `engine/` | API, durable job queue, AI pipeline, FFmpeg editing, credits, subscriptions (Lemon Squeezy), storage quota; serves `web/dist` | Node 22, Hono, Postgres (`postgres.js`), zod |
| `gpu-worker/` | Renders one shot per job on RunPod Serverless | Python, RunPod SDK, FFmpeg, the H3 model |

## The flow

```
prompt ─▶ writing ─▶ casting ─▶ planning ─▶ READY (customer approves the price) ─▶ rendering ─▶ assembling ─▶ done
 (Claude)   (Claude +     (Claude +                                                (RunPod)      (FFmpeg)       │
            images/voices) H3 rules)                                                 ▲                          │
                                                                                     └────── fix this shot ◀────┘
```

- **Autopilot** (`engine/src/pipeline/autopilot.ts`) moves a project through the stages. It's a queue job that
  reschedules itself, so it survives restarts and costs nothing while waiting.
- **Every step is a job** in Postgres (`engine/src/queue.ts`, `FOR UPDATE SKIP LOCKED`). Any number of
  engine instances can share the queue.
- **Money:**
  - `engine/src/billing.ts`: two credit buckets on `credit_accounts`. `plan_usd` is the monthly plan credit,
    reset at each paid invoice. `balance_usd` holds top-ups and refunds, which never expire. Plan credit is
    spent first, in one atomic statement. Credits are reserved per render and settled exactly once: kept for a
    usable clip, refunded otherwise. This file also holds the subscription gate (`requirePlan`: an active plan
    and room in storage, with credits enforced).
  - `engine/src/lemonsqueezy.ts`: checkouts for the Basic plan and top-up packs, the customer portal link, and a
    signed, idempotent webhook that keeps `subscriptions` current and credits invoices and orders.
  - `files`: every stored object under `projects/<id>/`, with its size. It's recorded where files are written
    (`storage.put`, `putFile`, and `pollTake` for clips the GPU worker uploads directly). Usage is one sum per
    customer. Deleting a project deletes its objects.
  - `usage_events`: what providers cost us, for margins.
- **Video providers:** `providers/runpod.ts` (ours) or `providers/minimax.ts` (hosted), same interface,
  chosen by `VIDEO_PROVIDER`.
  - With RunPod, the worker uploads each clip straight to our storage through a signed link.
  - `engine/src/capacity.ts` sets the GPU floor: 0 when idle, warm while active, deeper when busy, never above
    the cap.
- **Auth:** Supabase Auth in the browser. The engine verifies the session token on every `/v1` request. All
  product data lives in the engine's tables; Supabase only knows about users.

- **Operations:** `engine/src/admin.ts` (the admin console API), `engine/src/preflight.ts` (Setup check),
  `engine/src/ratelimit.ts` (per-customer limits) and `engine/src/monitoring.ts` (Sentry, optional).

## Invariants worth keeping

- Nothing expensive happens before the customer approves a price at the checkpoint.
- A customer is never charged for a clip that failed to render.
- Payment webhooks credit at most once (`payments` primary key), and credited amounts come from our config,
  never from the amount paid.
- Without `ENFORCE_CREDITS` (local development, the mock e2e suites) there's no plan gate and no storage limit.
- Every script line reaches the screen verbatim (`repairShots`), and every H3 rule is checked before a request
  leaves (`validateH3`).
- Anything that reaches an FFmpeg filter graph is validated first (`parseCutOptions`).
