#!/usr/bin/env python3
"""Download the pinned H3 weights (about 45 GB) and check each file's size and SHA-256 against models.lock.json.

Run it once per network volume. The worker also runs it on its first start when weights are missing
(H3_AUTO_DOWNLOAD=1, the default). By hand, from a RunPod Pod with the volume attached at /workspace:

    python /app/h3/download_models.py --dest /workspace/h3

Files already present with the right size are kept (add --verify to re-check their SHA-256 too, which takes minutes).
"""

import argparse
import hashlib
import json
from pathlib import Path

LOCK = json.loads((Path(__file__).resolve().parent / "models.lock.json").read_text())


def wanted(include_8step: bool = False) -> list[dict]:
    return [f for f in LOCK["files"] if include_8step or f.get("nfe", 4) != 8]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(8 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def download(dest: Path, include_8step: bool = False, verify: bool = False) -> None:
    from huggingface_hub import hf_hub_download

    files = wanted(include_8step)
    print(f"{len(files)} files, {sum(f['size'] for f in files) / 1e9:.1f} GB in total, into {dest}", flush=True)
    for item in files:
        target = dest / item["target"]
        if target.is_file() and target.stat().st_size == item["size"] and (not verify or sha256(target) == item["sha256"]):
            print("ok (already there)", item["target"], flush=True)
            continue
        # The lock keeps the upstream repo layout under the target folder, e.g. loras/<file> or vae/<file>.
        relative = Path(item["path"]).parts
        parts = Path(item["target"]).parts
        if tuple(parts[-len(relative):]) != relative:
            raise RuntimeError(f"invalid target layout in models.lock.json: {item['target']}")
        print(f"downloading {item['repo']}/{item['path']} ({item['size'] / 1e9:.1f} GB)", flush=True)
        path = Path(hf_hub_download(item["repo"], filename=item["path"], revision=item["revision"],
                                    local_dir=dest.joinpath(*parts[:-len(relative)])))
        if path.resolve() != target.resolve():
            raise RuntimeError(f"unexpected download location {path} for {item['target']}")
        if target.stat().st_size != item["size"] or sha256(target) != item["sha256"]:
            target.unlink()
            raise RuntimeError(f"{item['target']} failed its integrity check and was deleted; run again")
        print("ok (downloaded and verified)", item["target"], flush=True)
    print("All H3 weights are in place.", flush=True)


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--dest", required=True, type=Path, help="the folder MODEL_DIR points at, e.g. /runpod-volume/h3")
    p.add_argument("--include-8step", action="store_true", help="also fetch the optional eight-step adapter (+2 GB)")
    p.add_argument("--verify", action="store_true", help="re-check the SHA-256 of files that are already there")
    a = p.parse_args()
    download(a.dest, a.include_8step, a.verify)
