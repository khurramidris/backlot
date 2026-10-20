"""MiniMax H3, self-hosted: the Ref2VA-VSA recipe from the RunPod test kit, run through a private ComfyUI.

The stack, pinned in h3/models.lock.json: H3 Ref2VA pruned INT8 + the LightX2V four-step adapter + FastH3 VSA gates at
75% video sparsity (Kablex/ComfyUI-Ref2VA-VSA, hardened by h3/harden_kablex.py) + comfy-kitchen's CUDA Sol attention.

load() makes sure the weights are on the network volume (downloading them on the very first start), checks the GPU
and the attention kernel, then starts ComfyUI on 127.0.0.1. It keeps the models warm between jobs.
generate() turns the engine's request into a ComfyUI graph, runs it and returns the MP4 (24 fps, native audio).

The engine writes prompts for MiniMax's hosted API ("reference image 2 is Asma", `says: "…"`). The open weights expect
H3's own tags, so to_h3_prompt() rewrites them: <Picture 2>, <Audio 1>, <Video 1> and <d>[English]…</d> for dialogue.

Endpoint settings (environment variables):
  MODEL_DIR           where the weights are (default /runpod-volume/h3, i.e. the network volume)
  H3_AUTO_DOWNLOAD    1 (default): download missing weights on start. 0: fail instead
  H3_ATTENTION        vsa (default) | dense: the same adapter without sparse attention (slower; for comparisons)
  H3_SPARSITY         0.75 (default): share of video attention tiles skipped
  H3_REF_IMAGE_SIZE   match (default) | max: 2048 px references, better likeness, several times slower
  H3_REFERENCE_VIDEO  0 (default): ignore the previous-shot clip. 1: pass it for continuity (much slower: references
                      are never sparse, and a clip adds about as many tokens as the shot being rendered)
  H3_TIMEOUT_SEC      1700 (default): give up on one render after this long (the engine allows RunPod 1800)
  COMFY_ARGS          extra ComfyUI flags, e.g. "--reserve-vram 1"
"""

import json
import math
import os
import re
import secrets
import shlex
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent / "h3"
LOCK = json.loads((KIT / "models.lock.json").read_text())
MODEL_DIR = Path(os.environ.get("MODEL_DIR", "/runpod-volume/h3"))
COMFY_DIR = Path(os.environ.get("COMFY_DIR", "/opt/ComfyUI"))
WORK = Path(os.environ.get("COMFY_WORK_DIR", "/tmp/comfy"))  # the private ComfyUI's input, output and temp folders
PORT = int(os.environ.get("COMFY_PORT", "8188"))
BASE = f"http://127.0.0.1:{PORT}"
POLL_SECONDS = 2.0


def _weight(match) -> dict:
    return next(f for f in LOCK["files"] if match(f))


UNET = _weight(lambda f: f["target"].startswith("diffusion_models/"))
TEXT_ENCODER = _weight(lambda f: f["target"].startswith("text_encoders/"))
VIDEO_VAE = _weight(lambda f: "video_vae" in f["target"])
AUDIO_VAE = _weight(lambda f: "audio_vae" in f["target"])
TURBO_4STEP = _weight(lambda f: f.get("nfe") == 4)
VSA_GATE = _weight(lambda f: f.get("role") == "vsa_gate")
REQUIRED = [UNET, TEXT_ENCODER, VIDEO_VAE, AUDIO_VAE, TURBO_4STEP, VSA_GATE]


def name(f: dict) -> str:
    return Path(f["target"]).name


# ── Request → H3 inputs ──

def canvas(ratio: str | None, resolution: str | None) -> tuple[int, int]:
    """Width and height for a ratio like "9:16": H3's 768 short edge (480 for 480P), area capped at 768×1344, multiples
    of 32 (the same rule as ComfyUI's adapt_canvas). 2K isn't available in this recipe and renders at 768."""
    short = 480 if resolution == "480P" else 768
    cap = short * short * 1344 / 768
    try:
        w, h = (float(x) for x in str(ratio).split(":"))
        r = w / h
    except (ValueError, ZeroDivisionError):
        r = 16 / 9  # "adaptive" or missing
    nw, nh = (short * r, short) if r >= 1 else (short, short / r)
    if nw * nh > cap:
        s = math.sqrt(cap / (nw * nh))
        nw, nh = nw * s, nh * s
    return max(32, round(nw / 32) * 32), max(32, round(nh / 32) * 32)


