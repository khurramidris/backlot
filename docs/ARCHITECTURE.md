# Architecture

| Folder | What | Stack |
|---|---|---|
| `web/` | The product UI: landing, sign-in, create, approve, watch, fix a shot, credits | React 19, Vite, TanStack Router + Query, Tailwind v4, shadcn/Radix |
| `engine/` | API, durable job queue, AI pipeline, FFmpeg editing, credits, Stripe; serves `web/dist` | Node 22, Hono, Postgres (`postgres.js`), zod |
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
  - `engine/src/billing.ts`: credits reserved per render and settled exactly once (kept for a usable clip,
    refunded otherwise), plus Stripe Checkout and a signed, idempotent webhook.
  - `usage_events`: what providers cost us, for margins.
- **Video providers:** `providers/runpod.ts` (ours) or `providers/minimax.ts` (hosted), same interface,
  chosen by `VIDEO_PROVIDER`.
  - With RunPod, the worker uploads each clip straight to our storage through a signed link.
  - `engine/src/capacity.ts` sets the GPU floor: 0 when idle, warm while active, deeper when busy, never above
    the cap.
- **Auth:** Supabase Auth in the browser. The engine verifies the session token on every `/v1` request. All
  product data lives in the engine's tables; Supabase only knows about users.

## Invariants worth keeping

- Nothing expensive happens before the customer approves a price at the checkpoint.
- A customer is never charged for a clip that failed to render.
- Every script line reaches the screen verbatim (`repairShots`), and every H3 rule is checked before a request
  leaves (`validateH3`).
- Anything that reaches an FFmpeg filter graph is validated first (`parseCutOptions`).
