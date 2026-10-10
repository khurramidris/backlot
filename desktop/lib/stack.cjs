// The whole studio, started in order: database → (tunnel) → engine. Knows nothing about windows.

const path = require('node:path');
const fs = require('node:fs');
const { engineEnv } = require('./settings.cjs');
const { freePort } = require('./util.cjs');
const pgModule = require('./postgres.cjs');
const tunnelModule = require('./tunnel.cjs');
const engineModule = require('./engine.cjs');

function resolvePaths({ isPackaged, resourcesPath, appPath }) {
  const repo = path.resolve(appPath, '..');
  const engineDir = isPackaged ? path.join(resourcesPath, 'engine') : fs.existsSync(path.join(appPath, 'stage', 'engine')) ? path.join(appPath, 'stage', 'engine') : path.join(repo, 'engine');
  const webDir = isPackaged ? path.join(resourcesPath, 'web') : fs.existsSync(path.join(appPath, 'stage', 'web')) ? path.join(appPath, 'stage', 'web') : path.join(repo, 'web', 'dist');
  const fontsDir = path.join(appPath, 'assets', 'fonts');
  return { engineDir, webDir, fontsDir, fontFile: path.join(fontsDir, 'DejaVuSans-Bold.ttf') };
}

function mediaTools() {
  return { ffmpeg: require('ffmpeg-static'), ffprobe: require('@ffprobe-installer/ffprobe').path };
}

/**
 * Creates the stack controller. `say(msg, step)` reports progress to whatever shows it.
 * The database stays up between restarts; the tunnel and engine are restarted when settings change.
 */
function create({ dataDir, paths, execPath, settings, log, say, tunnelImpl = tunnelModule, pgImpl = pgModule, engineImpl = engineModule, tools = mediaTools }) {
  let pg = null, tunnel = null, engine = null, current = null, stopping = false;
  const state = { url: '', publicUrl: '', tunnelOk: null, mode: '' };

  async function stopEngineAndTunnel() {
    const e = engine, t = tunnel;
    engine = tunnel = null;
    if (t) t.stop();
    if (e) await e.stop();
  }

  async function start() {
    stopping = false;
    const s = settings.load();
    state.mode = s.mode;
    state.tunnelOk = null; state.publicUrl = '';
    const miss = settings.missing(s);
    if (miss) throw new Error(`Settings are incomplete: Backlot still needs ${miss}. Open Settings to add it, or switch to demo mode.`);

    if (!pg) { say('Starting the database…', 'database'); pg = await pgImpl.start({ dir: dataDir, log }); }
    const port = await freePort(0);

    let publicBaseUrl = '';
    if (s.mode === 'real' && s.videoProvider === 'runpod') {
      if (s.publicUrl) publicBaseUrl = s.publicUrl;
      else {
        say('Opening a public address so RunPod can reach this computer…', 'tunnel');
        try {
          tunnel = await tunnelImpl.start({ binDir: path.join(dataDir, 'bin'), port, log, say: (m) => say(m, 'tunnel') });
        } catch (e) {
          log('app', `tunnel failed: ${e.message}`);
          throw new Error(`Could not open the public address RunPod needs (${e.message}). Check your internet connection and try again, or enter your own public address in Settings.`);
        }
        publicBaseUrl = tunnel.url;
      }
    }

    const t = tools();
    const env = engineEnv(s, {
      port, databaseUrl: pg.url, storageDir: path.join(dataDir, 'files'), webDir: paths.webDir,
      ffmpeg: t.ffmpeg, ffprobe: t.ffprobe, fontFile: paths.fontFile, fontsDir: paths.fontsDir, publicBaseUrl,
    });
    say('Starting the studio…', 'engine');
    try {
      engine = await engineImpl.start({ execPath, engineDir: paths.engineDir, env, port, log });
    } catch (e) { await stopEngineAndTunnel(); throw e; }
    state.url = engine.url; state.publicUrl = publicBaseUrl;

    if (publicBaseUrl && tunnel) {
      say('Checking RunPod can reach you…', 'tunnel');
      state.tunnelOk = await tunnelImpl.reachable(publicBaseUrl);
      if (!state.tunnelOk) log('app', `public address ${publicBaseUrl} did not answer /health yet`);
      tunnel.onExit((x) => { if (!stopping) { log('app', `tunnel exited ${JSON.stringify(x)}`); current && current.onProblem && current.onProblem('The public address closed, so RunPod can no longer reach this computer. Use Tools → Restart studio to get a new one.'); } });
    }
    engine.onExit((x) => { if (!stopping) { log('app', `engine exited ${JSON.stringify(x)}`); current && current.onProblem && current.onProblem('The studio stopped unexpectedly. Use Tools → Restart studio. Your work is saved.'); } });
    return { url: state.url, publicUrl: state.publicUrl, tunnelOk: state.tunnelOk };
  }

  return {
    state,
    /** Call once; `hooks.onProblem(message)` reports a crash after a successful start. */
    async run(hooks = {}) { current = hooks; return start(); },
    async restart() { stopping = true; await stopEngineAndTunnel(); return start(); },
    async stop() { stopping = true; await stopEngineAndTunnel(); if (pg) { const p = pg; pg = null; await p.stop(); } },
  };
}

module.exports = { create, resolvePaths };