def frame_count(seconds) -> int:
    """24 fps on H3's 17k+5 frame grid, within its trained range of 124–362 frames (5.2–15.1 s)."""
    n = max(124, min(362, round(float(seconds) * 24)))
    while n % 17 != 5:
        n += 1
    return n


_REF = re.compile(r"\breference (image|video|audio) (\d+)\b", re.I)
_TAG = {"image": "Picture", "video": "Video", "audio": "Audio"}


def to_h3_prompt(text: str, has_video: bool) -> str:
    """Rewrite the engine's MiniMax-API wording into H3's prompt tags."""
    if not has_video:  # the previous-shot clip isn't sent: drop the sentence that describes it
        text = re.sub(r"[^.\n]*\breference video \d+\b[^.\n]*\.[ \t]*", "", text, flags=re.I)
    text = _REF.sub(lambda m: f"<{_TAG[m.group(1).lower()]} {m.group(2)}>", text)
    lang = re.search(r"Dialogue spoken on camera in ([^,.\n]+)", text)
    lang = lang.group(1).strip() if lang else "English"
    return re.sub(r'\bsays: "([^"\n]+)"', lambda m: f"says: <d>[{lang}]{m.group(1)}</d>", text)


def build_graph(prompt: str, width: int, height: int, length: int, seed: int, images: list[str], videos: list[str],
                audios: list[str], prefix: str, attention: str = "vsa", sparsity: float = 0.75,
                ref_image_size: str = "match") -> dict:
    """The ComfyUI API graph: the author's workflow (UNET → turbo LoRA → VSA gates → sigma shift, 4 Euler steps) with
    the references as inputs of MiniMaxH3ReferenceToVideo. File names are in ComfyUI's input folder."""
    g: dict = {}

    def add(i: int, cls: str, **inputs):
        g[str(i)] = {"class_type": cls, "inputs": inputs}

    add(1, "UNETLoader", unet_name=name(UNET), weight_dtype="default")
    add(2, "CLIPLoader", clip_name=name(TEXT_ENCODER), type="minimax", device="default")
    add(3, "VAELoader", vae_name=name(VIDEO_VAE))
    add(4, "VAELoader", vae_name=name(AUDIO_VAE))
    add(5, "LoraLoaderModelOnly", model=["1", 0], lora_name=name(TURBO_4STEP), strength_model=1.0)
    model = ["5", 0]
    if attention == "vsa":
        add(6, "Ref2VAVSAGatePatch", model=model, gate_file=name(VSA_GATE), sparsity=sparsity)
        model = ["6", 0]
    add(7, "MiniMaxH3SigmaShift", model=model, shift_video=12.0, shift_audio=3.0)
    refs = {}
    for i, f in enumerate(images):
        add(100 + i, "LoadImage", image=f)
        refs[f"ref_images.ref_image_{i}"] = [str(100 + i), 0]
    for i, f in enumerate(videos):
        add(200 + i, "LoadVideo", file=f)
        add(210 + i, "GetVideoComponents", video=[str(200 + i), 0])
        refs[f"ref_videos.ref_video_{i}"] = [str(210 + i), 0]  # frames only: its soundtrack would renumber <Audio n>
    for i, f in enumerate(audios):
        add(300 + i, "LoadAudio", audio=f)
        refs[f"ref_audios.ref_audio_{i}"] = [str(300 + i), 0]
    add(8, "MiniMaxH3ReferenceToVideo", clip=["2", 0], vae=["3", 0], audio_vae=["4", 0], prompt=prompt,
        width=width, height=height, length=length, ref_image_size=ref_image_size, **refs)
    add(9, "RandomNoise", noise_seed=seed)
    add(10, "KSamplerSelect", sampler_name="euler")
    add(11, "BasicScheduler", model=["7", 0], scheduler="simple", steps=4, denoise=1.0)
    add(12, "BasicGuider", model=["7", 0], conditioning=["8", 0])
    add(13, "SamplerCustomAdvanced", noise=["9", 0], guider=["12", 0], sampler=["10", 0], sigmas=["11", 0],
        latent_image=["8", 1])
    add(14, "VAEDecode", samples=["13", 0], vae=["3", 0])
    add(15, "VAEDecodeAudio", samples=["13", 0], vae=["4", 0])
    add(16, "CreateVideo", images=["14", 0], audio=["15", 0], fps=24.0, bit_depth="auto", color_space="sRGB")
    add(17, "SaveVideo", video=["16", 0], filename_prefix=prefix, format="mp4", **{"format.codec": "h264"})
    return g


