const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const settingsLib = require('../lib/settings.cjs');
const tunnel = require('../lib/tunnel.cjs');
const keytest = require('../lib/keytest.cjs');
const stackLib = require('../lib/stack.cjs');
const { freePort, waitFor } = require('../lib/util.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'backlot-desktop-'));
// A stand-in for Electron's safeStorage: "encrypts" by reversing, so tests can tell sealed from plain.
const fakeSafe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from([...s].reverse().join('')), decryptString: (b) => [...b.toString()].reverse().join('') };

test('settings: keys are sealed on disk and never sent back to the window', () => {
  const dir = tmp();
  const s = settingsLib.create({ dir, safeStorage: fakeSafe });
  assert.equal(s.exists(), false);
  s.save({ mode: 'real', anthropicKey: 'sk-ant-secret-1', minimaxKey: 'mm-key', runpodKey: 'rp-key', runpodEndpointId: ' ep123 ' });
  const onDisk = fs.readFileSync(s.file, 'utf8');
  assert.ok(!onDisk.includes('sk-ant-secret-1'), 'the key must not be readable in the file');
  const loaded = s.load();
  assert.equal(loaded.anthropicKey, 'sk-ant-secret-1');
  assert.equal(loaded.runpodEndpointId, 'ep123');
  const view = s.forWindow();
  assert.equal(view.anthropicKey, '');
  assert.equal(view.has.anthropicKey, true);
  assert.equal(view.has.geminiKey, false);
  assert.equal('signingSecret' in view, false);
});

test('settings: a blank key keeps the saved one; values are clamped; the signing secret is stable', () => {
  const dir = tmp();
  const s = settingsLib.create({ dir, safeStorage: fakeSafe });
  const first = s.save({ anthropicKey: 'keep-me', maxFilmSeconds: 99999, parallelRenders: 0, gpuPricePerSecond: -3, mode: 'nonsense', imageProvider: 'x' });
  assert.equal(first.maxFilmSeconds, 3600);
  assert.equal(first.parallelRenders, 1);
  assert.equal(first.gpuPricePerSecond, 0);
  assert.equal(first.mode, 'demo');
  assert.equal(first.imageProvider, 'minimax');
  const second = s.save({ anthropicKey: '   ', storyQuality: 'medium' });
  assert.equal(second.anthropicKey, 'keep-me');
  assert.equal(second.storyQuality, 'medium');
  assert.equal(second.signingSecret, first.signingSecret);
  assert.ok(first.signingSecret.length >= 32);
});

test('settings: without a keychain keys are still saved (file readable only by this user)', () => {
  const dir = tmp();
  const s = settingsLib.create({ dir, safeStorage: { isEncryptionAvailable: () => false } });
  s.save({ anthropicKey: 'abc' });
  assert.equal(s.load().anthropicKey, 'abc');
  if (process.platform !== 'win32') assert.equal(fs.statSync(s.file).mode & 0o077, 0);
});

test('settings: says in plain words what is missing for real mode', () => {
  const dir = tmp();
  const s = settingsLib.create({ dir, safeStorage: fakeSafe });
  assert.equal(s.missing(s.load()), null, 'demo mode needs nothing');
  s.save({ mode: 'real' });
  assert.match(s.missing(s.load()), /Anthropic/);
  s.save({ anthropicKey: 'a' });
  assert.match(s.missing(s.load()), /MiniMax/);
  s.save({ minimaxKey: 'm', imageProvider: 'gemini' });
  assert.match(s.missing(s.load()), /Gemini/);
  s.save({ imageProvider: 'minimax' });
  assert.match(s.missing(s.load()), /RunPod/);
  s.save({ runpodKey: 'r', runpodEndpointId: 'e' });
  assert.equal(s.missing(s.load()), null);
  s.save({ videoProvider: 'minimax', runpodKey: '', runpodEndpointId: '' });
  assert.equal(s.missing(s.load()), null, 'MiniMax-hosted video needs no RunPod details');
});

