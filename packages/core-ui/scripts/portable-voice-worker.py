"""Fixed-catalogue portable speech workers. No request supplies code, package names or URLs."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import venv
import wave

request = json.loads(sys.stdin.readline())
models = json.loads(Path(__file__).with_name('portable-voice-models.json').read_text())
model = next(m for m in models if m['id'] == request['engine'])
root = Path(request['root']).resolve()
folder = root / model['id'] / 'model'
runtime = root / model['id'] / 'runtime'
python = runtime / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
action = request['action']

def output(value):
    print(json.dumps(value), flush=True)

def checked(file, spec):
    if not file.is_file() or file.stat().st_size != spec['size']:
        return False
    sha256 = hashlib.sha256()
    git = hashlib.sha1(('blob ' + str(spec['size']) + '\0').encode())
    with file.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            sha256.update(chunk)
            git.update(chunk)
    return sha256.hexdigest() == spec['sha256'] if spec.get('sha256') else git.hexdigest() == spec['git']

if action == 'runtime':
    runtime.parent.mkdir(parents=True, exist_ok=True)
    venv.EnvBuilder(with_pip=True).create(runtime)
    subprocess.run([str(python), '-m', 'pip', 'install', '--disable-pip-version-check', '--no-cache-dir', *model['packages']], check=True, stdout=sys.stderr)
    subprocess.run([str(python), '-c', 'import ' + model['module']], check=True, stdout=sys.stderr)
    (runtime.parent / 'runtime-ready.json').write_text(json.dumps({'packages': model['packages']}))
    output({'installed': True})
elif action == 'download':
    folder.mkdir(parents=True, exist_ok=True, mode=0o700)
    if shutil.disk_usage(folder).free < model['downloadBytes'] + 512 * 1024 * 1024:
        raise RuntimeError('disk_space')
    for spec in model['files']:
        file = folder / spec['path']
        if checked(file, spec):
            continue
        file.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        partial = file.with_name(file.name + '.part')
        url = 'https://huggingface.co/' + model['repo'] + '/resolve/' + model['revision'] + '/' + spec['path']
        total = 0
        try:
            with urllib.request.urlopen(url, timeout=120) as response, partial.open('wb') as target:
                os.chmod(partial, 0o600)
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > spec['size']:
                        raise RuntimeError('download_size')
                    target.write(chunk)
            if not checked(partial, spec):
                raise RuntimeError('download_hash')
            partial.replace(file)
        finally:
            partial.unlink(missing_ok=True)
    (folder.parent / 'model-ready.json').write_text(json.dumps({'revision': model['revision']}))
    output({'installed': True})
elif action == 'remove':
    if folder.parent.parent != root:
        raise RuntimeError('invalid_path')
    shutil.rmtree(folder, ignore_errors=True)
    (folder.parent / 'model-ready.json').unlink(missing_ok=True)
    output({'removed': True})
elif action == 'speak':
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    text, language, voice, target = request['text'], request['language'], request['voice'], request['output']
    if language not in model['languages']:
        raise RuntimeError('language_unsupported')
    if model['id'] == 'piper-voices':
        from piper import PiperVoice
        suffix = 'ar/ar_JO/kareem/medium/ar_JO-kareem-medium.onnx' if voice == 'piper-ar-kareem' else 'en/en_US/lessac/medium/en_US-lessac-medium.onnx'
        speaker = PiperVoice.load(str(folder / suffix))
        with wave.open(target, 'wb') as audio:
            speaker.synthesize_wav(text, audio)
    elif model['id'] == 'kitten-nano':
        from kittentts import KittenTTS
        import soundfile as sf
        speaker = KittenTTS(model_path=str(folder / 'kitten_tts_nano_v0_1.onnx'), voices_path=str(folder / 'voices.npz'))
        samples = speaker.generate(text, voice=voice.removeprefix('kitten-'))
        sf.write(target, samples, 24000, subtype='PCM_16')
    elif model['id'] == 'supertonic-3':
        from supertonic import TTS
        import soundfile as sf
        speaker = TTS(model_dir=str(folder), auto_download=False)
        samples, duration = speaker.synthesize(text, voice_style=speaker.get_voice_style(voice.removeprefix('supertonic-').upper()), lang=language)
        sf.write(target, samples.reshape(-1), speaker.sample_rate, subtype='PCM_16')
    elif model['id'] == 'chatterbox-torch':
        import torch
        import torchaudio
        from chatterbox.mtl_tts import ChatterboxMultilingualTTS
        device = 'cuda' if torch.cuda.is_available() else 'cpu'
        speaker = ChatterboxMultilingualTTS.from_local(str(folder), device=device)
        samples = speaker.generate(text, language_id=language, audio_prompt_path=request.get('reference'))
        torchaudio.save(target, samples.cpu(), speaker.sr)
    with wave.open(target, 'rb') as audio:
        duration = audio.getnframes() / audio.getframerate()
    if duration > 120 or Path(target).stat().st_size > 8 * 1024 * 1024:
        raise RuntimeError('audio_limit')
    output({'duration': duration})
else:
    raise RuntimeError('invalid_action')