def _settings() -> dict:
    s = {
        "attention": os.environ.get("H3_ATTENTION", "vsa").lower(),
        "sparsity": float(os.environ.get("H3_SPARSITY", "0.75")),
        "ref_image_size": os.environ.get("H3_REF_IMAGE_SIZE", "match").lower(),
        "reference_video": os.environ.get("H3_REFERENCE_VIDEO", "0").lower() in ("1", "true", "yes", "on"),
        "timeout": float(os.environ.get("H3_TIMEOUT_SEC", "1700")),
    }
    if s["attention"] not in ("vsa", "dense"):
        raise ValueError("H3_ATTENTION must be vsa or dense")
    if not 0 <= s["sparsity"] < 1:
        raise ValueError("H3_SPARSITY must be at least 0 and below 1")
    if s["ref_image_size"] not in ("match", "max"):
        raise ValueError("H3_REF_IMAGE_SIZE must be match or max")
    return s


def _extension(path: str, kind: str) -> str:
    """ComfyUI's loaders and file lists go by extension, and the worker saves references without one."""
    with open(path, "rb") as f:
        head = f.read(16)
    if head.startswith(b"\x89PNG"):
        return ".png"
    if head.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    if head[:4] == b"RIFF" and head[8:12] == b"WAVE":
        return ".wav"
    if head.startswith(b"ID3") or head[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        return ".mp3"
    if head.startswith(b"fLaC"):
        return ".flac"
    if head.startswith(b"OggS"):
        return ".ogg"
    if head[4:8] == b"ftyp":
        return ".m4a" if kind == "audio_url" else ".mp4"
    if head.startswith(b"\x1a\x45\xdf\xa3"):
        return ".webm"
    return {"image_url": ".png", "video_url": ".mp4", "audio_url": ".mp3"}[kind]


# ── The private ComfyUI ──

_proc: subprocess.Popen | None = None
_local = urllib.request.build_opener(urllib.request.ProxyHandler({}))  # never route localhost through a proxy


def _call(path: str, payload=None, timeout: float = 30):
    req = urllib.request.Request(BASE + path, data=None if payload is None else json.dumps(payload).encode(),
                                 headers={"content-type": "application/json"})
    try:
        with _local.open(req, timeout=timeout) as r:
            body = r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"ComfyUI {path} answered {e.code}: {e.read().decode(errors='replace')[:2000]}") from None
    return json.loads(body) if body else {}


def _missing_weights() -> list[dict]:
    return [f for f in REQUIRED if not ((p := MODEL_DIR / f["target"]).is_file() and p.stat().st_size == f["size"])]


def _ensure_weights() -> None:
    missing = _missing_weights()
    if not missing:
        return
    if MODEL_DIR.is_relative_to("/runpod-volume") and not Path("/runpod-volume").is_dir():
        raise RuntimeError("No network volume is attached to this endpoint. Attach the one that holds (or will hold) "
                           f"the H3 weights; MODEL_DIR is {MODEL_DIR}.")
    if os.environ.get("H3_AUTO_DOWNLOAD", "1") == "0":
        raise RuntimeError(f"{len(missing)} H3 weight files are missing from {MODEL_DIR} ({', '.join(name(f) for f in missing)}). "
                           "Run h3/download_models.py, or set H3_AUTO_DOWNLOAD=1.")
    print(f"First start: downloading {sum(f['size'] for f in missing) / 1e9:.0f} GB of H3 weights into {MODEL_DIR}. "
          "This happens once per network volume.", flush=True)
    subprocess.run([sys.executable, str(KIT / "download_models.py"), "--dest", str(MODEL_DIR)], check=True)


