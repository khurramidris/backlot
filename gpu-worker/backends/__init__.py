"""Model backends. Each module exposes:

    load() -> None
        Called once when a worker starts (load weights here, so every job after the first is fast).

    generate(request: dict, media: list[dict], workdir: str) -> str
        Render one clip and return the path of an MP4 with an audio track.
        request: the H3 request built by the engine (see engine/src/providers/minimax.ts, H3Request):
            model, content[] (one text prompt + reference images/videos/audio), resolution, duration, ratio
        media:   the references, already downloaded: [{"type": "image_url" | "video_url" | "audio_url",
                                                      "role": "reference_image" | ..., "path": "/tmp/..."}]
                 in the same order as request["content"], text items excluded.
        Raise Refused(reason) if the model or a safety filter refuses the content.

Pick one with MODEL_BACKEND (default "fake").
"""


class Refused(Exception):
    """The content was refused; the engine shows the shot as blocked instead of retrying it."""
