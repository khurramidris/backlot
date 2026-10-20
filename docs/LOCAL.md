# Run Backlot on your own computer with the real services

Use this to judge the real result (story, screenplay, images, voices, H3 video) before putting anything online.
You are signed in as a fixed dev user, no payments are involved, and nothing is charged. The only costs are what
Anthropic, MiniMax and RunPod bill you directly.

Want to click around for free first? The mock run in the README needs no keys at all.

## What you need

- Node 22, Postgres and FFmpeg (Mac: `brew install node@22 postgresql ffmpeg`; Ubuntu: `apt-get install postgresql ffmpeg fonts-dejavu-core`).
  Docker also works for Postgres: `docker run -d -p 5432:5432 -e POSTGRES_HOST_AUTH_METHOD=trust postgres:16`.
- `cloudflared` for the tunnel in step 3 (Mac: `brew install cloudflared`; other systems: Cloudflare's download page). Free, no account.
- An Anthropic API key (writing and shot planning).
- A MiniMax API key (voices, and images unless you choose Gemini or OpenAI for those).
- Your RunPod API key and the endpoint ID of your H3 worker.

## Steps

1. **Install and create the database**
   ```bash
   npm run setup
   createdb backlot
   ```
2. **Fill in your settings**
   ```bash
   cp engine/env.local.sample engine/.env.local
   ```
   Open `engine/.env.local` and paste your keys. The file is git-ignored, so it never gets committed.
3. **Open a tunnel so RunPod can reach your computer.** RunPod's GPU downloads the reference images from your
   computer and uploads every finished clip back to it, so it needs a public https address. In a second terminal:
   ```bash
   cloudflared tunnel --url http://localhost:8787
   ```
   Copy the `https://….trycloudflare.com` address it prints into `PUBLIC_BASE_URL` in `.env.local`. The address
   changes every time you restart the tunnel.
4. **Build the web app and start the engine**
   ```bash
   npm --prefix web run build
   npm --prefix engine run local
   ```
   Open http://localhost:8787.
5. **Check the setup.** Open a third terminal: `npm --prefix engine run preflight:local`. It checks your keys, that
   RunPod can reach your computer, and that your endpoint has workers. Fix anything marked red.
6. **Make something small.** Type an idea and press enter. For a first look, keep `MAX_RUNTIME_SECONDS=120` and make
   one microdrama of about a minute.

## What it costs (rough)

- Story, screenplay, cast and shot plan on Claude: about $1 to $3 per film at the defaults. `STORY_EFFORT=medium`
  and `SCRIPT_DOCTOR=0` make it cheaper and a little less polished.
- Images and voices: cents.
- Video: your GPU time on RunPod. Set `RUNPOD_GPU_PRICE_PER_SECOND` and the Admin page shows what each film really cost you.

## Judge the writing alone first (no video, no GPU)

```bash
EVAL_CONFIRM=1 npm --prefix engine run eval:story:local -- --only 3
```
This runs sample ideas through the writers' room, breakdown, direction and shot plans, and writes the scripts and
shot prompts to `engine/data/eval/<time>/` so you can read them. About $1 to $2 per idea.

## Your H3 endpoint has to speak our language

The engine sends each shot to RunPod as `{"input": {"request": …, "upload": …}}` and expects
`{"key", "seconds", "width", "height", "has_audio"}` back. The worker that does this is `gpu-worker/handler.py`,
and the model runs in `gpu-worker/backends/h3.py`. To set up that endpoint, follow `docs/SELF-HOSTED-H3.md`. If your endpoint runs a
different handler, send me a sample request and response and I will write an adapter.

## Good to know

- Subtitles use DejaVu Sans. On Mac or Windows set `SUBTITLE_FONT=Arial` (or any font you have) in `.env.local`.
- Everything is saved under `engine/data/files`. Delete that folder and the database to start fresh.
- Credits, the plan gate and the storage quota are off locally. To try billing, see `docs/DEPLOY.md`.
