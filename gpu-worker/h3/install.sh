#!/usr/bin/env bash
# Image build step for the H3 worker: pinned ComfyUI plus the Kablex Ref2VA-VSA node, hardened by harden_kablex.py.
# Runs inside the pinned PyTorch 2.11.0 / CUDA 13.0 image (see ../Dockerfile). Model weights are NOT installed here:
# they live on the RunPod network volume (download_models.py).
set -euo pipefail
here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
comfy="${COMFY_DIR:-/opt/ComfyUI}"
pin() { python -c 'import json, sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$here/models.lock.json" "$1"; }
checkout() {
  git init -q "$2"
  git -C "$2" remote add origin "$1"
  git -C "$2" fetch -q --depth 1 origin "$3"
  git -C "$2" checkout -q --detach FETCH_HEAD
}

# Keep the image's Torch build: the Sol attention backend needs exactly this one. Everything else installs around it.
python - <<'PY'
import torch
assert torch.__version__.split('+')[0] == '2.11.0' and torch.version.cuda == '13.0', (torch.__version__, torch.version.cuda)
PY
python -c 'import torchvision, torchaudio' 2>/dev/null \
  || pip install --no-cache-dir torchvision==0.26.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu130
python -c 'import torch, torchvision, torchaudio
for m in (torch, torchvision, torchaudio): print(f"{m.__name__}=={m.__version__}")' > /opt/constraints.txt
cat /opt/constraints.txt

checkout https://github.com/Comfy-Org/ComfyUI.git "$comfy" "$(pin comfy_commit)"
pip install --no-cache-dir -c /opt/constraints.txt -r "$comfy/requirements.txt" 'huggingface_hub>=0.34,<2'
pip check || echo "pip check reported the conflicts above; the import check below decides"

checkout https://github.com/Kablex/ComfyUI-Ref2VA-VSA.git "$comfy/custom_nodes/ComfyUI-Ref2VA-VSA" "$(pin kablex_commit)"
python "$here/harden_kablex.py" "$comfy/custom_nodes/ComfyUI-Ref2VA-VSA/nodes.py"

# Everything imports, and ComfyUI loads the H3 and Kablex nodes (CPU only: the build machine has no GPU).
python -c "import comfy_kitchen, av, transformers, huggingface_hub; from importlib.metadata import version; print('comfy-kitchen', version('comfy-kitchen'))"
log="$(cd "$comfy" && python main.py --cpu --quick-test-for-ci 2>&1)" || { echo "$log"; exit 1; }
echo "$log" | tail -n 20
if echo "$log" | grep -q "IMPORT FAILED"; then echo "A ComfyUI node failed to import" >&2; exit 1; fi
python -c 'import torch; assert torch.__version__.split("+")[0] == "2.11.0", torch.__version__'
