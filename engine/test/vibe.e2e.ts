// Vibe flow end to end through the HTTP API, with credits enforced and mock providers:
// pay (signed Stripe webhook) → prompt → script/cast/plan → checkpoint → render → finished MP4 → fix a shot.
//   DATABASE_URL=postgres://postgres@localhost:5432/studio_vibe npx tsx test/vibe.e2e.ts

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';

process.env.MOCK_PROVIDERS ??= '1';
process.env.ALLOW_DEV_TOKENS = '1';
process.env.ENFORCE_CREDITS = '1';
process.env.SETUP_FEE_USD = '0.5';
process.env.SELL_PER_SECOND_768P = '0.1';
process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.PORT ??= '8802';
process.env.PUBLIC_BASE_URL ??= `http://localhost:${process.env.PORT}`;
process.env.STORAGE_DIR ??= './data/vibe-files';
process.env.MINIMAX_POLL_SECONDS ??= '1';

const OUT = process.env.E2E_OUT || './data/vibe-out';
const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002', C = 'cccccccc-0000-4000-8000-000000000003';
const base = `http://localhost:${process.env.PORT}`;

await import('../src/index.js');
const { probe } = await import('../src/media/ffmpeg.js');
await new Promise((r) => setTimeout(r, 800));

async function api(uid: string, method: string, path: string, body?: any, expect = [200, 201, 202]) {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer dev:${uid}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json().catch(() => ({}));
  if (!expect.includes(r.status)) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j).slice(0, 400)}`);
  return Object.assign(j, { _status: r.status });
}
function stripeEvent(owner: string, cents: number, session: string) {
  const body = JSON.stringify({ id: `evt_${session}`, type: 'checkout.session.completed', data: { object: { id: session, payment_status: 'paid', currency: 'usd', amount_subtotal: cents, amount_total: cents, client_reference_id: owner, metadata: { owner_id: owner } } } });
  const t = Math.floor(Date.now() / 1000);
  return { body, sig: `t=${t},v1=${createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex')}` };
}
async function webhook(body: string, sig: string) {
  const r = await fetch(`${base}/webhooks/stripe`, { method: 'POST', headers: { 'stripe-signature': sig, 'content-type': 'application/json' }, body });
  return { status: r.status, json: (await r.json()) as any };
}
async function waitStage(uid: string, pid: string, want: string, timeout = 600_000) {
  const t0 = Date.now();
  for (let last = ''; ;) {
    const d = await api(uid, 'GET', `/v1/projects/${pid}`);
    const stage = d.project.stage;
    const progress = d.jobs.find((j: any) => j.kind === 'project.autopilot')?.progress || '';
    if (`${stage}|${progress}` !== last) { last = `${stage}|${progress}`; console.log(`    · ${stage}${progress ? ` — ${progress}` : ''}`); }
    if (stage === want) { console.log(`  ✓ ${want} (${((Date.now() - t0) / 1000).toFixed(1)}s)`); return d; }
    if (stage === 'failed') throw new Error(`autopilot failed: ${d.project.stage_error}`);
    if (Date.now() - t0 > timeout) throw new Error(`timeout waiting for ${want}; stage ${stage}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
const balance = async (uid: string) => (await api(uid, 'GET', '/v1/me')).balance_usd as number;
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 0.001, `${what}: ${a} vs ${b}`);
const log = (...a: any[]) => console.log(...a);
await mkdir(OUT, { recursive: true });

log('\n1. Credits are enforced');
assert.equal(await balance(A), 0);
const noMoney = await api(A, 'POST', '/v1/create', { prompt: 'A night nurse finds a letter that changes everything.' }, [402]);
assert.equal(noMoney.error.code, 'insufficient_credit');
log('  ✓ creating without credit is refused (402)');

log('\n2. Stripe top-up');
const evt = stripeEvent(A, 1000, 'cs_test_a1');
assert.equal((await webhook(evt.body, 't=1,v1=forged')).status, 400, 'forged signature rejected');
assert.equal((await webhook(evt.body, evt.sig)).json.credited, 10);
assert.equal((await webhook(evt.body, evt.sig)).json.duplicate, true, 'replayed webhook is ignored');
near(await balance(A), 10, 'balance after one $10 purchase');
log('  ✓ signed webhook credits once; forged and replayed webhooks do nothing');

log('\n3. Prompt → script, cast, sets, shot plan');
await api(A, 'POST', '/v1/create', { prompt: 'short' }, [400]);
const { project } = await api(A, 'POST', '/v1/create', { prompt: 'A night nurse finds a letter that changes everything.', format: 'microdrama' });
const pid = project.id;
near(await balance(A), 9.5, 'setup fee taken');
let d = await waitStage(A, pid, 'ready');
assert.ok(d.episodes.length === 1 && d.episodes[0].shots > 0, 'episode planned into shots');
assert.ok(d.render_price_usd > 0, 'render price shown at the checkpoint');
const { assets } = await api(A, 'GET', `/v1/projects/${pid}/assets`);
assert.ok(assets.filter((a: any) => !a.meta?.unused).every((a: any) => a.status === 'approved'), 'cast and sets locked automatically');
const priceAtReady = d.render_price_usd;
log(`  ✓ "${d.project.title}": ${d.episodes[0].shots} shots, ${assets.length} locked references, render price $${priceAtReady}`);

log('\n4. Isolation');
await api(B, 'GET', `/v1/projects/${pid}`, undefined, [404]);
await api(B, 'POST', `/v1/projects/${pid}/produce`, {}, [404]);
log('  ✓ another user cannot see or render this project');

log('\n5. Render → finished video');
const go = await api(A, 'POST', `/v1/projects/${pid}/produce`, {});
near(go.price_usd, priceAtReady, 'produce price matches the checkpoint');
await api(A, 'POST', `/v1/projects/${pid}/produce`, {}, [409]);
d = await waitStage(A, pid, 'done');
assert.equal(d.latest_cuts.length, 1);
const cut = d.latest_cuts[0];
assert.equal(cut.status, 'done'); assert.equal(cut.kind, 'final', 'every shot rendered, so the cut is final');
const mp4 = Buffer.from(await (await fetch(cut.url)).arrayBuffer());
await writeFile(`${OUT}/vibe-episode-1.mp4`, mp4);
const info = await probe(`${OUT}/vibe-episode-1.mp4`);
assert.ok(info.duration > 5 && info.has_audio && info.width > 0, 'playable MP4 with sound');
near(await balance(A), 9.5 - priceAtReady, 'charged exactly the quoted render price');
log(`  ✓ ${info.duration.toFixed(1)}s ${info.width}×${info.height} MP4 with audio; charged $${priceAtReady}`);

log('\n6. Fix one shot → rebuilt episode');
const { shots } = await api(A, 'GET', `/v1/episodes/${d.episodes[0].id}/shots`);
const fix = shots[1] || shots[0];
const before = await balance(A);
await api(A, 'POST', `/v1/shots/${fix.id}/retake`, { note: 'she should hesitate before opening the door', recut: true });
d = await waitStage(A, pid, 'done');
assert.notEqual(d.latest_cuts[0].id, cut.id, 'a new cut was made');
assert.equal(d.latest_cuts[0].status, 'done');
const { shots: after } = await api(A, 'GET', `/v1/episodes/${d.episodes[0].id}/shots`);
const fixed = after.find((s: any) => s.id === fix.id);
assert.equal(fixed.approved_take_id, fixed.takes[fixed.takes.length - 1].id, 'the new take is used');
near(await balance(A), before - fixed.duration * 0.1, 'retake charged for one shot');
log(`  ✓ retake used in a new cut; charged $${(fixed.duration * 0.1).toFixed(2)}`);

log('\n7. Guards');
const ep = d.episodes[0].id;
const inj = await api(A, 'POST', `/v1/episodes/${ep}/cuts`, { kind: 'preview', options: { loudness: '-14[a];amovie=/etc/passwd' } }, [400]);
assert.match(inj.error.message, /Invalid cut options/);
await api(A, 'POST', `/v1/episodes/${ep}/cuts`, { kind: 'preview', options: { music_key: 'projects/00000000-0000-0000-0000-000000000000/music/1.mp3' } }, [400]);
await api(A, 'POST', `/v1/shots/${fix.id}/render`, { resolution: '4K' }, [400]);
log('  ✓ filter injection, foreign music and bad resolutions are rejected');

log('\n8. Not enough credit to render');
const small = stripeEvent(C, 60, 'cs_test_c1');
await webhook(small.body, small.sig);
const { project: pc } = await api(C, 'POST', '/v1/create', { prompt: 'Two rivals share a taxi in the rain.', format: 'microdrama' });
await waitStage(C, pc.id, 'ready');
const refused = await api(C, 'POST', `/v1/projects/${pc.id}/produce`, {}, [402]);
assert.equal(refused.error.code, 'insufficient_credit');
near(await balance(C), 0.1, 'nothing charged when the render is refused');
log('  ✓ render refused up front with a clear price; nothing charged');

log('\nALL VIBE CHECKS PASSED');
process.exit(0);
