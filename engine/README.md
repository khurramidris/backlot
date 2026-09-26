# Backlot engine

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

## Run, test, deploy

See the repository [README](../README.md) for local development and tests, and
[docs/DEPLOY.md](../docs/DEPLOY.md) for production. Every setting is listed in [env.sample](env.sample).

## Costs, at MiniMax list prices (check before launch)

| | 768P | 2K |
|---|---|---|
| per second of video | $0.08 | $0.13 |
| 1 finished minute, no retakes | $4.80 | $7.80 |
| 1 finished minute, typical retakes (×1.8) | ~$8.60 | ~$14.00 |

- A reference video (continuity chaining) is billed for its input seconds too.
- Images cost about $0.0035 each. Voice previews are $30 per million characters.
- `GET /v1/projects/:id/estimate` gives the numbers for a real project.
- Set `ENFORCE_CREDITS=1` (on by default in production) to require an active Basic plan, enough credit and room in storage.

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
| `src/providers/*` | Claude, MiniMax (H3, image-01, voice design), RunPod (our H3), Gemini, OpenAI, mocks |
| `src/pipeline/writer.ts` + `autopilot.ts` | prompt → script, and the stage machine that runs a project to a finished film |
| `src/billing.ts` | credit buckets, render holds, plan gate, storage quota |
| `src/lemonsqueezy.ts` | checkouts, customer portal, payment webhooks |
| `src/capacity.ts` | RunPod warm-pool controller |
| `src/server.ts` | REST API, the web app, `public/console.html` review console |