test('engine environment: demo is fully mocked; real passes keys; the shell does not leak in', () => {
  process.env.ANTHROPIC_API_KEY = 'from-the-shell-must-not-leak';
  process.env.DATABASE_URL = 'postgres://shell/leak';
  const ctx = { port: 1234, databaseUrl: 'postgres://u:p@127.0.0.1:5/backlot', storageDir: '/d/files', webDir: '/w', ffmpeg: '/bin/ffmpeg', ffprobe: '/bin/ffprobe', fontFile: '/f/a.ttf', fontsDir: '/f', publicBaseUrl: '' };
  const base = { signingSecret: 'sig', maxFilmSeconds: 120, parallelRenders: 2 };
  const demo = settingsLib.engineEnv({ ...base, mode: 'demo' }, ctx);
  assert.equal(demo.MOCK_PROVIDERS, '1');
  assert.equal(demo.ALLOW_DEV_TOKENS, '1');
  assert.equal(demo.DATABASE_URL, ctx.databaseUrl);
  assert.equal(demo.ANTHROPIC_API_KEY, undefined);
  assert.equal(demo.NODE_ENV, undefined, 'dev sign-in is refused when NODE_ENV=production');
  assert.equal(demo.PUBLIC_BASE_URL, undefined);

  const real = settingsLib.engineEnv({ ...base, mode: 'real', anthropicKey: 'ak', minimaxKey: 'mk', storyQuality: 'medium', scriptDoctor: false, imageProvider: 'openai', openaiKey: 'ok', videoProvider: 'runpod', runpodKey: 'rk', runpodEndpointId: 'ep', gpuPricePerSecond: 0.0007 }, { ...ctx, publicBaseUrl: 'https://x.trycloudflare.com' });
  assert.equal(real.MOCK_PROVIDERS, undefined);
  assert.equal(real.ANTHROPIC_API_KEY, 'ak');
  assert.equal(real.STORY_EFFORT, 'medium');
  assert.equal(real.SCRIPT_DOCTOR, '0');
  assert.equal(real.IMAGE_PROVIDER, 'openai');
  assert.equal(real.OPENAI_API_KEY, 'ok');
  assert.equal(real.VIDEO_PROVIDER, 'runpod');
  assert.equal(real.RUNPOD_ENDPOINT_ID, 'ep');
  assert.equal(real.RUNPOD_GPU_PRICE_PER_SECOND, '0.0007');
  assert.equal(real.PUBLIC_BASE_URL, 'https://x.trycloudflare.com');
  delete process.env.ANTHROPIC_API_KEY; delete process.env.DATABASE_URL;
});

test('tunnel: picks the right download for each system and finds the address in cloudflared output', () => {
  assert.equal(tunnel.assetFor('linux', 'x64').name, 'cloudflared-linux-amd64');
  assert.equal(tunnel.assetFor('linux', 'arm64').name, 'cloudflared-linux-arm64');
  assert.equal(tunnel.assetFor('darwin', 'arm64').name, 'cloudflared-darwin-arm64.tgz');
  assert.equal(tunnel.assetFor('win32', 'x64').file, 'cloudflared.exe');
  assert.throws(() => tunnel.assetFor('freebsd', 'x64'));
  const line = '2026-10-10T10:00:00Z INF |  https://quick-brown-fox-1234.trycloudflare.com                                |';
  assert.equal(tunnel.URL_RX.exec(line)[0], 'https://quick-brown-fox-1234.trycloudflare.com');
  assert.equal(tunnel.URL_RX.exec('Thank you for trying Cloudflare Tunnel. https://www.cloudflare.com/website-terms/'), null);
});

test('key test: plain-language verdicts', async () => {
  assert.equal(keytest.verdict(200, 'Anthropic').ok, true);
  assert.match(keytest.verdict(401, 'Anthropic').message, /rejected/);
  assert.match(keytest.verdict(404, 'RunPod').message, /ID/);
  assert.match(keytest.verdict(503, 'RunPod').message, /503/);
  assert.match((await keytest.test('anthropic', { key: '' })).message, /Enter the key/);
  assert.match((await keytest.test('runpod', { key: 'x', endpointId: '' })).message, /both/);
});

