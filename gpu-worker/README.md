# Backlot GPU worker (RunPod Serverless)

Renders one shot per job. The engine sends the H3 request and a signed upload link. The worker renders the
clip, uploads it straight to our storage and returns its length and size. See `handler.py` for the exact
contract.

| File | What it is |
|---|---|
| `handler.py` | RunPod entry point: download references → `backend.generate()` → ffprobe check → upload |
| `backends/fake.py` | Test-pattern clips at the requested length and shape. Use it to prove the endpoint and scaling before the model is ready |
| `backends/h3.py` | **Where the H3 inference code goes** (`load()` once per worker, `generate()` per job) |
| `selftest.py` | `python selftest.py`: runs the handler locally with the fake backend (needs ffmpeg) |

## Run locally

```bash
python selftest.py
pip install -r requirements.txt
MODEL_BACKEND=fake python handler.py --test_input '{"input": {...}}'   # RunPod SDK local test mode
```

## Deploy on RunPod

1. Build and push the image: `docker build -t <registry>/backlot-gpu-worker:<tag> gpu-worker`.
2. **Network volume**: create one in the same region as the endpoint and copy the H3 weights to `/h3` on it.
   Workers mount it at `/runpod-volume`, so they start without downloading weights.
3. **Serverless endpoint** from the image:
   - GPU: one that fits H3 in memory (pick after profiling; start with 80 GB cards if unsure).
   - Env: `MODEL_BACKEND=h3` (or `fake` for a dry run), `MODEL_DIR=/runpod-volume/h3`.
   - Attach the network volume.
   - Workers: min 0, max = your budget cap (the engine's `RUNPOD_MAX_WORKERS` keeps this in sync).
   - Scaling: **Queue delay**, about 4 s. Idle timeout: 60–120 s. **FlashBoot on.**
   - Execution timeout: 30 min (matches the engine's `RUNPOD_EXECUTION_TIMEOUT_SEC`).
4. Give the engine `VIDEO_PROVIDER=runpod`, `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID`, then
   `RUNPOD_MANAGE_SCALING=1` once you've watched a few decisions in `/v1/admin/capacity`.

## How scaling works

- **Up:** RunPod adds workers when jobs wait longer than the queue-delay setting.
- **Down:** idle workers stop after the idle timeout, down to the endpoint's minimum.
- **The minimum** is set by the engine's warm-pool controller:
  - 0 when nobody has rendered for `RUNPOD_WARM_MINUTES` (no GPU bill while idle)
  - `RUNPOD_WARM_WORKERS` while customers are active (no multi-minute cold starts)
  - more when the queue is deep
- **The ceiling** is always `RUNPOD_MAX_WORKERS`.
