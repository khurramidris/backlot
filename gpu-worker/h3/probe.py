#!/usr/bin/env python3
"""GPU check before the worker starts ComfyUI: the pinned Torch/CUDA build, enough VRAM, and one real call to the
Sol sparse-attention kernel the VSA gates need. Prints one JSON line; exits non-zero with the reason on failure.
It is not a model, quality or memory-fit test."""

import json
import os
import sys
from pathlib import Path


def fail(reason: str) -> None:
    print(f"H3 GPU check failed: {reason}", file=sys.stderr, flush=True)
    sys.exit(1)


def host_ram_gib() -> float:
    total = int(next(line.split()[1] for line in Path("/proc/meminfo").read_text().splitlines()
                     if line.startswith("MemTotal:"))) * 1024
    # The container's cgroup limit matters more than the machine's RAM.
    for path in (Path("/sys/fs/cgroup/memory.max"), Path("/sys/fs/cgroup/memory/memory.limit_in_bytes")):
        if path.exists() and path.read_text().strip().isdigit():
            total = min(total, int(path.read_text().strip()))
    return total / 2**30


def main() -> None:
    import torch

    if torch.__version__.split("+")[0] != "2.11.0" or torch.version.cuda != "13.0":
        fail(f"expected the pinned PyTorch 2.11.0 / CUDA 13.0 build, found {torch.__version__} / {torch.version.cuda}")
    if not torch.cuda.is_available():
        fail("CUDA is unavailable. The host's NVIDIA driver is probably older than CUDA 13.0: in the endpoint's "
             "settings, allow only CUDA 13.0 (or newer) machines.")
    props = torch.cuda.get_device_properties(0)
    vram = props.total_memory / 2**30
    min_vram = float(os.environ.get("H3_MIN_VRAM_GB", "24"))
    if vram < min_vram - 1:
        fail(f"{props.name} has {vram:.0f} GB of memory; this recipe needs about {min_vram:.0f} GB (pick the 32 GB tier)")

    report = {"gpu": props.name, "vram_gb": round(vram, 1), "compute_capability": list(torch.cuda.get_device_capability(0)),
              "host_ram_gb": round(host_ram_gib(), 1), "torch": torch.__version__, "cuda": torch.version.cuda}

    if os.environ.get("H3_ATTENTION", "vsa").lower() == "vsa":
        import comfy_kitchen as ck
        backend = ck.list_backends().get("cuda", {})
        if not backend.get("available") or backend.get("disabled") or "sol_attn" not in backend.get("capabilities", []):
            fail("comfy-kitchen has no working CUDA sol_attn backend on this GPU; set H3_ATTENTION=dense to run without sparse attention")
        with torch.inference_mode():
            q, k, v, gate = [torch.randn((1, 192, 56, 128), device="cuda", dtype=torch.bfloat16) for _ in range(4)]
            lengths = torch.tensor([64, 64, 64], device="cuda", dtype=torch.int32)
            with ck.use_backend("cuda"):
                out = ck.sol_attn(q, k, v, scale=128 ** -.5, sink_blocks=[0, 1], sink_q=[0, 1], topk_ratio=.25,
                                  tail=False, block_len=lengths, coarse_gate=gate)
            torch.cuda.synchronize()
            if out.shape != q.shape or not torch.isfinite(out).all():
                fail("the sol_attn kernel returned an invalid result")
        report["sol_attn"] = "ok"

    # The test kit asked for about 96 GB of host RAM because ComfyUI parks idle models in RAM. Serverless hosts may have
    # less: say so in the log, but let the first render show whether it fits.
    if report["host_ram_gb"] < 88:
        print(f"Warning: {report['host_ram_gb']} GB host RAM, below the ~96 GB the test kit asked for. "
              "If renders crash or stall while loading models, choose a GPU type with more RAM.", file=sys.stderr, flush=True)
    print(json.dumps(report), flush=True)


if __name__ == "__main__":
    main()
