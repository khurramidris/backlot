# RunPod Serverless worker image. Build from this folder:
#   docker build -t <registry>/backlot-gpu-worker:<tag> gpu-worker
# Model weights are NOT baked in: mount a RunPod network volume at /runpod-volume and set MODEL_DIR.
FROM nvidia/cuda:12.4.1-cudnn-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 MODEL_BACKEND=h3 MODEL_DIR=/runpod-volume/h3
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip3 install --no-cache-dir -r requirements.txt
COPY handler.py selftest.py ./
COPY backends ./backends

CMD ["python3", "-u", "handler.py"]
