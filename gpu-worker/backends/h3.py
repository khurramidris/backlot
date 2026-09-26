"""MiniMax H3, self-hosted. This is where the model's inference code goes.

What the engine sends (request):
  - content[0] is the text prompt. It names each reference: "reference image 1 is the location, …;
    reference image 2 is Asma's face …", "Asma speaks with the voice in reference audio 1".
  - up to 9 reference images, up to 3 reference videos (the previous shot, for continuity) and up to
    3 reference audio clips (character voices), already downloaded for you in `media`.
  - resolution "768P" or "2K", duration 4–15 seconds, ratio like "9:16" or "16:9".

What to return: the path of an MP4 of exactly `duration` seconds with lip-synced dialogue audio.
Raise Refused(...) when the safety filter rejects the content.

Weights: put them on a RunPod network volume (mounted at /runpod-volume) and point MODEL_DIR at them,
so a new worker doesn't download tens of GB before its first job.
"""

import os

from . import Refused  # noqa: F401  (raise Refused(...) from generate when content is refused)

MODEL_DIR = os.environ.get("MODEL_DIR", "/runpod-volume/h3")
_model = None


def load() -> None:
    global _model
    # TODO(model): load H3 from MODEL_DIR onto the GPU, e.g. _model = H3Pipeline.from_pretrained(MODEL_DIR).to("cuda")
    raise NotImplementedError(f"H3 inference is not wired in yet (weights expected in {MODEL_DIR}). Use MODEL_BACKEND=fake.")


def generate(request: dict, media: list[dict], workdir: str) -> str:
    # TODO(model): run _model with the prompt, references, resolution, duration and ratio;
    # write the result to os.path.join(workdir, "out.mp4") and return that path.
    raise NotImplementedError("H3 inference is not wired in yet.")