def _probe() -> None:
    subprocess.run([sys.executable, str(KIT / "probe.py")], check=True, timeout=600)


def _clean_env() -> dict:
    """ComfyUI and its custom node get no credentials."""
    secret = re.compile(r"^RUNPOD_|KEY|SECRET|TOKEN|PASSWORD", re.I)
    env = {k: v for k, v in os.environ.items() if not secret.search(k)}
    env["BACKLOT_DEDICATED_VSA_WORKER"] = "1"  # the hardened node refuses to patch a shared process
    return env


def _start_comfy() -> None:
    global _proc
    for d in ("input", "output", "temp"):
        (WORK / d).mkdir(parents=True, exist_ok=True)
    paths = WORK / "extra_model_paths.yaml"
    paths.write_text("backlot:\n"
                     f"  base_path: {MODEL_DIR}\n"
                     "  diffusion_models: diffusion_models\n  text_encoders: text_encoders\n  vae: vae\n  loras: loras\n")
    cmd = [sys.executable, "-u", "main.py", "--listen", "127.0.0.1", "--port", str(PORT),
           "--use-pytorch-cross-attention", "--disable-comfy-compiler", "--disable-metadata",
           "--extra-model-paths-config", str(paths), "--input-directory", str(WORK / "input"),
           "--output-directory", str(WORK / "output"), "--temp-directory", str(WORK / "temp"),
           *shlex.split(os.environ.get("COMFY_ARGS", ""))]
    _proc = subprocess.Popen(cmd, cwd=COMFY_DIR, env=_clean_env())
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        if _proc.poll() is not None:
            raise RuntimeError(f"ComfyUI exited while starting (code {_proc.returncode}); its log is above")
        try:
            _call("/system_stats", timeout=3)
            return
        except (OSError, RuntimeError):
            time.sleep(1)
    raise TimeoutError("ComfyUI did not start within 10 minutes")


def _choices(info: dict, cls: str, key: str):
    spec = info[cls]["input"]["required"][key]
    if isinstance(spec[0], list):
        return spec[0]
    return spec[1].get("options") if len(spec) > 1 and isinstance(spec[1], dict) else None


def _preflight(attention: str) -> None:
    """Every node and weight the graph uses is there, before a customer's render depends on it."""
    info = _call("/object_info", timeout=120)
    graph = build_graph("", 768, 768, 124, 0, ["x.png"], ["x.mp4"], ["x.mp3"], "x", attention)
    missing = sorted({n["class_type"] for n in graph.values()} - set(info))
    if missing:
        raise RuntimeError("ComfyUI is missing nodes: " + ", ".join(missing))
    checks = [("UNETLoader", "unet_name", UNET), ("CLIPLoader", "clip_name", TEXT_ENCODER), ("VAELoader", "vae_name", VIDEO_VAE),
              ("VAELoader", "vae_name", AUDIO_VAE), ("LoraLoaderModelOnly", "lora_name", TURBO_4STEP)]
    if attention == "vsa":
        checks.append(("Ref2VAVSAGatePatch", "gate_file", VSA_GATE))
    for cls, key, f in checks:
        options = _choices(info, cls, key)
        if options is not None and name(f) not in options:
            raise RuntimeError(f"ComfyUI can't see {name(f)} (looked in {MODEL_DIR})")


def load() -> None:
    s = _settings()
    _ensure_weights()
    _probe()
    _start_comfy()
    _preflight(s["attention"])
    print(f"H3 worker ready: attention={s['attention']} sparsity={s['sparsity']} references={s['ref_image_size']} "
          f"reference_video={'on' if s['reference_video'] else 'off'}", flush=True)


def _ensure_running(attention: str) -> None:
    if _proc is None or _proc.poll() is not None:
        print("ComfyUI is not running (it crashed or was never started); starting it", flush=True)
        _start_comfy()
        _preflight(attention)


