// End-to-end run through the public API: import → breakdown → assets → approve → plan →
// render → review/retake → approve → final cut. Uses mock providers unless real keys are set
// and MOCK_PROVIDERS=0 is passed explicitly.
//   DATABASE_URL=postgres://postgres@localhost:5432/studio npx tsx test/e2e.ts

import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';

process.env.MOCK_PROVIDERS ??= '1';
process.env.ALLOW_DEV_TOKENS = '1';
process.env.PORT ??= '8799';
process.env.PUBLIC_BASE_URL ??= `http://localhost:${process.env.PORT}`;
process.env.STORAGE_DIR ??= './data/e2e-files';
process.env.MINIMAX_POLL_SECONDS ??= '1';

const FIXTURE = process.argv[2] || 'test/fixtures/eleventh-refill.reelwright.json';
const OUT = process.env.E2E_OUT || './data/e2e-out';
const UID = '11111111-2222-3333-4444-555555555555';
const base = `http://localhost:${process.env.PORT}`;

await import('../src/index.js');
await new Promise((r) => setTimeout(r, 800));

async function api(method: string, path: string, body?: any, expect = [200, 201, 202]) {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer dev:${UID}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json().catch(() => ({}));
  if (!expect.includes(r.status)) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j).slice(0, 400)}`);
  return Object.assign(j, { _status: r.status });
}
const seenFail = new Set<number>();
async function waitJobs(pid: string, label: string, timeout = 300_000) {
  const t0 = Date.now();
  for (;;) {
    const d = await api('GET', `/v1/projects/${pid}`);
    const active = d.jobs.filter((j: any) => j.status === 'queued' || j.status === 'running');
    const failed = d.jobs.filter((j: any) => j.status === 'failed');
    for (const j of failed) if (!seenFail.has(j.id)) { seenFail.add(j.id); console.log(`  ! job failed (expected only for the refusal test): ${j.kind}: ${String(j.error).slice(0, 120)}`); }
    if (!active.length) { console.log(`  ✓ ${label} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); return d; }
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${label}: ${active.map((j: any) => j.kind + ' ' + j.progress).join(', ')}`);
    await new Promise((r) => setTimeout(r, 700));
  }
}

const log = (...a: any[]) => console.log(...a);
await mkdir(OUT, { recursive: true });

// 0) Auth is enforced.
const anon = await fetch(base + '/v1/projects');
assert.equal(anon.status, 401, 'unauthenticated request must be rejected');

// 1) Import.
log('\n1. Import Reelwright project');
const fixture = JSON.parse(await readFile(FIXTURE, 'utf8'));
const { project } = await api('POST', '/v1/projects', fixture);
const pid = project.id;
log(`  project ${pid} · ${project.title} · ${project.aspect}`);
await waitJobs(pid, 'breakdown');

// 2) Breakdown result.
log('\n2. Breakdown');
let { assets } = await api('GET', `/v1/projects/${pid}/assets`);
const by = (k: string) => assets.filter((a: any) => a.kind === k);
for (const k of ['character', 'look', 'voice', 'location', 'set_variant', 'prop']) log(`  ${k.padEnd(12)} ${by(k).map((a: any) => `${a.key}${a.recurring ? '*' : ''}(${a.appearances})`).join(', ')}`);
const { scenes } = await api('GET', `/v1/projects/${pid}/scenes`);
log(`  scenes: ${scenes.length}; every scene has a set: ${scenes.every((s: any) => s.location_asset_id)}`);
assert.ok(scenes.length >= 10, 'expected at least 10 scenes');
assert.ok(scenes.every((s: any) => s.location_asset_id), 'every scene must map to a set');
assert.ok(by('character').length >= 3 && by('location').length >= 3, 'characters and sets found');
assert.ok(by('location').some((a: any) => a.recurring), 'at least one recurring set');

// 3) Assets: generate, then approve (looks/variants wait for their parents).
log('\n3. Generate and approve assets');
const final = await api('POST', '/v1/projects/:pid/assets/generate'.replace(':pid', pid), {});
log(`  queued ${final.queued}`);
await waitJobs(pid, 'asset generation');
({ assets } = await api('GET', `/v1/projects/${pid}/assets`));
const notReady = assets.filter((a: any) => !a.meta?.unused && a.status !== 'review');
assert.equal(notReady.length, 0, 'all assets ready for review: ' + notReady.map((a: any) => a.key + ':' + a.status + ':' + a.error).join(', '));
// Regenerate one with a note, restore the first version, then approve everything.
const ch = by('character')[0];
await api('POST', `/v1/assets/${ch.id}/generate`, { note: 'softer light, looks more tired' });
await waitJobs(pid, 'regenerate one asset');
const hist = await api('GET', `/v1/assets/${ch.id}`);
assert.equal(hist.history.length, 1, 'previous version kept in history');
const ap = await api('POST', `/v1/projects/${pid}/assets/approve-all`);
log(`  approved ${ap.approved}`);
await waitJobs(pid, 'children refreshed after approval');
await api('POST', `/v1/projects/${pid}/assets/approve-all`);
({ assets } = await api('GET', `/v1/projects/${pid}/assets`));
assert.ok(assets.filter((a: any) => !a.meta?.unused).every((a: any) => a.status === 'approved'), 'all assets approved');
// Consent is required to upload a real face.
const up = await fetch(`${base}/v1/assets/${ch.id}/upload`, { method: 'POST', headers: { authorization: `Bearer dev:${UID}` }, body: (() => { const f = new FormData(); f.append('file', new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }), 'x.png'); return f; })() });
assert.equal(up.status, 400, 'upload of a person without consent is refused');
log('  ✓ consent enforced for real-person uploads');

// 4) Plan + render every episode.
const pd = await api('GET', `/v1/projects/${pid}`);
const episodes = pd.episodes;
log(`\n4. Plan and render ${episodes.length} episodes`);
for (const e of episodes) {
  await api('POST', `/v1/episodes/${e.id}/plan`, {});
  await waitJobs(pid, `plan episode ${e.idx}`);
  let { shots, totals } = await api('GET', `/v1/episodes/${e.id}/shots`);
  log(`  episode ${e.idx}: ${totals.shots} shots, ${totals.seconds}s`);
  for (const s of shots) {
    assert.ok(s.duration >= 4 && s.duration <= 15, `shot ${s.code} duration ${s.duration}`);
    assert.ok(s.asset_ids.length <= 9 && s.voice_ids.length <= 3, 'reference limits');
    const beats = s.plan.beats;
    assert.equal(beats[0].t0, 0); assert.equal(beats[beats.length - 1].t1, s.duration, `beats cover ${s.code}`);
  }
  if (e.idx === 1) await writeFile(`${OUT}/ep1-shot-prompts.txt`, shots.map((s: any) => `── ${s.code} (${s.duration}s) refs:${s.asset_ids.length} voices:${s.voice_ids.length}\n${s.prompt}\n`).join('\n'));

  // Final cut must be refused before approval.
  const early = await api('POST', `/v1/episodes/${e.id}/cuts`, { kind: 'final' }, [409]);
  assert.equal(early.error.code, 'not_approved');

  await api('POST', `/v1/episodes/${e.id}/render`, {});
  await waitJobs(pid, `render episode ${e.idx}`);
  ({ shots } = await api('GET', `/v1/episodes/${e.id}/shots`));
  const bad = shots.filter((s: any) => s.status !== 'review');
  assert.equal(bad.length, 0, 'every shot rendered: ' + bad.map((s: any) => `${s.code}:${s.status}:${s.error}`).join(', '));
  if (e.idx === 1) {
    const req = shots[1].takes[0].request;
    await writeFile(`${OUT}/ep1-shot2-request.json`, JSON.stringify(req, null, 2));
  }

  if (process.env.FAKE_URL && e.idx === 1) {
    // Content refusal path: MiniMax 422 must mark the take, not crash or loop.
    const s0 = shots[0];
    await api('PATCH', `/v1/shots/${s0.id}`, { prompt: s0.prompt + '\nFORCE_SENSITIVE' });
    await api('POST', `/v1/shots/${s0.id}/render`, {});
    await waitJobs(pid, 'sensitive-content refusal');
    const r = await api('GET', `/v1/episodes/${e.id}/shots`);
    const t = r.shots[0].takes[r.shots[0].takes.length - 1];
    assert.equal(t.error_code, 'sensitive_content', 'refused take is labelled');
    assert.equal(r.shots[0].status, 'review', 'shot keeps its earlier good take');
    await api('PATCH', `/v1/shots/${s0.id}`, { prompt: s0.prompt });
    log('  ✓ MiniMax content refusal handled');
    ({ shots } = r);
  }

  // Approve the newest good take of every shot.
  for (const s of shots) { const ok = s.takes.filter((t: any) => t.status === 'succeeded'); await api('POST', `/v1/takes/${ok[ok.length - 1].id}/approve`); }
  // Customer changes their mind on one shot: retake with a note. The approved shot before it is not sent along
  // as a reference video (CHAIN_CLIPS is off): its seconds would be billed as input on every render.
  const target = shots[1] || shots[0];
  await api('POST', `/v1/shots/${target.id}/retake`, { note: 'hold longer on her face before she speaks' });
  await waitJobs(pid, `retake shot ${target.code}`);
  ({ shots } = await api('GET', `/v1/episodes/${e.id}/shots`));
  const again = shots.find((s: any) => s.id === target.id);
  const newest = again.takes[again.takes.length - 1];
  assert.equal(newest.status, 'succeeded', 'retake rendered');
  assert.equal(again.status, 'review', 'retake puts the shot back in review');
  assert.ok(!newest.request.refs.some((r: any) => r.role === 'reference_video'), 'the previous clip is never sent along');
  await api('POST', `/v1/takes/${newest.id}/approve`);

  const { cut } = await api('POST', `/v1/episodes/${e.id}/cuts`, { kind: 'final', options: { burn_subtitles: true } });
  await waitJobs(pid, `assemble episode ${e.idx}`);
  const { cuts } = await api('GET', `/v1/episodes/${e.id}/cuts`);
  const done = cuts.find((c: any) => c.id === cut.id);
  assert.equal(done.status, 'done', 'cut finished: ' + done.error);
  const vid = await fetch(done.url); assert.equal(vid.status, 200);
  const buf = Buffer.from(await vid.arrayBuffer());
  await writeFile(`${OUT}/episode-${e.idx}.mp4`, buf);
  await writeFile(`${OUT}/episode-${e.idx}.srt`, await (await fetch(done.srt_url)).text());
  log(`  ✓ episode ${e.idx}: ${(+done.duration).toFixed(1)}s, ${(buf.length / 1e6).toFixed(1)} MB`);
}

const est = await api('GET', `/v1/projects/${pid}/estimate?resolution=2K`);
log(`\n5. Estimate at 2K: runtime ${est.runtime_seconds}s → $${est.video_full_runtime_once_usd} for one clean render of everything`);
const pf = await api('GET', `/v1/projects/${pid}`);
assert.equal(pf.project.status, 'done');
if (process.env.FAKE_URL) {
  const st = await (await fetch(process.env.FAKE_URL + '/__stats')).json();
  log('\nFake provider stats:', JSON.stringify(st));
  assert.equal(st.violations.length, 0, 'no request broke the documented MiniMax/Anthropic rules');
  assert.ok(st.rate_limited === 1 && st.subject_refs > 0 && st.ref_audio > 0, 'rate-limit retry, identity refs and voice refs all exercised');
  assert.equal(st.ref_video, 0, 'no clip was sent the one before it');
}
log(`\nALL CHECKS PASSED · project ${pid}`);
process.exit(0);
