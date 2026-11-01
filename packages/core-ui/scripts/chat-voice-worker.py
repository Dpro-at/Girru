"""Offline speech adapter transferred from the GenVR local MLX worker."""
import json
import os
import sys
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
from huggingface_hub import snapshot_download
import mlx.core as mx
import numpy as np
import soundfile as sf
from mlx_audio.tts.utils import load_model
request = json.loads(sys.stdin.readline())
folder = snapshot_download("mlx-community/chatterbox-multilingual-v3", revision="03565773edd72e949572557597af8063bb49a18a", local_files_only=True)
model = load_model(folder)
chunks = []
for result in model.generate(text=request["text"], ref_audio=request["reference"], lang_code=request["language"], exaggeration=0.1, max_tokens=800):
    mx.eval(result.audio)
    chunks.append(np.array(result.audio).reshape(-1))
if not chunks:
    raise RuntimeError("No speech generated")
samples = np.concatenate(chunks)
if len(samples) > model.sample_rate * 60:
    raise RuntimeError("Speech exceeds one minute")
sf.write(request["output"], samples, model.sample_rate, subtype="PCM_16")
