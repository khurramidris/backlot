// The vibe flow with video rendered on "RunPod" (test/fake-runpod.ts plays RunPod + the GPU worker):
// clips uploaded straight to our storage, refusals, cancelling on delete, and the warm-pool controller.
//   DATABASE_URL=postgres://postgres@localhost:5432/studio_runpod npx tsx test/runpod.e2e.ts

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const RP = 8812;
process.env.MOCK_PROVIDERS ??= '1'; // Claude and images are mocked; video goes through the RunPod adapter
process.env.ALLOW_DEV_TOKENS = '1';
process.env.VIDEO_PROVIDER = 'runpod';
process.env.RUNPOD_API_KEY = 'rp_test';
process.env.RUNPOD_ENDPOINT_ID = 'ep-test';
process.env.RUNPOD_API_BASE = `http://localhost:${RP}/v2`;
process.env.RUNPOD_REST_BASE = `http://localhost:${RP}/v1`;
process.env.RUNPOD_MANAGE_SCALING = '1';
process.env.RUNPOD_WARM_MINUTES = '0';
process.env.RUNPOD_JOBS_PER_WORKER = '1';
process.env.RUNPOD_MAX_WORKERS = '3';
process.env.RUNPOD_CAPACITY_TICK_SECONDS = '1';
process.env.PORT ??= '8811';
process.env.PUBLIC_BASE_URL ??= `http://localhost:${process.env.PORT}`;
process.env.STORAGE_DIR ??= './data/runpod-files';
process.env.MINIMAX_POLL_SECONDS ??= '1';
const A = 'aaaaaaaa-0000-4000-8000-00000000000a', B = 'bbbbbbbb-0000-4000-8000-00000000000b';
process.env.ADMIN_USER_IDS = A;

const { startFakeRunpod } = await import('./fake-runpod.js');
const fake = await startFakeRunpod(RP);
await import('../src/index.js');
const { probe } = await import('../src/media/ffmpeg.js');
const { sql } = await import('../src/db.js');
const base = `http://localhost:${process.env.PORT}`;
await new Promise((r) => setTimeout(r, 800));

async function api(uid: string, method: string, path: string, body?: any, expect = [200, 201, 202]) {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer dev:${uid}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json().catch(() => ({}));
  if (!expect.includes(r.status)) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j).slice(0, 400)}`);
  return j;
}
async function until<T>(what: string, fn: () => Promise<T | false | null | undefined>, timeout = 300_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) { console.log(`  ✓ ${what} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); return v; }
    if (Date.now() - t0 > timeout) throw new Error(`timeout: ${what}`);
    await new Promise((r) => setTimeout(r, 700));
  }
}
const stage = async (pid: string) => {
  const d = await api(A, 'GET', `/v1/projects/${pid}`);
  if (d.project.stage === 'failed') throw new Error(`failed: ${d.project.stage_error}`);
  return d;
};
const log = (...a: any[]) => console.log(...a);
await mkdir('./data/runpod-out', { recursive: true });

log('\n1. Prompt → film, rendered on RunPod');
const { project } = await api(A, 'POST', '/v1/create', { prompt: 'A lighthouse keeper receives a radio call from her missing brother.', format: 'microdrama' });
await until('ready', async () => (await stage(project.id)).project.stage === 'ready');
await api(A, 'POST', `/v1/projects/${project.id}/produce`, {});
const done = await until('done', async () => { const d = await stage(project.id); return d.project.stage === 'done' && d; });
const cut = done.latest_cuts[0];
const mp4 = Buffer.from(await (await fetch(cut.url)).arrayBuffer());
await writeFile('./data/runpod-out/episode.mp4', mp4);
const info = await probe('./data/runpod-out/episode.mp4');
assert.ok(info.duration > 5 && info.has_audio, 'playable finished episode with sound');
const takes = await sql`select provider, count(*)::int n from takes where project_id = ${project.id} group by provider`;
assert.deepEqual(takes.map((t: any) => t.provider), ['runpod'], 'every take rendered by RunPod');
assert.equal(fake.state.submitted, done.episodes[0].shots, 'one RunPod job per shot');
log(`  ✓ ${info.duration.toFixed(1)}s episode from ${fake.state.submitted} RunPod jobs; clips uploaded straight to our storage`);

log('\n2. Warm-pool controller');
await until('controller scaled back to zero after the renders', async () => fake.state.workersMin.at(-1) === 0);
assert.ok(fake.state.workersMin.includes(3), `raised the floor for a deep queue (history ${fake.state.workersMin.join(',')})`);
assert.ok(fake.state.workersMax.every((m) => m === 3), 'never above the budget cap');
log(`  ✓ workersMin history: ${fake.state.workersMin.join(' → ')} (cap 3)`);
const cap = await api(A, 'GET', '/v1/admin/capacity');
assert.equal(cap.provider, 'runpod'); assert.ok(cap.runpod.jobs && cap.controller.progress.startsWith('workersMin='));
await api(B, 'GET', '/v1/admin/capacity', undefined, [404]);
log('  ✓ admin capacity view works and is hidden from non-admins');

log('\n3. Content refusal');
const { shots } = await api(A, 'GET', `/v1/episodes/${done.episodes[0].id}/shots`);
const s0 = shots[0];
await api(A, 'POST', `/v1/shots/${s0.id}/retake`, { prompt: `${s0.prompt}\nFORCE_SENSITIVE` });
const refused = await until('refused take recorded', async () => {
  const r = await api(A, 'GET', `/v1/episodes/${done.episodes[0].id}/shots`);
  const s = r.shots.find((x: any) => x.id === s0.id); const t = s.takes.at(-1);
  return t.status === 'failed' && { s, t };
});
assert.equal(refused.t.error_code, 'sensitive_content');
assert.equal(refused.s.status, 'review', 'the shot keeps its earlier good take');
log('  ✓ refusal labelled sensitive_content; earlier take kept');

log('\n4. Deleting a project cancels its renders');
fake.state.holdMs = 120_000;
const { project: p2 } = await api(A, 'POST', '/v1/create', { prompt: 'A chess prodigy plays her last game against her grandfather.', format: 'microdrama' });
await until('second project ready', async () => (await stage(p2.id)).project.stage === 'ready');
const before = fake.state.submitted;
await api(A, 'POST', `/v1/projects/${p2.id}/produce`, {});
await until('renders running on RunPod', async () => fake.state.submitted > before && [...fake.state.jobs.values()].some((j) => j.status === 'IN_PROGRESS'));
await api(A, 'DELETE', `/v1/projects/${p2.id}`);
assert.ok(fake.state.cancelled.length > 0, 'running RunPod jobs were cancelled');
log(`  ✓ ${fake.state.cancelled.length} RunPod job(s) cancelled`);

log('\nALL RUNPOD CHECKS PASSED');
fake.close();
process.exit(0);
