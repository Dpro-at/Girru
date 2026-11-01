import { spawn } from 'node:child_process';
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  stat,
  chmod,
  unlink,
} from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
export const VOICE_MODELS = [
  {
    id: 'chatterbox-multilingual-v3',
    name: 'Multilingual Voice',
    languages: [
      'ar',
      'da',
      'de',
      'el',
      'en',
      'es',
      'fi',
      'fr',
      'he',
      'hi',
      'it',
      'ja',
      'ko',
      'ms',
      'nl',
      'no',
      'pl',
      'pt',
      'ru',
      'sv',
      'sw',
      'tr',
      'zh',
    ],
    cloning: true,
    downloadBytes: 3208000000,
    license: 'MIT',
    modelUrl: 'https://huggingface.co/mlx-community/chatterbox-multilingual-v3',
    platform: 'Apple Silicon',
    platforms: ['darwin-arm64'],
    optional: true,
    installation: 'host-managed-runtime',
    runtime: 'mlx-audio==0.5.9',
  },
  {
    id: 'voice-design-4bit', name: 'Voice Designer', languages: ['en','zh','ja','ko','de','fr','ru','pt','es','it'],
    voiceDesign: true, cloning: false, downloadBytes: 2313000000, license: 'Apache-2.0',
    modelUrl: 'https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-4bit',
    platform: 'Apple Silicon', platforms: ['darwin-arm64'], optional: true,
    installation: 'host-managed-runtime', runtime: 'mlx-audio==0.5.9',
    requires: ['chatterbox-multilingual-v3'],
  },

];
export const VOICE_DEMOS = JSON.parse(
  await readFile(new URL('./voice-demos.json', import.meta.url), 'utf8'),
).map((row) => ({
  ...row,
  name:
    new Intl.DisplayNames(['en'], { type: 'language' }).of(row.language) +
    ' demo voice',
  source:
    'https://github.com/resemble-ai/chatterbox/blob/master/multilingual_app.py',
  usage:
    'Publisher-provided cloning demo; private evaluation. Downloaded separately, never bundled.',
}));
const worker = fileURLToPath(new URL('./voice-worker.py', import.meta.url));
const id = (value) => {
  if (typeof value !== 'string' || !/^[a-z0-9-]{1,80}$/.test(value))
    throw new Error('Invalid voice ID.');
  return value;
};
const text = (value, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error('Invalid voice text.');
  return value.trim();
};
function wavInfo(buffer, minimum = 3) {
  if (
    buffer.length < 44 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WAVE'
  )
    throw new Error('Upload a PCM WAV recording.');
  let rate = 0,
    channels = 0,
    bits = 0,
    bytes = 0;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(offset + 4),
      tag = buffer.toString('ascii', offset, offset + 4),
      start = offset + 8;
    if (start + size > buffer.length)
      throw new Error('Incomplete WAV recording.');
    if (tag === 'fmt ' && size >= 16) {
      if (buffer.readUInt16LE(start) !== 1)
        throw new Error('Use PCM WAV audio.');
      channels = buffer.readUInt16LE(start + 2);
      rate = buffer.readUInt32LE(start + 4);
      bits = buffer.readUInt16LE(start + 14);
    }
    if (tag === 'data') bytes += size;
    offset = start + size + (size % 2);
  }
  const duration = bytes / ((rate * channels * bits) / 8);
  if (
    rate < 8000 ||
    rate > 96000 ||
    channels < 1 ||
    channels > 2 ||
    ![16, 24, 32].includes(bits) ||
    !Number.isFinite(duration) ||
    duration < minimum ||
    duration > 30
  )
    throw new Error(
      'Use a clear 3–30 second PCM WAV recording (mono or stereo).',
    );
  return { duration, sampleRate: rate };
}
/** Optional local service. Long operations are polled jobs, never block the Studio mailbox. */
export function createLocalVoice({
  directory = resolve(homedir(), '.genvr', 'voices'),
  python = process.env.GENVR_VOICE_PYTHON,
  modelCache = resolve(homedir(), '.genvr', 'voice-models'),
  generated = async () => {},
  run,
} = {}) {
  const jobs = new Map(),
    children = new Set();
  let busy = false;
  const load = async () => {
    try {
      return JSON.parse(
        await readFile(resolve(directory, 'library.json'), 'utf8'),
      );
    } catch (e) {
      if (e.code === 'ENOENT') return { voices: [], assignments: {} };
      throw e;
    }
  };
  const save = async (data) => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = resolve(directory, randomUUID() + '.tmp');
    await writeFile(temp, JSON.stringify(data), { mode: 0o600, flag: 'wx' });
    await rename(temp, resolve(directory, 'library.json'));
  };
  const invoke =
    run ??
    ((request) =>
      new Promise((ok, fail) => {
        if (!python)
          return fail(
            new Error(
              'Local speech runtime is not installed. Enable voice support in the desktop app or configure its optional runtime.',
            ),
          );
        const child = spawn(python, [worker], {
          env: { ...process.env, HF_HUB_CACHE: modelCache },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        children.add(child);
        let stdout = '',
          stderr = '';
        const timer = setTimeout(() => child.kill('SIGTERM'), 600000);
        child.stdout.on('data', (part) => {
          stdout = (stdout + part).slice(-65536);
        });
        child.stderr.on('data', (part) => {
          stderr = (stderr + part).slice(-4000);
        });
        child.on('error', fail);
        child.on('close', (code) => {
          clearTimeout(timer);
          children.delete(child);
          if (code !== 0)
            return fail(
              new Error(
                stderr.trim().split('\n').at(-1) ||
                  'Local voice worker failed.',
              ),
            );
          try {
            ok(JSON.parse(stdout.trim().split('\n').at(-1)));
          } catch {
            fail(new Error('Invalid local voice worker result.'));
          }
        });
        child.stdin.end(JSON.stringify(request) + '\n');
      }));
  const job = (work) => {
    if (busy) throw new Error('A voice job is already running.');
    busy = true;
    while (jobs.size >= 50) jobs.delete(jobs.keys().next().value);
    const jobId = randomUUID(),
      row = {
        id: jobId,
        status: 'running',
        startedAt: new Date().toISOString(),
      };
    jobs.set(jobId, row);
    Promise.resolve()
      .then(() =>
        work((progress) => {
          row.progress = progress;
        }),
      )
      .then((result) => Object.assign(row, { status: 'done', result }))
      .catch((error) =>
        Object.assign(row, { status: 'failed', error: error.message }),
      )
      .finally(() => {
        busy = false;
      });
    return row;
  };
  let mutation = Promise.resolve();
  const mutate = (work) => {
    const pending = mutation.then(work);
    mutation = pending.catch(() => {});
    return pending;
  };
  const importDemo = async (demo, model) => {
    const existing = (await load()).voices.find(
      (row) => row.demoId === demo.id,
    );
    if (existing) return existing;
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const voiceId = randomUUID(),
      output = resolve(directory, voiceId + '.wav');
    try {
      await invoke({
        action: 'demo',
        model: model.id,
        url: demo.url,
        output,
      });
      const details = wavInfo(await readFile(output), 1),
        voice = {
          id: voiceId,
          name: demo.name,
          model: model.id,
          demoId: demo.id,
          language: demo.language,
          ...details,
          authorization: 'publisher-demo',
          source: demo.source,
          sourceAudio: demo.url,
          usage: demo.usage,
        };
      await chmod(output, 0o600);
      await mutate(async () => {
        const data = await load();
        if (data.voices.length >= 100)
          throw new Error('Voice library is full.');
        data.voices.push(voice);
        await save(data);
      });
      return voice;
    } catch (error) {
      await unlink(output).catch(() => {});
      throw error;
    }
  };
  const makePreview = async (demo, model) => {
    const cached = (await load()).recordings?.find(
      (row) => row.previewDemoId === demo.id && row.model === model.id,
    );
    if (cached) return cached;
    await stat(resolve(directory, model.id + '.installed.json')).catch(()=>{throw new Error('Download this speech model from Models before generating new audio.');});
    const voice = await importDemo(demo, model),
      audioId = randomUUID(),
      output = resolve(directory, audioId + '.wav');
    try {
      const result = await invoke({
        action: 'generate',
        model: model.id,
        text: demo.referenceText,
        language: demo.language,
        reference: resolve(directory, voice.id + '.wav'),
        output,
      });
      await chmod(output, 0o600);
      if (
        (await stat(output)).size > 8 * 1024 * 1024 ||
        !Number.isFinite(result.duration) ||
        result.duration <= 0
      )
        throw new Error('Invalid preview audio.');
      const clip = {
        id: audioId,
        voiceId: voice.id,
        model: model.id,
        previewDemoId: demo.id,
        language: demo.language,
        text: demo.referenceText,
        target: 'self',
        duration: result.duration,
        createdAt: new Date().toISOString(),
      };
      await mutate(async () => {
        const data = await load();
        data.recordings ??= [];
        if (data.recordings.length >= 100)
          throw new Error('Speech recording library is full.');
        data.recordings.push(clip);
        await save(data);
      });
      return clip;
    } catch (error) {
      await unlink(output).catch(() => {});
      throw error;
    }
  };
  async function call(args) {
    const model =
      VOICE_MODELS.find((row) => row.id === args.model) ??
      (args.model === undefined ? VOICE_MODELS[0] : null);
    if (!model) throw new Error('Unknown supported voice model.');
    if (args.action === 'design') {
      const language = args.language ?? 'en', voiceType = args.voiceType;
      if (!VOICE_MODELS[0].languages.includes(language)) throw new Error('Unsupported voice language.');
      if (!['male', 'female', 'child'].includes(voiceType)) throw new Error('Choose male, female or child.');
      const said = text(args.text, 600), description = args.description ? text(args.description, 400) : '';
      return job(async () => {
        for (const required of ['voice-design-4bit', 'chatterbox-multilingual-v3'])
          await stat(resolve(directory, required + '.installed.json')).catch(() => { throw new Error('Download Voice Designer and Multilingual Voice from Models first.'); });
        const audioId = randomUUID(), output = resolve(directory, audioId + '.wav');
        let retained = false;
        try {
          const result = await invoke({ action: 'design', model: 'voice-design-4bit', language, voiceType, description, text: said, output });
          const buffer = await readFile(output), details = wavInfo(buffer);
          if (buffer.length > 8 * 1024 * 1024) throw new Error('Voice preview is too large.');
          await chmod(output, 0o600);
          const clip = { id: audioId, design: true, language, voiceType, description, text: said, model: 'chatterbox-multilingual-v3', sourceModel: 'voice-design-4bit', duration: details.duration, createdAt: new Date().toISOString() };
          await mutate(async () => { const data = await load(); data.recordings ??= []; if (data.recordings.length >= 100) throw new Error('Speech recording library is full.'); data.recordings.push(clip); await save(data); });
          retained = true;
          await generated({ data: buffer.toString('base64'), duration: details.duration, text: said, target: args.target ?? 'self' }, args.sessionId, args.projectId);
          return clip;
        } finally { if (!retained) await unlink(output).catch(() => {}); await unlink(output + '.reference.wav').catch(() => {}); }
      });
    }
    if (args.action === 'save_design') return mutate(async () => {
      const data = await load(), clip = (data.recordings ?? []).find(row => row.id === args.audioId && row.design);
      if (!clip) throw new Error('Generate and preview a voice first.');
      const name = text(args.name, 80);
      if (data.voices.length >= 100) throw new Error('Voice library is full.');
      const voiceId = randomUUID(), output = resolve(directory, voiceId + '.wav');
      const buffer = await readFile(resolve(directory, clip.id + '.wav')), details = wavInfo(buffer);
      const voice = { id: voiceId, name, model: clip.model, sourceModel: clip.sourceModel, language: clip.language, voiceType: clip.voiceType, description: clip.description, authorization: 'synthetic-design', ...details, createdAt: new Date().toISOString() };
      try { await writeFile(output, buffer, { mode: 0o600, flag: 'wx' }); data.voices.push(voice); await save(data); return voice; }
      catch (error) { await unlink(output).catch(() => {}); throw error; }
    });
    if (args.action === 'models')
      return {
        demos: VOICE_DEMOS,
        models: await Promise.all(
          VOICE_MODELS.map(async (row) => ({
            ...row,
            installed: await stat(
              resolve(directory, row.id + '.installed.json'),
            )
              .then(() => true)
              .catch(() => false),
          })),
        ),
        runtimeConfigured: Boolean(python || run),
        busy,
        jobs: [...jobs.values()].slice(-5),
      };
    if (args.action === 'playback')
      return generated(
        { control: true, command: args.command, value: args.value },
        args.sessionId,
        args.projectId,
      );
    if (args.action === 'job') {
      const row = jobs.get(args.jobId);
      if (!row) throw new Error('Unknown voice job.');
      return row;
    }
    if (args.action === 'remove') {
      if (args.confirm !== true)
        throw new Error(
          'Confirm removal of this downloaded model. Saved voices and recordings are kept.',
        );
      return job(async () => {
        const result = await invoke({ action: 'remove', model: model.id });
        await unlink(resolve(directory, model.id + '.installed.json')).catch(
          (error) => {
            if (error.code !== 'ENOENT') throw error;
          },
        );
        return result;
      });
    }
    if (args.action === 'install')
      return job(async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const result = await invoke({ action: 'install', model: model.id });
        await writeFile(
          resolve(directory, model.id + '.installed.json'),
          JSON.stringify(result),
          { mode: 0o600 },
        );
        return result;
      });
    if (args.action === 'demo' || args.action === 'preview_demo') {
      const demo = VOICE_DEMOS.find((row) => row.id === args.demoId);
      if (!demo) throw new Error('Unknown demo voice.');
      if (args.action === 'demo') return job(() => importDemo(demo, model));
      const play = async (clip) => {
        await generated(
          {
            data: (
              await readFile(resolve(directory, clip.id + '.wav'))
            ).toString('base64'),
            duration: clip.duration,
            target: args.target ?? 'self',
            text: clip.text,
          },
          args.sessionId,
          args.projectId,
        );
        return clip;
      };
      const cached = (await load()).recordings?.find(
        (row) => row.previewDemoId === demo.id && row.model === model.id,
      );
      if (cached) return { status: 'done', result: await play(cached) };
      return job(async () => play(await makePreview(demo, model)));
    }
    if (args.action === 'prepare_previews')
      return job(async (report) => {
        const previews = [],
          errors = [];
        for (const demo of VOICE_DEMOS) {
          report({
            completed: previews.length + errors.length,
            total: VOICE_DEMOS.length,
            name: demo.name,
          });
          try {
            previews.push(await makePreview(demo, model));
          } catch (error) {
            errors.push({ id: demo.id, error: error.message });
          }
        }
        report({
          completed: VOICE_DEMOS.length,
          total: VOICE_DEMOS.length,
          name: 'Ready',
        });
        return { previews, errors };
      });
    if (args.action === 'demo_all')
      return job(async (report) => {
        const voices = [],
          errors = [];
        for (const demo of VOICE_DEMOS) {
          report({
            completed: voices.length + errors.length,
            total: VOICE_DEMOS.length,
            name: demo.name,
          });
          try {
            voices.push(await importDemo(demo, model));
          } catch (error) {
            errors.push({ id: demo.id, error: error.message });
          }
        }
        return { voices, errors };
      });
    if (args.action === 'preview') {
      const voice = (await load()).voices.find(
        (row) => row.id === args.voiceId,
      );
      if (!voice) throw new Error('Unknown voice profile.');
      return generated(
        {
          data: (
            await readFile(resolve(directory, voice.id + '.wav'))
          ).toString('base64'),
          duration: voice.duration,
          target: args.target ?? 'self',
          text: voice.name + ' · reference sample',
        },
        args.sessionId,
        args.projectId,
      );
    }
    if (args.action === 'export_voice') {
      const voice = (await load()).voices.find(row => row.id === args.voiceId);
      if (!voice) throw new Error('Unknown voice profile.');
      const original = await readFile(resolve(directory, voice.id + '.wav'));
      const info = Buffer.from(JSON.stringify(voice) + '\0', 'utf8');
      const comment = Buffer.alloc(8 + info.length + info.length % 2);
      comment.write('ICMT'); comment.writeUInt32LE(info.length, 4); info.copy(comment, 8);
      const list = Buffer.alloc(12); list.write('LIST'); list.writeUInt32LE(4 + comment.length, 4); list.write('INFO', 8);
      const audio = Buffer.concat([original, list, comment]); audio.writeUInt32LE(audio.length - 8, 4);
      return { mime: 'audio/wav', filename: voice.name.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0,80) + '.wav', metadata: voice, data: audio.toString('base64') };
    }
    if (args.action === 'voices') return load();
    if (args.action === 'recordings')
      return { recordings: (await load()).recordings ?? [] };
    if (args.action === 'audio') {
      const audioId = id(args.audioId),
        data = await load();
      if (!(data.recordings ?? []).some((row) => row.id === audioId))
        throw new Error('Unknown speech recording.');
      return {
        mime: 'audio/wav',
        data: (await readFile(resolve(directory, audioId + '.wav'))).toString(
          'base64',
        ),
      };
    }
    if (args.action === 'replay') {
      const audioId = id(args.audioId),
        data = await load(),
        clip = (data.recordings ?? []).find((row) => row.id === audioId);
      if (!clip) throw new Error('Unknown speech recording.');
      return generated(
        {
          data: (await readFile(resolve(directory, audioId + '.wav'))).toString(
            'base64',
          ),
          duration: clip.duration,
          target: args.target ?? clip.target,
          text: clip.text,
        },
        args.sessionId,
        args.projectId,
      );
    }
    if (args.action === 'clone')
      return mutate(async () => {
        if (args.consent !== true)
          throw new Error(
            'Confirm the speaker has authorized this voice sample.',
          );
        const name = text(args.name, 80);
        if (
          typeof args.audio !== 'string' ||
          args.audio.length > 12 * 1024 * 1024 ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(args.audio)
        )
          throw new Error('Invalid WAV sample.');
        const buffer = Buffer.from(args.audio, 'base64'),
          details = wavInfo(buffer),
          voiceId = randomUUID(),
          data = await load();
        if (data.voices.length >= 100)
          throw new Error('Voice library is full.');
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await writeFile(resolve(directory, voiceId + '.wav'), buffer, {
          mode: 0o600,
          flag: 'wx',
        });
        const voice = {
          id: voiceId,
          name,
          model: model.id,
          ...details,
          consentAt: new Date().toISOString(),
          language: args.language ?? 'en',
        };
        data.voices.push(voice);
        await save(data);
        return voice;
      });
    if (args.action === 'assign')
      return mutate(async () => {
        const data = await load(),
          target = text(args.target ?? 'self', 120),
          project = text(args.projectId, 120);
        if (!data.voices.some((row) => row.id === args.voiceId))
          throw new Error('Unknown voice profile.');
        data.assignments[project + ':' + target] = args.voiceId;
        await save(data);
        return { target, voiceId: args.voiceId };
      });
    if (args.action === 'speak') {
      const said = text(args.text, 1200),
        language = args.language ?? 'ar';
      if (!model.languages.includes(language))
        throw new Error('Language is not supported by this model.');
      const data = await load(),
        voiceId = id(
          args.voiceId ??
            data.assignments[
              (args.projectId ?? '') + ':' + (args.target ?? 'self')
            ],
        ),
        voice = data.voices.find((row) => row.id === voiceId);
      if (!voice) throw new Error('Choose or create a voice profile.');
      if (voice.model !== model.id)
        throw new Error('Voice profile uses a different model.');
      return job(async () => {
        await stat(resolve(directory, model.id + '.installed.json')).catch(()=>{throw new Error('Download this speech model from Models before generating new audio.');});
        const audioId = randomUUID(),
          output = resolve(directory, audioId + '.wav');
        let retained = false;
        try {
          const result = await invoke({
            action: 'generate',
            model: model.id,
            text: said,
            language,
            reference: resolve(directory, voiceId + '.wav'),
            output,
          });
          await chmod(output, 0o600);
          const audio = await readFile(output);
          if (audio.length > 8 * 1024 * 1024)
            throw new Error('Speech exceeds 8 MB.');
          if (!Number.isFinite(result.duration) || result.duration <= 0)
            throw new Error('Voice worker returned an invalid duration.');
          await mutate(async () => {
            const library = await load();
            library.recordings ??= [];
            if (library.recordings.length >= 100)
              throw new Error('Speech recording library is full.');
            library.recordings.push({
              id: audioId,
              voiceId,
              language,
              text: said,
              target: args.target ?? 'self',
              duration: result.duration,
              createdAt: new Date().toISOString(),
            });
            await save(library);
            retained = true;
          });
          const playback = args.preview === false ? { previewed: false } : await generated(
            {
              data: audio.toString('base64'),
              duration: result.duration,
              target: args.target ?? 'self',
              text: said,
            },
            args.sessionId,
            args.projectId,
          );
          return {
            audioId,
            voiceId,
            language,
            duration: result.duration,
            playback,
          };
        } finally {
          if (!retained) await unlink(output).catch(() => {});
        }
      });
    }
    throw new Error('Unknown voice action.');
  }
  return {
    call,
    close() {
      for (const child of children) child.kill('SIGTERM');
    },
  };
}