test('stack: starts database → tunnel → engine in order, passes the tunnel address to the engine, and stops everything', async () => {
  const dir = tmp();
  const s = settingsLib.create({ dir, safeStorage: fakeSafe });
  s.save({ mode: 'real', anthropicKey: 'a', minimaxKey: 'm', runpodKey: 'r', runpodEndpointId: 'e' });
  const order = [];
  let engineEnvSeen = null;
  const pgImpl = { start: async () => { order.push('pg'); return { url: 'postgres://u:p@127.0.0.1:1/backlot', stop: async () => order.push('pg-stop') }; } };
  const tunnelImpl = {
    start: async () => { order.push('tunnel'); return { url: 'https://abc.trycloudflare.com', onExit() {}, stop: () => order.push('tunnel-stop') }; },
    reachable: async () => true,
  };
  const engineImpl = { start: async ({ env, port }) => { order.push('engine'); engineEnvSeen = env; return { url: `http://127.0.0.1:${port}`, onExit() {}, stop: async () => order.push('engine-stop') }; } };
  const stack = stackLib.create({
    dataDir: dir, paths: { engineDir: '/e', webDir: '/w', fontsDir: '/f', fontFile: '/f/a.ttf' }, execPath: process.execPath, settings: s,
    log: () => {}, say: () => {}, pgImpl, tunnelImpl, engineImpl, tools: () => ({ ffmpeg: '/ff', ffprobe: '/fp' }),
  });
  const r = await stack.run();
  assert.deepEqual(order, ['pg', 'tunnel', 'engine']);
  assert.equal(r.publicUrl, 'https://abc.trycloudflare.com');
  assert.equal(r.tunnelOk, true);
  assert.equal(engineEnvSeen.PUBLIC_BASE_URL, 'https://abc.trycloudflare.com');
  assert.equal(engineEnvSeen.RUNPOD_ENDPOINT_ID, 'e');

  // Restart (e.g. after changing settings): the database stays up, the tunnel and engine are replaced.
  order.length = 0;
  await stack.restart();
  assert.deepEqual(order, ['tunnel-stop', 'engine-stop', 'tunnel', 'engine']);
  order.length = 0;
  await stack.stop();
  assert.deepEqual(order, ['tunnel-stop', 'engine-stop', 'pg-stop']);
});

test('stack: no tunnel for demo mode, for MiniMax video or when you bring your own public address; refuses incomplete settings', async () => {
  const dir = tmp();
  const s = settingsLib.create({ dir, safeStorage: fakeSafe });
  const calls = [];
  const mk = () => stackLib.create({
    dataDir: dir, paths: { engineDir: '/e', webDir: '/w', fontsDir: '/f', fontFile: '/f/a.ttf' }, execPath: process.execPath, settings: s, log: () => {}, say: () => {},
    pgImpl: { start: async () => ({ url: 'postgres://x', stop: async () => {} }) },
    tunnelImpl: { start: async () => { calls.push('tunnel'); return { url: 'https://t', onExit() {}, stop() {} }; }, reachable: async () => true },
    engineImpl: { start: async ({ env, port }) => { calls.push(env.PUBLIC_BASE_URL || '-'); return { url: `http://127.0.0.1:${port}`, onExit() {}, stop: async () => {} }; } },
    tools: () => ({ ffmpeg: 'f', ffprobe: 'p' }),
  });
  s.save({ mode: 'demo' });
  let st = mk(); await st.run(); await st.stop();
  s.save({ mode: 'real', anthropicKey: 'a', minimaxKey: 'm', videoProvider: 'minimax' });
  st = mk(); await st.run(); await st.stop();
  s.save({ videoProvider: 'runpod', runpodKey: 'r', runpodEndpointId: 'e', publicUrl: 'https://mine.example.com/' });
  st = mk(); await st.run(); await st.stop();
  assert.deepEqual(calls, ['-', '-', 'https://mine.example.com']);
  s.save({ publicUrl: '', runpodEndpointId: '' }); // can't clear a secret, but the endpoint ID is plain
  await assert.rejects(() => mk().run(), /RunPod API key and endpoint ID/);
});

test('util: freePort and waitFor', async () => {
  const p = await freePort(0);
  assert.ok(p > 1024);
  const srv = http.createServer((_, res) => res.end('ok'));
  await new Promise((r) => srv.listen(p, '127.0.0.1', r));
  assert.notEqual(await freePort(p), p, 'a taken port falls back to another');
  srv.close();
  let n = 0;
  assert.equal(await waitFor(() => ++n >= 3 && 'done', { everyMs: 5 }), 'done');
  await assert.rejects(() => waitFor(() => false, { timeoutMs: 60, everyMs: 10, what: 'nothing' }), /Timed out waiting for nothing/);
});
