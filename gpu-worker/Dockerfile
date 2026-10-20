# RunPod Serverless worker image with the self-hosted H3 stack (ComfyUI + Kablex Ref2VA-VSA). Build from this folder:
#   docker build -t <registry>/backlot-gpu-worker:<tag> gpu-worker
# (GitHub builds and publishes it for you: .github/workflows/gpu-image.yml.)
# Model weights are NOT baked in: they live on a RunPod network volume mounted at /runpod-volume (MODEL_DIR).
# The base is pytorch/pytorch:2.11.0-cuda13.0-cudnn9-devel, pinned by digest: the Sol attention kernel needs this
# exact Torch/CUDA build, and the host's driver must support CUDA 13.0.
FROM pytorch/pytorch@sha256:6e8a7a6dedf900096f90190f66f988e7e658cda4f1e6cbc7c17e3a38980a4f89

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MODEL_BACKEND=h3 MODEL_DIR=/runpod-volume/h3 COMFY_DIR=/opt/ComfyUI
RUN apt-get update && apt-get install -y --no-install-recommends git ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY h3 ./h3
RUN bash h3/install.sh
COPY requirements.txt .
RUN pip install --no-cache-dir -c /opt/constraints.txt -r requirements.txt
COPY handler.py selftest.py test_h3.py ./
COPY backends ./backends

CMD ["python", "-u", "handler.py"]