def _clear_leftovers() -> None:
    """One job per worker: anything still queued belongs to a job RunPod already cancelled or timed out."""
    q = _call("/queue")
    if not (q.get("queue_running") or q.get("queue_pending")):
        return
    print("Stopping work left over from a cancelled job", flush=True)
    _call("/queue", {"clear": True})
    _call("/interrupt", {})
    deadline = time.monotonic() + 120
    while _call("/queue").get("queue_running"):
        if time.monotonic() > deadline:
            raise RuntimeError("ComfyUI is still busy with a cancelled job")
        time.sleep(1)


def _error_of(status: dict) -> str:
    for event, data in status.get("messages", []):
        if event == "execution_error":
            return f"{data.get('node_type')}: {data.get('exception_type', '')} {data.get('exception_message', '')}".strip()
        if event == "execution_interrupted":
            return "interrupted"
    return json.dumps(status)[:1000]


def _run(graph: dict, client_id: str, timeout: float) -> Path:
    r = _call("/prompt", {"prompt": graph, "client_id": client_id})
    if r.get("node_errors"):
        raise RuntimeError("ComfyUI rejected the graph: " + json.dumps(r["node_errors"])[:2000])
    prompt_id = r["prompt_id"]
    started = time.monotonic()
    while True:
        if _proc is not None and _proc.poll() is not None:
            raise RuntimeError("ComfyUI stopped during the render (usually out of GPU or host memory); "
                               "it restarts for the next job")
        if time.monotonic() - started > timeout:
            _call("/interrupt", {})
            raise TimeoutError(f"the render took longer than {timeout:.0f} s and was stopped")
        entry = _call(f"/history/{prompt_id}").get(prompt_id)
        if entry:
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                raise RuntimeError("H3 render failed: " + _error_of(status))
            if status.get("completed"):
                for out in entry.get("outputs", {}).values():
                    for items in out.values():
                        for item in items if isinstance(items, list) else []:
                            if isinstance(item, dict) and str(item.get("filename", "")).endswith(".mp4"):
                                return WORK / "output" / item.get("subfolder", "") / item["filename"]
                raise RuntimeError("the render finished without saving a video")
        time.sleep(POLL_SECONDS)


def generate(request: dict, media: list[dict], workdir: str) -> str:
    s = _settings()
    _ensure_running(s["attention"])
    _clear_leftovers()
    job = uuid.uuid4().hex[:12]
    staged: list[Path] = []
    lists: dict[str, list[str]] = {"image_url": [], "video_url": [], "audio_url": []}
    try:
        for m in media:
            if m["type"] == "video_url" and not s["reference_video"]:
                continue
            file = f"bl-{job}-{len(staged)}{_extension(m['path'], m['type'])}"
            shutil.copyfile(m["path"], WORK / "input" / file)
            staged.append(WORK / "input" / file)
            lists[m["type"]].append(file)
        text = next((c.get("text", "") for c in request.get("content", []) if c.get("type") == "text"), "")
        width, height = canvas(request.get("ratio"), request.get("resolution"))
        length = frame_count(request.get("duration", 5))
        seed = secrets.randbelow(2**63)
        graph = build_graph(to_h3_prompt(text, bool(lists["video_url"])), width, height, length, seed, lists["image_url"],
                            lists["video_url"], lists["audio_url"], f"backlot/{job}", s["attention"], s["sparsity"],
                            s["ref_image_size"])
        started = time.monotonic()
        print(json.dumps({"h3_job": job, "seed": seed, "size": f"{width}x{height}", "frames": length,
                          "images": len(lists["image_url"]), "videos": len(lists["video_url"]),
                          "audios": len(lists["audio_url"])}), flush=True)
        clip = _run(graph, job, s["timeout"])
        out = os.path.join(workdir, "out.mp4")
        shutil.move(clip, out)
        print(json.dumps({"h3_job": job, "seconds": round(time.monotonic() - started, 1)}), flush=True)
        return out
    finally:
        for p in staged:
            p.unlink(missing_ok=True)
        for p in (WORK / "output" / "backlot").glob(f"{job}*"):
            p.unlink(missing_ok=True)
