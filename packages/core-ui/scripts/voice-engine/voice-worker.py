"""Local optional MLX voice worker; no voice samples or weights ship with the SDK."""
import json
import sys
from pathlib import Path

MODELS = {
    "voice-design-4bit": ("mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-4bit", "5c390979e4b93af5f2932f90742ca99c7dd04687"),
    "chatterbox-multilingual-v3": ("mlx-community/chatterbox-multilingual-v3", "03565773edd72e949572557597af8063bb49a18a"),
}
S3_MODEL = ("mlx-community/S3TokenizerV2", "e0c9886f0e1c35ae85b1f27277416fb19fc72bec")  # Public model commit, not a credential. gitleaks:allow

def main():
    request = json.loads(sys.stdin.readline())
    repo, revision = MODELS[request["model"]]
    if request["action"] == "demo":
        import io
        from urllib.request import urlopen
        import soundfile as sf
        import numpy as np
        from scipy.signal import resample_poly
        from math import gcd
        with urlopen(request["url"], timeout=30) as response:
            raw = response.read(8 * 1024 * 1024 + 1)
        if len(raw) > 8 * 1024 * 1024:
            raise RuntimeError("Demo recording exceeds 8 MB.")
        samples, rate = sf.read(io.BytesIO(raw), dtype="float32", always_2d=True)
        mono = samples.mean(axis=1)[:rate * 25]
        if len(mono) < rate:
            raise RuntimeError("Demo recording is too short.")
        factor = gcd(rate, 16000)
        mono = resample_poly(mono, 16000 // factor, rate // factor)
        sf.write(request["output"], mono, 16000, subtype="PCM_16")
        print(json.dumps({"duration": len(mono) / 16000}))
        return
    if request["action"] == "remove":
        import os
        from huggingface_hub import scan_cache_dir
        cache = Path(os.environ["HF_HUB_CACHE"]).resolve()
        if cache.exists():
            info = scan_cache_dir(cache_dir=cache)
            revisions = [r.commit_hash for entry in info.repos if entry.repo_id in ({repo, S3_MODEL[0]} if request["model"] == "chatterbox-multilingual-v3" else {repo}) for r in entry.revisions]
            if revisions:
                info.delete_revisions(*revisions).execute()
        print(json.dumps({"removed": True, "voicesPreserved": True}))
        return
    from huggingface_hub import snapshot_download
    if request["action"] == "install":
        for name, pin in ([(repo, revision), S3_MODEL] if request["model"] == "chatterbox-multilingual-v3" else [(repo, revision)]):
            snapshot_download(name, revision=pin)
        tokenizer = snapshot_download(S3_MODEL[0], revision=S3_MODEL[1]) if request["model"] == "chatterbox-multilingual-v3" else None
        if tokenizer and Path(tokenizer).name != S3_MODEL[1]:
            raise RuntimeError("Tokenizer revision changed; update the supported model catalog.")
        print(json.dumps({"installed": True}))
        return
    import os
    os.environ["HF_HUB_OFFLINE"] = "1"
    import huggingface_hub.constants
    huggingface_hub.constants.HF_HUB_OFFLINE = True
    import mlx.core as mx
    import numpy as np
    import soundfile as sf
    from mlx_audio.tts.utils import load_model
    folder = snapshot_download(repo, revision=revision, local_files_only=True)
    model = load_model(folder)
    if request["action"] == "design":
        styles = {
            "male": "An adult man with a warm rich low baritone voice, natural resonance and clear relaxed delivery.",
            "female": "An adult woman with a clear warm expressive voice, soft natural resonance and relaxed delivery.",
            "child": "A cheerful young child cartoon character voice, youthful light timbre and playful clear delivery. Wholesome family animation narration.",
        }
        chunks = []
        reference_text = "Hello there! I am happy to meet you. Together we can explore a wonderful world, tell stories, and discover something new every day."
        for result in model.generate_voice_design(text=reference_text, language="English", instruct=styles[request["voiceType"]] + " " + request.get("description", ""), max_tokens=400):
            mx.eval(result.audio)
            chunks.append(np.array(result.audio).reshape(-1))
        if not chunks:
            raise RuntimeError("Voice design produced no audio.")
        reference = request["output"] + ".reference.wav"
        sf.write(reference, np.concatenate(chunks), model.sample_rate, subtype="PCM_16")
        del model, chunks
        import gc
        gc.collect()
        mx.clear_cache()
        repo, revision = MODELS["chatterbox-multilingual-v3"]
        model = load_model(snapshot_download(repo, revision=revision, local_files_only=True))
        request["reference"] = reference
    chunks = []
    for result in model.generate(text=request["text"], ref_audio=request["reference"], lang_code=request["language"], exaggeration=request.get("exaggeration", 0.1), max_tokens=800):
        mx.eval(result.audio)
        chunks.append(np.array(result.audio).reshape(-1))
    if not chunks:
        raise RuntimeError("The model produced no audio.")
    samples = np.concatenate(chunks)
    if len(samples) > model.sample_rate * 120:
        raise RuntimeError("Generated speech exceeds two minutes.")
    sf.write(request["output"], samples, model.sample_rate, subtype="PCM_16")
    if request["action"] == "design":
        Path(request["output"] + ".reference.wav").unlink(missing_ok=True)
    print(json.dumps({"duration": len(samples) / model.sample_rate, "sampleRate": model.sample_rate}))

if __name__ == "__main__":
    main()
