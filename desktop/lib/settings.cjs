// Settings live in one JSON file in the app's data folder. API keys are encrypted with the operating system's
// keychain when it is available (Electron's safeStorage); otherwise they are stored as plain text in a file only
// this user can read. The settings window never receives a saved key back: it only learns that one is set.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const SECRETS = ['anthropicKey', 'minimaxKey', 'geminiKey', 'openaiKey', 'runpodKey'];

const DEFAULTS = {
  mode: 'demo', // demo: everything is faked, no keys, nothing billed. real: your own keys.
  storyQuality: 'high', // high | medium
  scriptDoctor: true,
  imageProvider: 'minimax', // minimax | gemini | openai
  videoProvider: 'runpod', // runpod (your own H3) | minimax (MiniMax's hosted H3)
  runpodEndpointId: '',
  gpuPricePerSecond: 0,
  publicUrl: '', // blank: open a free tunnel automatically so RunPod can reach this computer
  maxFilmSeconds: 120,
  parallelRenders: 2,
};

function create({ dir, safeStorage }) {
  const file = path.join(dir, 'settings.json');
  const canEncrypt = () => { try { return !!safeStorage && safeStorage.isEncryptionAvailable(); } catch { return false; } };
  const seal = (v) => (v && canEncrypt() ? { enc: safeStorage.encryptString(v).toString('base64') } : { plain: v });
  const open = (o) => {
    if (!o) return '';
    if (typeof o === 'string') return o;
    if (o.enc) { try { return safeStorage.decryptString(Buffer.from(o.enc, 'base64')); } catch { return ''; } }
    return o.plain || '';
  };

  function load() {
    let raw = {};
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first run */ }
    const s = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (raw[k] !== undefined) s[k] = raw[k];
    for (const k of SECRETS) s[k] = open(raw.secrets && raw.secrets[k]);
    s.signingSecret = open(raw.secrets && raw.secrets.signingSecret) || '';
    return s;
  }

  function exists() { return fs.existsSync(file); }

  /** Merge a partial update. A blank secret keeps the saved one. */
  function save(patch) {
    const cur = load();
    const next = { ...cur };
    for (const k of Object.keys(DEFAULTS)) if (patch[k] !== undefined) next[k] = patch[k];
    for (const k of SECRETS) if (typeof patch[k] === 'string' && patch[k].trim()) next[k] = patch[k].trim();
    next.mode = next.mode === 'real' ? 'real' : 'demo';
    next.storyQuality = next.storyQuality === 'medium' ? 'medium' : 'high';
    next.imageProvider = ['minimax', 'gemini', 'openai'].includes(next.imageProvider) ? next.imageProvider : 'minimax';
    next.videoProvider = next.videoProvider === 'minimax' ? 'minimax' : 'runpod';
    next.runpodEndpointId = String(next.runpodEndpointId || '').trim();
    next.publicUrl = String(next.publicUrl || '').trim().replace(/\/$/, '');
    next.gpuPricePerSecond = Math.max(0, Number(next.gpuPricePerSecond) || 0);
    const whole = (v, fallback) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Math.round(Number(v)) : fallback);
    next.maxFilmSeconds = Math.min(3600, Math.max(15, whole(next.maxFilmSeconds, 120)));
    next.parallelRenders = Math.min(20, Math.max(1, whole(next.parallelRenders, 2)));
    next.scriptDoctor = !!next.scriptDoctor;
    if (!next.signingSecret) next.signingSecret = crypto.randomBytes(32).toString('hex');
    const out = {};
    for (const k of Object.keys(DEFAULTS)) out[k] = next[k];
    out.secrets = { signingSecret: seal(next.signingSecret) };
    for (const k of SECRETS) if (next[k]) out.secrets[k] = seal(next[k]);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(out, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return next;
  }

  /** What the settings window may see: everything except the keys themselves. */
  function forWindow() {
    const s = load();
    const view = { ...s, has: {} };
    for (const k of SECRETS) { view.has[k] = !!s[k]; view[k] = ''; }
    delete view.signingSecret;
    return view;
  }

  /** What the real providers need, in plain words: the first missing thing, or null. */
  function missing(s) {
    if (s.mode !== 'real') return null;
    if (!s.anthropicKey) return 'an Anthropic API key (it writes the story)';
    if (!s.minimaxKey) return 'a MiniMax API key (it makes the voices)';
    if (s.imageProvider === 'gemini' && !s.geminiKey) return 'a Gemini API key (you chose Gemini for images)';
    if (s.imageProvider === 'openai' && !s.openaiKey) return 'an OpenAI API key (you chose OpenAI for images)';
    if (s.videoProvider === 'runpod' && (!s.runpodKey || !s.runpodEndpointId)) return 'your RunPod API key and endpoint ID';
    return null;
  }

  return { file, load, save, exists, forWindow, missing };
}

/** The environment the engine runs with. Only a few inherited variables are passed on, so nothing from the shell leaks in. */
function engineEnv(s, ctx) {
  const inherit = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'TMPDIR', 'SystemRoot', 'LANG', 'LC_ALL',
    'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE'];
  const env = {};
  for (const k of inherit) if (process.env[k]) env[k] = process.env[k];
  Object.assign(env, {
    ELECTRON_RUN_AS_NODE: '1',
    ALLOW_DEV_TOKENS: '1', // you are the only user: signed in as a fixed local user, nothing is charged
    PORT: String(ctx.port),
    DATABASE_URL: ctx.databaseUrl,
    STORAGE_DIR: ctx.storageDir,
    WEB_DIR: ctx.webDir,
    FILE_SIGNING_SECRET: s.signingSecret,
    FFMPEG_BIN: ctx.ffmpeg,
    FFPROBE_BIN: ctx.ffprobe,
    SUBTITLE_FONT: 'DejaVu Sans',
    SUBTITLE_FONT_FILE: ctx.fontFile,
    SUBTITLE_FONTS_DIR: ctx.fontsDir,
    MAX_RUNTIME_SECONDS: String(s.maxFilmSeconds),
    VIDEO_MAX_INFLIGHT: String(s.parallelRenders),
  });
  if (ctx.publicBaseUrl) env.PUBLIC_BASE_URL = ctx.publicBaseUrl;
  if (s.mode !== 'real') { env.MOCK_PROVIDERS = '1'; return env; }
  Object.assign(env, {
    ANTHROPIC_API_KEY: s.anthropicKey,
    STORY_EFFORT: s.storyQuality === 'medium' ? 'medium' : 'high',
    SCRIPT_DOCTOR: s.scriptDoctor ? '1' : '0',
    IMAGE_PROVIDER: s.imageProvider,
    MINIMAX_API_KEY: s.minimaxKey,
    VIDEO_PROVIDER: s.videoProvider,
  });
  if (s.geminiKey) env.GEMINI_API_KEY = s.geminiKey;
  if (s.openaiKey) env.OPENAI_API_KEY = s.openaiKey;
  if (s.videoProvider === 'runpod') {
    env.RUNPOD_API_KEY = s.runpodKey;
    env.RUNPOD_ENDPOINT_ID = s.runpodEndpointId;
    env.RUNPOD_GPU_PRICE_PER_SECOND = String(s.gpuPricePerSecond);
  }
  return env;
}

module.exports = { create, engineEnv, SECRETS, DEFAULTS };
