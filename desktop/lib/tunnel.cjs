// RunPod's GPU has to reach this computer: it downloads each shot's reference images from it and uploads the finished
// clip back. A free Cloudflare "quick tunnel" gives this computer a temporary public https address for that.
// The `cloudflared` program (Cloudflare's, pinned to one version) is downloaded the first time it is needed.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFile } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { waitFor, sleep } = require('./util.cjs');

const VERSION = '2026.10.0';

function assetFor(platform = process.platform, arch = process.arch) {
  const a = arch === 'arm64' ? 'arm64' : 'amd64';
  if (platform === 'linux') return { name: `cloudflared-linux-${a}`, file: 'cloudflared' };
  if (platform === 'darwin') return { name: `cloudflared-darwin-${a}.tgz`, file: 'cloudflared', tgz: true };
  if (platform === 'win32') return { name: 'cloudflared-windows-amd64.exe', file: 'cloudflared.exe' };
  throw new Error(`No tunnel program for ${platform}/${arch}`);
}

const execFileP = (...a) => new Promise((res, rej) => execFile(...a, (e, so, se) => (e ? rej(new Error(se || e.message)) : res(so))));

async function ensureBinary(binDir, say, { fetchImpl = fetch } = {}) {
  const asset = assetFor();
  const dest = path.join(binDir, `${VERSION}-${asset.file}`);
  if (fs.existsSync(dest)) return dest;
  fs.mkdirSync(binDir, { recursive: true });
  say('Downloading the tunnel program (one time, about 40 MB)…');
  const res = await fetchImpl(`https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/${asset.name}`);
  if (!res.ok || !res.body) throw new Error(`Could not download the tunnel program (HTTP ${res.status}). Check your internet connection, or set your own public address in Settings.`);
  const tmp = dest + '.download';
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(tmp));
  if (asset.tgz) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-'));
    await execFileP('tar', ['-xzf', tmp, '-C', tmpDir]);
    fs.copyFileSync(path.join(tmpDir, 'cloudflared'), dest);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(tmp, { force: true });
  } else {
    fs.renameSync(tmp, dest);
  }
  if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
  return dest;
}

const URL_RX = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** Open a tunnel to localhost:port. Resolves with the public https address. */
async function start({ binDir, port, log, say }) {
  const bin = await ensureBinary(binDir, say);
  say('Opening a public address for RunPod…');
  const child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let url = '', exited = null;
  const scan = (d) => { log('tunnel', d); const m = URL_RX.exec(String(d)); if (m && !url) url = m[0]; };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  child.on('exit', (code, sig) => { exited = { code, sig }; });
  child.on('error', (e) => { exited = { code: -1 }; log('tunnel', `could not start: ${e.message}`); });
  await waitFor(() => { if (exited) throw new Error('the tunnel program stopped'); return url; }, { timeoutMs: 60_000, everyMs: 300, what: 'the public address' });
  return {
    url,
    onExit: (fn) => child.on('exit', (code, sig) => fn({ code, sig })),
    stop: () => { try { child.kill(); } catch { /* gone */ } },
  };
}

/** The address is announced a few seconds before it resolves everywhere. Returns true once /health answers through it. */
async function reachable(url, { tries = 20 } = {}) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      if (r.ok) return true;
    } catch { /* not yet */ }
    await sleep(1500);
  }
  return false;
}

module.exports = { start, reachable, ensureBinary, assetFor, VERSION, URL_RX };
