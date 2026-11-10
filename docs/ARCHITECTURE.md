# Architecture

| Folder | What | Stack |
|---|---|---|
| `web/` | The product UI: landing and pricing, sign-in and password reset, create, approve, watch, fix a shot, quick clips, billing, account, the company dashboard (admin), terms and privacy | React 19, Vite, TanStack Router + Query, Tailwind v4, shadcn/Radix |
| `engine/` | API, durable job queue, AI pipeline, FFmpeg editing, credits, subscriptions (Lemon Squeezy), storage quota; serves `web/dist` | Node 22, Hono, Postgres (`postgres.js`), zod |
| `gpu-worker/` | Renders one shot per job on RunPod Serverless | Python, RunPod SDK, FFmpeg, the H3 model |

## The flow

```
prompt ─▶ writing ─▶ casting ─▶ planning ─▶ READY (customer approves the price) ─▶ rendering ─▶ assembling ─▶ done
 (Claude)   (Claude +     (Claude +                                                (RunPod)      (FFmpeg)       │
            images/voices) H3 rules)                                                 ▲                          │
                                                                                     └────── fix this shot ◀────┘
```

- **The story engine** (`docs/STORY-ENGINE.md` has the whole design). Every step is Claude through the official SDK,
  with structured outputs, adaptive thinking and an explicit effort; prompts in `pipeline/prompts.ts`, answer shapes in
  `pipeline/schemas.ts`, worked writing examples in `pipeline/craft.ts`, budgets and checks in `pipeline/story.ts`.
  Each call does one small job and code does the bookkeeping, so a cheaper model still writes well:
  1. **Pitch and choose** (`writer.ts`): three different takes on the idea; a head of development scores them on a
     rubric and picks one, with development notes. Freshness: optional sparks, the customer's earlier stories, and a
     list of overused AI names, premises and images.
  2. **Bible**: characters (want, obstacle, secret, arc, a voice with a verbal habit and sample lines, look),
     relationships, world, sets, setups and payoffs, each episode's opening and ending, the film's look. Overused
     names are recast once, here.
  3. **Outline**: each episode boarded into scene cards (set, who, what each wants and how, what's underneath, the
     turn, the exit). Code works out the scene count, the seconds and a timed beat grid for the format.
  4. **Scenes**: written in parallel, one per card, to a word budget from code and with two worked examples each.
     Scenes come back as elements and code renders the Fountain. Each episode's opening and ending get two drafts and
     a judge.
  5. **Polish**: `storyLint` (runtime, cast and set counts, stock and on-the-nose lines, unfilmable or
     camera-directing action, legible text, a slow opening, an ending on talk, the customer's names and places), then
     a script editor's located notes. Only flagged scenes are rewritten, and a rewrite is kept only if the checks
     don't get worse and a pairwise judge prefers it. The report is saved in `story_bible.quality`, the cards in
     `story_bible.outline`.
  6. **Breakdown** (`breakdown.ts`): casting, costume and production design. It aims for real, distinct faces
     cast for contrast, signature colours, sets that tell a story, and one palette and texture for the film.
     Image prompts (`assets.ts`) put the essentials first, within the image model's 1500 characters.
  7. **Direction** (`shots.ts`): one plan per episode (visual approach, motifs), with each scene's purpose,
     temperature, pace, key image, camera, light, blocking, and opening and closing images, made from the writers'
     cards. It's saved on the episode.
  8. **Shots:** scenes are planned in parallel from the director's plan and the scene's card (what each character
     wants, what's underneath, where it turns), following the WanPE lesson: each beat is a cinematic brief (framing,
     lens, camera trajectory, blocking, performance, light, verbatim dialogue).
     - A timing-safe coverage made in code is the starting point; two matching reference sequences from
       `exemplars.ts` teach film grammar, rotated per scene.
     - Code guarantees every dialogue line and every action line is covered, fits the beats to H3, and flags
       monotonous camera work.
  - Each writing step is its own autopilot run (state in `projects.autopilot.writing`), so a restart resumes and
    no job runs long.
  - Any step can run on its own model (`CLAUDE_MODELS`). Without structured outputs the answer's shape is described
    in the prompt and gets one repair round; a feature an endpoint rejects is switched off for that model.
  - `npm --prefix engine run eval:story` runs sample ideas through the whole engine and writes a report plus every
    take, card, script and plan (mock mode is free; a real run needs `EVAL_CONFIRM=1`). `PROMPT_LOG_DIR` saves every
    prompt as sent.
- **Quick clips** (`pipeline/clips.ts`, `POST /v1/clips`): one clip of 5 to 15 seconds, no story engine. A clip is a
  project with `mode = 'clip'`, one episode and one shot, so it reuses the render path (hold, settle once, refund on
  failure) and the project page. Four modes:
  - text to video
  - image to video: the picture is the first frame (`first_frame` role; MiniMax's `first_frame_image`, or
    `MiniMaxH3AddGuide` on our worker)
  - characters & products: up to 4 pictures and a voice as references
  - remix: a video to change ("replace the man with the woman in picture 1")
  Uploads are re-encoded by FFmpeg first (pictures to JPEG, video to 24 fps H.264 of at most 15 s, voice to 14 s
  MP3) and stored under `projects/<id>/inputs/`. The customer's "image 2" or "the voice" becomes the wording H3
  requests use (`normalizeRefs`). Another version is a new take of the same shot, optionally with a new prompt or
  length.
- **Content checks** (`moderation.ts`): our own H3 has no filter, so whatever reaches a video model without Claude
  rewriting it is checked first by Claude's fast model: clip prompts and uploads, uploaded character and set pictures,
  and hand-edited shot prompts. Verdicts are cached by content hash (`moderations`); a refusal is a 422
  `sensitive_content` and never charged.
- **Autopilot** (`engine/src/pipeline/autopilot.ts`) moves a project through the stages. It's a queue job that
  reschedules itself, so it survives restarts and costs nothing while waiting.
- **Every step is a job** in Postgres (`engine/src/queue.ts`, `FOR UPDATE SKIP LOCKED`). Any number of
  engine instances can share the queue. A worker renews the lease on its running jobs every 30 seconds. A job whose
  worker died (a deploy, a crash) goes back in the queue after 3 minutes, or fails, running its refund hook, once
  it has used every attempt. On SIGTERM a process takes no new jobs, gives running ones 20 seconds to finish, then
  hands the rest straight back to the queue with their attempt returned.
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
    the cap. It counts only clips that can run now, so a film's clips waiting their turn keep no GPU warm.
- **Rendering** (`pipeline/render.ts`): a project's clips render in story order, up to 4 at a time per
  customer across all their videos (`MAX_ACTIVE_RENDERS_PER_USER`, `RENDERS_PER_PROJECT`), and the next starts as soon
  as one finishes. A slot is claimed under a Postgres advisory lock, so the limit holds with many workers. The customer plays each finished clip on
  the project page while the rest are filmed. The previous clip is not sent along as a reference video
  (`CHAIN_CLIPS`, off): its seconds would be billed as input on every render.
- **Editing** (`pipeline/assemble.ts`): the clips are joined whole, in order, at one size, frame rate and audio
  format, with the episode's loudness at streaming level. Nothing is trimmed, and captions and music are the
  creator's to add; burned-in subtitles, fades and a music bed remain options of a cut.
- **Auth:** Supabase Auth in the browser. The engine verifies the session token on every `/v1` request. All
  product data lives in the engine's tables; Supabase only knows about users.

- **Operations:** `engine/src/admin.ts` (the admin console API), `engine/src/business.ts` (the company dashboard:
  revenue, costs and profit, customers, what was made, health and problems for a date range),
  `engine/src/preflight.ts` (Setup check),
  `engine/src/ratelimit.ts` (per-customer limits) and `engine/src/monitoring.ts` (Sentry, optional).

## Invariants worth keeping

- Nothing expensive happens before the customer approves a price at the checkpoint.
- A customer is never charged for a clip that failed to render.
- Every billable action goes through `paid()` (`billing.ts`): charge, run, refund on failure, so nothing a customer
  pays for can fail silently. The automatic first pass of a vibe project is marked `covered` (the setup fee pays for
  it), so it is never charged twice.
- Payment webhooks credit at most once (`payments` primary key), and credited amounts come from our config,
  never from the amount paid.
- Without `ENFORCE_CREDITS` (local development, the mock e2e suites) there's no plan gate and no storage limit.
- Every script line reaches the screen verbatim, and every action line gets a shot (`repairShots`). Every H3 rule is
  checked before a request leaves (`validateH3`).
- Structured outputs make the answer's shape reliable; code still repairs its content (the API doesn't enforce enums
  or numbers). Without them the shape goes in the prompt and an unusable answer gets one repair round. Never ask the
  model to write out its reasoning in a field (it can trigger refusals): every answer is a production document the
  next step uses (a take, a card, a scene, an editor's note, a verdict), and thinking stays internal.
- Generated scripts are rendered from scene elements by code (`sceneFountain`), so they always parse the same way.
- Anything that reaches an FFmpeg filter graph is validated first (`parseCutOptions`).
- Customer uploads are only ever opened by FFmpeg as local files (its file protocol won't follow a disguised playlist
  to the network) and never reach a shell. Quick-clip inputs and voices are re-encoded into fresh JPEG, MP4 and MP3
  files before a model sees them.
- What a customer writes or uploads for a video passes the content check before it reaches a video model, unless
  Claude rewrote it first.
