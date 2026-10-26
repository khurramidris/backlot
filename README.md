# Backlot

**Type a story, get a film.** A customer describes an idea in a sentence. Backlot writes the script, designs
the cast and sets, plans the shots, shows the price, and then renders the shots one by one (watch each as it
lands) and joins them into the finished video: microdramas, short films, web series and YouTube stories.

| | |
|---|---|
| `web/` | Product UI (React + Vite), served by the engine |
| `engine/` | API, job queue, AI pipeline, FFmpeg, credits, subscriptions (Lemon Squeezy), storage quota |
| `gpu-worker/` | The H3 video model on RunPod Serverless |
| `docs/DEPLOY.md` | Supabase, RunPod, Lemon Squeezy and Railway setup, scaling, and the launch check |
| `desktop/`, `docs/DESKTOP.md` | The desktop app: the whole studio in one installable window, with your own keys |
| `docs/LOCAL.md` | Run it on your computer with the real providers |
| `docs/ARCHITECTURE.md` | How it fits together |

## Run it locally (no API keys, nothing billed)

Needs Node 22, Postgres and FFmpeg.

```bash
npm run setup                                   # install engine + web dependencies
createdb backlot                                # any empty Postgres database
MOCK_PROVIDERS=1 ALLOW_DEV_TOKENS=1 DATABASE_URL=postgres://postgres@localhost:5432/backlot npm run dev:engine
npm run dev:web                                 # http://localhost:5173, signed in as a dev user
```
Mock providers write placeholder scripts, images and clips, so the whole flow runs end to end for free.

To judge the real result with your own Anthropic, MiniMax and RunPod keys, see `docs/LOCAL.md`.

## Tests

```bash
npm test                                        # engine unit tests + web tests
cd engine && DATABASE_URL=postgres://postgres@localhost:5432/<empty db> npm run e2e:vibe
                                                # also: npm run e2e, npm run e2e:runpod (each needs an empty db)
cd gpu-worker && python selftest.py
```
CI runs all of it on every push, then builds and smoke-tests the production image.

## Ship

`docker build -t backlot .` gives one image with the web app and the engine. See `docs/DEPLOY.md`.
