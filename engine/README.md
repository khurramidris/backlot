# Reelwright Studio Engine

The production half of the platform. It takes a finished screenplay (from Reelwright, or any
front end) and turns it into finished, approved, stitched episodes rendered with **MiniMax H3**.

```
screenplay ─▶ breakdown ─▶ locked assets ─▶ shot plan ─▶ H3 renders ─▶ customer review ─▶ final cut
             (Claude)     (image-01,        (Claude +    (queue, poll,   (approve / retake    (FFmpeg: subtitles,
                           voice design)     H3 rules)    verify)          with a note)          loudness, music)
```

## What each stage does

**1. Breakdown**: Claude reads every scene as a production designer and 1st AD would:
- **Characters**: a visual identity lock (face, build, hair, marks), one or more **wardrobe looks**
  covering every scene they appear in, and a **voice brief**.
- **Sets**: every physical place the camera returns to (a character's bedroom, their house,
  the office). Differently written headings for the same place are merged. **Set variants**
  (night, dawn, power cut) are created only when the look really changes.
- **Props**: only story objects (things handed over, read, hidden, shown in close-up, or recurring).
- Everything seen in 2+ scenes or episodes is flagged **recurring** and generated first.
- Code then checks the answer: every scene maps to exactly one set, and every speaking character
  is included. Names that only appear in action lines count as hints, not facts, so a surname on
  a shop sign doesn't put that character in the scene.

**2. Locked assets**: masters first, then everything derived from them:
- character portrait (neutral grey, front-on) → each wardrobe look is generated **from the portrait**
- set plate (empty, wide, no people) → each variant is generated **from the plate**
- prop product shots; character voices via MiniMax **Voice Design** (trimmed to 2–14 s for H3)
- You can regenerate with a note, edit the description, restore an older version, or upload your
  own (a real actor's face or voice needs `consent=true`). Only **approved** assets go to H3.

**3. Shot plan**: Claude directs each scene into H3-sized shots (4–15 s, up to 4 hard cuts inside),
with screen positions, camera, visible performance and diegetic sound. Code then enforces:
- every script line appears exactly once, **verbatim** (invented lines are removed, missing ones added)
- every line gets time to be spoken (words ÷ 2.4 + 0.5 s); anything too long is split
- H3 limits: ≤9 reference images, ≤3 voices, ≤3 videos, no first-frame + reference mixing, ≤7000 chars

**4. Render**: one take = one H3 task.
- A durable Postgres queue, capped at `MINIMAX_MAX_CONCURRENT`, polls every 10 s.
- Each clip is copied into your storage (MiniMax links expire) and checked with ffprobe (length, audio).
- MiniMax refusals (422), balance (402) and rate limits (429) are handled.
- **Continuity**: when the previous shot in the scene is approved, its clip goes along as a reference video.

**5. Review**: approve a take, pick an older take, retake with a director's note (Claude revises
the shot and keeps the dialogue verbatim), or edit the H3 prompt by hand.

**6. Final cut**: allowed only when **every shot is approved**.
- Normalizes all clips, joins them, and writes SRT subtitles from the planned dialogue timing
  (burned in by default, since feeds play muted).
- Optional music bed that ducks under dialogue.
- Loudness at −14 LUFS; exports MP4 + SRT + poster.

## Run it locally (no keys, no spend)

```bash
npm install
# Postgres 14+ running locally, then:
MOCK_PROVIDERS=1 ALLOW_DEV_TOKENS=1 DATABASE_URL=postgres://postgres@localhost:5432/studio npm run dev
# open http://localhost:8787/console and use the token  dev:11111111-2222-3333-4444-555555555555
```
Import `test/fixtures/eleventh-refill.reelwright.json`, or any Reelwright "Project backup" export.

Tests:
```bash
npm test                         # unit tests: timing, dialogue repair, H3 rules, subtitles
DATABASE_URL=… npx tsx test/e2e.ts   # full pipeline through the HTTP API (mock providers)
# Real provider code against fake MiniMax/Anthropic servers that reject anything the docs forbid:
npx tsx test/fake-providers.ts &
MOCK_PROVIDERS=0 ANTHROPIC_API_KEY=test-key ANTHROPIC_BASE_URL=http://localhost:8790 \
  MINIMAX_API_KEY=test-key MINIMAX_BASE_URL=http://localhost:8790 FAKE_URL=http://localhost:8790 \
  DATABASE_URL=… npx tsx test/e2e.ts
```

## Deploy

Deploy it anywhere that runs a Docker container with FFmpeg: **Railway, Render or Fly.io** (the
`Dockerfile` installs FFmpeg). Lovable's own hosting can't run it, because the jobs run for minutes and need FFmpeg.

Full checklist, environment and Stripe setup: **[docs/DEPLOY.md](docs/DEPLOY.md)**. In short:

1. **Database**: give the engine its **own** Postgres (`DATABASE_URL`). Don't share the Lovable app's Supabase
   database: both have `projects`, `episodes`, `scenes` and `shots` tables. Tables are created on first boot.
2. **Storage**: a private S3-compatible bucket → `STORAGE_DRIVER=s3` and `S3_*`.
3. **Sign-in**: `SUPABASE_URL` + `SUPABASE_ANON_KEY` from the app's Supabase project, so the engine can verify sessions.
4. `FILE_SIGNING_SECRET`, `ANTHROPIC_API_KEY`, `MINIMAX_API_KEY`, `PUBLIC_BASE_URL`, `CORS_ORIGINS`, Stripe keys.
5. One container runs both the API and the worker. To scale, run more containers with
   `RUN_WORKER=0` for the API and `npm run worker` for workers; the queue is safe to share.

## Costs, at MiniMax list prices (check before launch)

| | 768P | 2K |
|---|---|---|
| per second of video | $0.08 | $0.13 |
| 1 finished minute, no retakes | $4.80 | $7.80 |
| 1 finished minute, typical retakes (×1.8) | ~$8.60 | ~$14.00 |

- A reference video (continuity chaining) is billed for its input seconds too.
- Images cost about $0.0035 each. Voice previews are $30 per million characters.
- `GET /v1/projects/:id/estimate` gives the numbers for a real project.
- Set `ENFORCE_CREDITS=1` to require prepaid balance (`credit_accounts` table).

**Draft vs final:** the customer approves the exact clip that goes into the episode. Re-rendering an
approved 768P draft at 2K produces a *different* clip, so pick the render resolution per
project (`PATCH /v1/projects/:id {resolution}`) rather than planning to "upscale later".

## Code map

| | |
|---|---|
| `src/pipeline/fountain.ts` | screenplay parsing, speakers, timing |
| `src/pipeline/breakdown.ts` + `prompts.ts` | asset breakdown and its repair rules |
| `src/pipeline/assets.ts` | reference image and voice generation, approve, upload |
| `src/pipeline/shots.ts` | shot planning, dialogue/timing repair, retake revisions |
| `src/pipeline/compiler.ts` | shot plan → H3 prompt + request, H3 rule validation |
| `src/pipeline/render.ts` | submit / poll / download / verify takes |
| `src/pipeline/assemble.ts` | final cut, subtitles, loudness, music |
| `src/providers/*` | Claude, MiniMax (H3, image-01, voice design), Gemini, OpenAI, mocks |
| `src/server.ts` | REST API · `public/console.html` review console |
| `docs/LOVABLE.md` | how the Lovable front end talks to this engine |
