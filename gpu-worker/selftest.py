"""Runs the handler with the fake backend against a local HTTP server standing in for our storage:
references are downloaded, a clip is rendered, verified and PUT to the signed URL, and a refusal is
reported the way the engine expects. Needs ffmpeg. Run: python selftest.py"""

import os
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

os.environ["MODEL_BACKEND"] = "fake"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import handler  # noqa: E402

uploads: dict[str, bytes] = {}
tmp = tempfile.mkdtemp()
ref = os.path.join(tmp, "ref.png")
subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=red:s=64x64",
                "-frames:v", "1", ref], check=True)


class Storage(BaseHTTPRequestHandler):
    def do_GET(self):
        with open(ref, "rb") as f:
            body = f.read()
        self.send_response(200)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self):
        uploads[self.path] = self.rfile.read(int(self.headers["content-length"]))
        self.send_response(200)
        self.end_headers()

    def log_message(self, *args):
        pass


server = ThreadingHTTPServer(("127.0.0.1", 0), Storage)
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f"http://127.0.0.1:{server.server_port}"


def job(prompt: str, ratio: str, duration: int) -> dict:
    return {"input": {
        "request": {"model": "MiniMax-H3", "resolution": "768P", "duration": duration, "ratio": ratio, "content": [
            {"type": "text", "text": prompt},
            {"type": "image_url", "image_url": {"url": f"{base}/ref.png"}, "role": "reference_image"},
        ]},
        "upload": {"url": f"{base}/put/take.mp4?sig=x", "key": "projects/p/takes/t.mp4", "content_type": "video/mp4"},
    }}


out = handler.handler(job("A quiet kitchen at night.", "9:16", 5))
assert out["key"] == "projects/p/takes/t.mp4", out
assert abs(out["seconds"] - 5) < 0.5 and out["has_audio"], out
assert out["height"] > out["width"], "vertical clip for 9:16"
assert uploads.get("/put/take.mp4?sig=x", b"")[4:8] == b"ftyp", "a real MP4 was uploaded to the signed URL"
print(f"ok  render: {out}")

refused = handler.handler(job("FORCE_SENSITIVE", "16:9", 4))
assert refused == {"error": refused["error"], "error_code": "sensitive_content"}, refused
print("ok  refusal reported as sensitive_content")
server.shutdown()
print("GPU WORKER SELFTEST PASSED")
