// Builds what the desktop app carries: the web app and the engine, with the engine's production dependencies.
//   node scripts/prepare.mjs            full build (what installers use)
//   node scripts/prepare.mjs --quick    reuse installed dependencies and only rebuild (daily development)
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(desktop, '..');
const quick = process.argv.includes('--quick');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args, cwd) => {
  console.log(`\n$ npm ${args.join(' ')}   (${cwd.replace(repo, '.')})`);
  const r = spawnSync(npm, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) { console.error('Failed.'); process.exit(r.status || 1); }
};

if (!quick || !existsSync(join(repo, 'web', 'node_modules'))) run(['ci', '--no-audit', '--no-fund'], join(repo, 'web'));
if (!quick || !existsSync(join(repo, 'engine', 'node_modules'))) run(['ci', '--no-audit', '--no-fund'], join(repo, 'engine'));
run(['run', 'build'], join(repo, 'web'));
run(['run', 'build'], join(repo, 'engine'));

const stage = join(desktop, 'stage');
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'engine'), { recursive: true });
for (const d of ['dist', 'db', 'public']) if (existsSync(join(repo, 'engine', d))) cpSync(join(repo, 'engine', d), join(stage, 'engine', d), { recursive: true });
for (const f of ['package.json', 'package-lock.json']) cpSync(join(repo, 'engine', f), join(stage, 'engine', f));
cpSync(join(repo, 'web', 'dist'), join(stage, 'web'), { recursive: true });
run(['ci', '--omit=dev', '--no-audit', '--no-fund'], join(stage, 'engine'));
if (!existsSync(join(desktop, 'node_modules'))) run(['ci', '--no-audit', '--no-fund'], desktop);
console.log('\nReady. Start it with: npm start   (inside desktop/)   Build an installer with: npm run dist');
