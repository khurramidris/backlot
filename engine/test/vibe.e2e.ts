// Vibe flow end to end through the HTTP API, with credits enforced and mock providers:
// subscribe (signed Lemon Squeezy webhooks) → prompt → script/cast/plan → checkpoint → render → finished MP4
// → fix a shot → renewal → top-up → storage quota → project deletion → plan expiry.
//   DATABASE_URL=postgres://postgres@localhost:5432/studio_vibe npx tsx test/vibe.e2e.ts

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

process.env.MOCK_PROVIDERS ??= '1';
process.env.ALLOW_DEV_TOKENS = '1';
process.env.ENFORCE_CREDITS = '1';
process.env.SETUP_FEE_USD = '0.5';
Object.assign(process.env, { SELL_IMAGE_USD: '0.05', SELL_VOICE_USD: '0.05', SELL_BREAKDOWN_USD: '0.5', SELL_PLAN_USD: '0.75', SELL_REVISION_USD: '0.05' });
process.env.SELL_PER_SECOND_768P = '0.1';
process.env.PORT ??= '8802';
const LS_PORT = +process.env.PORT + 100;
Object.assign(process.env, {
  LEMONSQUEEZY_API_KEY: 'ls_test_key', LEMONSQUEEZY_STORE_ID: '1', LEMONSQUEEZY_WEBHOOK_SECRET: 'ls_whsec_test',
  LEMONSQUEEZY_BASIC_VARIANT_ID: '100', LEMONSQUEEZY_API_BASE: `http://localhost:${LS_PORT}`,
  APP_URL: 'https://app.test', CREDIT_PACKS: 'starter:10:201,tiny:0.6:202', PLAN_CREDITS_USD: '20', PLAN_STORAGE_GB: '50',
});
process.env.PUBLIC_BASE_URL ??= `http://localhost:${process.env.PORT}`;
process.env.STORAGE_DIR ??= './data/vibe-files';
process.env.MINIMAX_POLL_SECONDS ??= '1';

const OUT = process.env.E2E_OUT || './data/vibe-out';
const A = 'aaaaaaaa-0000-4000-8000-000000000001', B = 'bbbbbbbb-0000-4000-8000-000000000002', C = 'cccccccc-0000-4000-8000-000000000003';
const ADMIN = 'dddddddd-0000-4000-8000-000000000004';
process.env.ADMIN_USER_IDS = ADMIN;
const base = `http://localhost:${process.env.PORT}`;

// A stand-in for the Lemon Squeezy API: hosted checkouts and subscription lookups (for the customer portal).
const checkouts: any[] = [];
const fakeLs = createServer((req, res) => {
  let raw = '';
  req.on('data', (d) => (raw += d));
  req.on('end', () => {
    res.setHeader('content-type', 'application/vnd.api+json');
    if (req.headers.authorization !== 'Bearer ls_test_key') { res.statusCode = 401; return res.end('{"errors":[{"detail":"bad key"}]}'); }
    if (req.method === 'POST' && req.url === '/v1/checkouts') {
      const b = JSON.parse(raw); checkouts.push(b);
      return res.end(JSON.stringify({ data: { type: 'checkouts', id: 'co_' + checkouts.length, attributes: { url: `https://shop.test/checkout/${checkouts.length}` } } }));
    }
    const m = /^\/v1\/subscriptions\/(\w+)$/.exec(req.url || '');
    if (req.method === 'GET' && m) return res.end(JSON.stringify({ data: { type: 'subscriptions', id: m[1], attributes: { urls: { customer_portal: `https://shop.test/portal/${m[1]}` } } } }));
    res.statusCode = 404; res.end('{"errors":[{"detail":"not found"}]}');
  });
});
await new Promise<void>((r) => fakeLs.listen(LS_PORT, r));

await import('../src/index.js');
const { probe } = await import('../src/media/ffmpeg.js');
const { sql } = await import('../src/db.js');
await new Promise((r) => setTimeout(r, 800));

async function api(uid: string, method: string, path: string, body?: any, expect = [200, 201, 202]) {
  const r = await fetch(base + path, { method, headers: { authorization: `Bearer dev:${uid}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j: any = await r.json().catch(() => ({}));
  if (!expect.includes(r.status)) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j).slice(0, 400)}`);
  return Object.assign(j, { _status: r.status });
}
/** A Lemon Squeezy webhook, signed like the real thing (hex HMAC-SHA256 of the raw body). */
function lsEvent(event: string, owner: string | null, type: string, id: string | number, attributes: any) {
  const body = JSON.stringify({ meta: { event_name: event, ...(owner ? { custom_data: { user_id: owner } } : {}) }, data: { type, id: String(id), attributes: { store_id: 1, ...attributes } } });
  return { body, sig: createHmac('sha256', 'ls_whsec_test').update(body).digest('hex') };
}
async function webhook(e: { body: string; sig: string }) {
  const r = await fetch(`${base}/webhooks/lemonsqueezy`, { method: 'POST', headers: { 'x-signature': e.sig, 'content-type': 'application/json' }, body: e.body });
  return { status: r.status, json: (await r.json()) as any };
}
const future = (days: number) => new Date(Date.now() + days * 86400_000).toISOString();
const subscription = (event: string, owner: string | null, id: number, status: string, extra: any = {}) =>
  webhook(lsEvent(event, owner, 'subscriptions', id, { customer_id: 9000 + id, variant_id: 100, status, renews_at: future(30), ends_at: null, ...extra }));
const invoice = (owner: string | null, id: number, subscriptionId: number, billing_reason = 'initial') =>
  lsEvent('subscription_payment_success', owner, 'subscription-invoices', id, { subscription_id: subscriptionId, status: 'paid', billing_reason, subtotal_usd: 2000, total_usd: 2200 });
const order = (owner: string, id: number, variant: number, subtotal: number) =>
  lsEvent('order_created', owner, 'orders', id, { status: 'paid', subtotal_usd: subtotal, total_usd: subtotal, first_order_item: { variant_id: variant } });

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
const me = (uid: string) => api(uid, 'GET', '/v1/me');
const balance = async (uid: string) => (await me(uid)).balance_usd as number;
const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 0.001, `${what}: ${a} vs ${b}`);
const log = (...a: any[]) => console.log(...a);
await mkdir(OUT, { recursive: true });

log('\n1. A plan is required');
let m = await me(A);
assert.equal(m.plan.active, false); assert.equal(m.balance_usd, 0); assert.equal(m.payments_enabled, true);
const noPlan = await api(A, 'POST', '/v1/create', { prompt: 'A night nurse finds a letter that changes everything.' }, [402]);
assert.equal(noPlan.error.code, 'subscription_required');
assert.equal((await api(A, 'POST', '/v1/billing/topup', { pack: 'starter' }, [402])).error.code, 'subscription_required', 'top-ups are for subscribers');
await api(A, 'GET', '/v1/billing/portal', undefined, [404]);
await api(A, 'GET', '/v1/admin/preflight', undefined, [404]); // the setup check is for admins only
const co = await api(A, 'POST', '/v1/billing/subscribe', {});
assert.match(co.url, /^https:\/\/shop\.test\/checkout\//);
const sent = checkouts.at(-1).data;
assert.equal(sent.attributes.checkout_data.custom.user_id, A, 'the owner rides along to the webhook');
assert.equal(sent.relationships.variant.data.id, '100'); assert.equal(sent.relationships.store.data.id, '1');
assert.equal(sent.attributes.product_options.redirect_url, 'https://app.test/billing?paid=1');
log('  ✓ creating without a plan is refused (402); subscribe opens a hosted checkout for this user');

log('\n2. Subscribe (Lemon Squeezy webhooks)');
const created = lsEvent('subscription_created', A, 'subscriptions', 501, { status: 'active', variant_id: 100, customer_id: 9501, renews_at: future(30) });
assert.equal((await webhook({ body: created.body, sig: 'forged' })).status, 400, 'forged signature rejected');
assert.equal((await webhook(lsEvent('subscription_created', A, 'subscriptions', 999, { status: 'active', store_id: 2 }))).json.ignored, 'another store');
assert.equal((await webhook(created)).status, 200);
m = await me(A);
assert.equal(m.plan.active, true); assert.equal(m.plan.status, 'active'); assert.ok(m.plan.renews_at);
near(m.credits.plan, 0, 'no credit until the invoice is paid');
const inv1 = invoice(A, 7001, 501);
assert.equal((await webhook(inv1)).json.plan_credit, 20);
assert.equal((await webhook(inv1)).json.duplicate, true, 'replayed invoice is ignored');
m = await me(A);
near(m.credits.plan, 20, 'plan credit after the first invoice'); near(m.credits.topup, 0, 'no top-up yet');
assert.equal((await api(A, 'GET', '/v1/billing/portal')).url, 'https://shop.test/portal/501');
assert.equal((await api(A, 'POST', '/v1/billing/subscribe', {}, [409])).error.code, 'conflict', 'no second subscription');
log('  ✓ subscription active with $20 of plan credit; forged, foreign and replayed webhooks do nothing; portal link works');

log('\n2b. Top-up pack');
const tu = await api(A, 'POST', '/v1/billing/topup', { pack: 'starter' });
assert.match(tu.url, /checkout/); assert.equal(checkouts.at(-1).data.relationships.variant.data.id, '201');
await api(A, 'POST', '/v1/billing/topup', { pack: 'nope' }, [400]);
const o1 = order(A, 8001, 201, 1000);
assert.equal((await webhook(o1)).json.credited, 10);
assert.equal((await webhook(o1)).json.duplicate, true);
assert.match((await webhook(order(A, 8002, 100, 2000))).json.ignored, /plan order/, 'the plan order is credited by its invoice instead');
m = await me(A);
near(m.credits.plan, 20, 'plan credit unchanged'); near(m.credits.topup, 10, 'top-up credited once');
log('  ✓ top-up adds $10 that never expires; replays and plan orders add nothing');

log('\n3. Prompt → script, cast, sets, shot plan');
await api(A, 'POST', '/v1/create', { prompt: 'short' }, [400]);
const { project } = await api(A, 'POST', '/v1/create', { prompt: 'A night nurse finds a letter that changes everything.', format: 'microdrama' });
const pid = project.id;
m = await me(A);
near(m.credits.plan, 19.5, 'setup fee comes out of plan credit first'); near(m.credits.topup, 10, 'top-up untouched');
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
near(await balance(A), 29.5 - priceAtReady, 'charged exactly the quoted render price');
m = await me(A);
assert.ok(m.storage.used_bytes > mp4.length, `storage counts the takes, cut and references (${m.storage.used_bytes} bytes)`);
assert.equal(m.storage.quota_bytes, 50 * 1024 ** 3);
const [{ n: tracked }] = await sql`select count(*)::int n from files where project_id = ${pid}`;
log(`  ✓ ${info.duration.toFixed(1)}s ${info.width}×${info.height} MP4 with audio; charged $${priceAtReady}; ${tracked} files, ${(m.storage.used_bytes / 1e6).toFixed(1)} MB counted`);

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
near(await balance(A), before - fixed.duration * 0.1 - 0.05, 'retake charged for one shot plus the rewrite from the note');
log(`  ✓ retake used in a new cut; charged $${(fixed.duration * 0.1).toFixed(2)} for the render and $0.05 for the rewrite`);

log('\n7. Guards');
const ep = d.episodes[0].id;
const inj = await api(A, 'POST', `/v1/episodes/${ep}/cuts`, { kind: 'preview', options: { loudness: '-14[a];amovie=/etc/passwd' } }, [400]);
assert.match(inj.error.message, /Invalid cut options/);
await api(A, 'POST', `/v1/episodes/${ep}/cuts`, { kind: 'preview', options: { music_key: 'projects/00000000-0000-0000-0000-000000000000/music/1.mp3' } }, [400]);
await api(A, 'POST', `/v1/shots/${fix.id}/render`, { resolution: '4K' }, [400]);
log('  ✓ filter injection, foreign music and bad resolutions are rejected');

log('\n8. Renewal resets plan credit');
const beforeRenewal = await me(A);
assert.ok(beforeRenewal.credits.plan < 20 && beforeRenewal.credits.plan > 0, 'some plan credit was spent');
assert.equal((await webhook(invoice(null, 7002, 501, 'renewal'))).json.plan_credit, 20, 'owner found through the subscription id');
m = await me(A);
near(m.credits.plan, 20, 'renewal resets plan credit to $20 (not added on top)'); near(m.credits.topup, 10, 'top-ups never expire');
assert.ok(m.recent.some((e: any) => e.reason === 'plan_expired' && Math.abs(e.delta_usd + beforeRenewal.credits.plan) < 0.001), 'unused plan credit expired in the ledger');
log(`  ✓ $${beforeRenewal.credits.plan.toFixed(2)} unused plan credit expired, $20 granted; $10 top-up kept`);

log('\n8b. Everything after the first pass is charged');
const waitJob = async (uid: string, id: number) => { for (let i = 0; i < 120; i++) { const j = (await api(uid, 'GET', `/v1/jobs/${id}`)).job; if (j.status === 'done' || j.status === 'failed') return j; await new Promise((r) => setTimeout(r, 500)); } throw new Error('job timeout'); };
const ledger = async (uid: string, reason: string) => (await me(uid)).recent.filter((e: any) => e.reason === reason);
const charName = (await api(A, 'GET', `/v1/projects/${pid}/assets`)).assets.find((x: any) => x.kind === 'character');
let b0 = await balance(A);
let g = await api(A, 'POST', `/v1/assets/${charName.id}/generate`, {});
assert.equal((await waitJob(A, g.job_id)).status, 'done');
near(await balance(A), b0 - 0.05, 'regenerating a character image costs $0.05');
assert.equal((await ledger(A, 'image_gen')).length, 1, 'ledger shows the image charge');
// failed work is refunded
await api(A, 'PATCH', `/v1/assets/${charName.id}`, { prompt_override: '__fail__' });
b0 = await balance(A);
g = await api(A, 'POST', `/v1/assets/${charName.id}/generate`, {});
assert.equal((await waitJob(A, g.job_id)).status, 'failed');
near(await balance(A), b0, 'a failed generation is refunded in full');
assert.ok((await ledger(A, 'refund')).some((e: any) => e.delta_usd > 0 && Math.abs(e.delta_usd - 0.05) < 1e-6), 'refund in the ledger');
await api(A, 'PATCH', `/v1/assets/${charName.id}`, { prompt_override: '' });
// studio steps: re-running the breakdown costs $0.50
b0 = await balance(A);
g = await api(A, 'POST', `/v1/projects/${pid}/breakdown`, { force: true });
assert.equal((await waitJob(A, g.job_id)).status, 'done');
near(await balance(A), b0 - 0.5, 'running the breakdown again costs $0.50');
log('  ✓ image regeneration, breakdown and shot rewrites are charged; failures are refunded');

log('\n9. Storage quota and deleting a project');
const dir = join(process.env.STORAGE_DIR!, 'projects', pid);
assert.ok((await stat(dir)).isDirectory(), 'project files on disk');
await sql`insert into files (key, project_id, owner_id, bytes) values (${`projects/${pid}/huge.bin`}, ${pid}, ${A}, ${Math.round(50.3 * 1024 ** 3)})`;
const full = await api(A, 'POST', '/v1/create', { prompt: 'A lighthouse keeper receives a letter from the future.' }, [402]);
assert.equal(full.error.code, 'storage_full'); assert.match(full.error.message, /using 50\.3 of 50 GB/);
await api(A, 'POST', `/v1/shots/${fix.id}/retake`, { note: 'x' }, [402]);
await api(A, 'DELETE', `/v1/projects/${pid}`);
const [{ n: left }] = await sql`select count(*)::int n from files where project_id = ${pid}`;
assert.equal(left, 0, 'file rows removed');
await assert.rejects(stat(dir), 'files removed from storage');
assert.equal((await me(A)).storage.used_bytes, 0, 'storage freed');
log('  ✓ over quota → 402 storage_full with a clear message; deleting the project frees its files and rows');

log('\n10. Not enough credit to render');
await subscription('subscription_created', C, 502, 'active'); // subscribed, first invoice not paid yet
await webhook(order(C, 8003, 202, 60));
near((await me(C)).credits.topup, 0.6, 'tiny top-up');
const { project: pc } = await api(C, 'POST', '/v1/create', { prompt: 'Two rivals share a taxi in the rain.', format: 'microdrama' });
await waitStage(C, pc.id, 'ready');
const refused = await api(C, 'POST', `/v1/projects/${pc.id}/produce`, {}, [402]);
assert.equal(refused.error.code, 'insufficient_credit');
near(await balance(C), 0.1, 'nothing charged when the render is refused');
log('  ✓ render refused up front with a clear price; nothing charged');
// …and so is everything else they can't afford, with nothing charged
const tiny = await balance(C);
assert.ok(tiny < 0.5);
assert.equal((await api(C, 'POST', `/v1/projects/${pc.id}/breakdown`, { force: true }, [402])).error.code, 'insufficient_credit');
near(await balance(C), tiny, 'nothing charged when refused');
const charC = (await api(C, 'GET', `/v1/projects/${pc.id}/assets`)).assets.find((x: any) => x.kind === 'character');
await api(C, 'POST', `/v1/assets/${charC.id}/generate`, {}); // $0.05 of the $0.10 left
await new Promise((r) => setTimeout(r, 1500));
await api(C, 'POST', `/v1/assets/${charC.id}/generate`, {}); // the other $0.05
await new Promise((r) => setTimeout(r, 1500));
assert.equal((await api(C, 'POST', `/v1/assets/${charC.id}/generate`, {}, [402])).error.code, 'insufficient_credit', 'out of credit: stopped before any work starts');
log('  ✓ unaffordable work is refused up front, with a clear message');

log('\n10a. "Try again" after casting failed');
// What a failed casting pass leaves: a main character that still couldn't be designed after its automatic retry.
const castC = (await api(C, 'GET', `/v1/projects/${pc.id}/assets`)).assets.find((x: any) => x.kind === 'character');
await sql`update assets set status = 'failed', error = 'image service unavailable' where id = ${castC.id}`;
await sql`update projects set stage = 'failed', stage_error = '1 of the main characters and sets could not be designed. Please try again.',
  autopilot = autopilot || ${sql.json({ failed_stage: 'casting', retried_assets: [castC.id] })} where id = ${pc.id}`;
const beforeRetry = await balance(C);
assert.equal((await api(C, 'POST', `/v1/projects/${pc.id}/resume`, {})).stage, 'casting');
await waitStage(C, pc.id, 'ready');
assert.equal((await api(C, 'GET', `/v1/assets/${castC.id}`)).asset.status, 'approved', 'the failed character was designed again and locked');
near(await balance(C), beforeRetry, 'nothing charged: the first pass is covered by the setup fee');
log('  ✓ "Try again" designs the failed character again and returns to the checkpoint');

log('\n10b. Admin console');
await api(C, 'GET', '/v1/admin/overview', undefined, [404]);
await api(C, 'GET', `/v1/admin/customers/${C}`, undefined, [404]);
const ov = await api(ADMIN, 'GET', '/v1/admin/overview');
assert.ok(ov.people.accounts >= 2 && ov.subscriptions.paying >= 2, 'overview counts customers and paying plans');
assert.ok(ov.payments_7d.n >= 1, 'payments counted');
assert.equal((await api(ADMIN, 'GET', `/v1/admin/customers?q=${C}`)).customers[0].owner_id, C, 'search by user id');
const cd = await api(ADMIN, 'GET', `/v1/admin/customers/${C}`);
assert.equal(cd.plan.active, true); assert.ok(cd.projects.length === 1 && cd.credit_events.length > 0);
await api(ADMIN, 'POST', `/v1/admin/customers/${C}/credit`, { usd: 5 }, [400]); // a note is required
near((await api(ADMIN, 'POST', `/v1/admin/customers/${C}/credit`, { usd: 5, note: 'beta goodwill' })).credits.topup, 5, 'admin grant (their last 10 cents went on regenerations)');
near((await api(ADMIN, 'POST', `/v1/admin/customers/${C}/credit`, { usd: -10, note: 'correction' })).credits.topup, 0, 'deduction never goes below zero');
assert.ok((await me(C)).recent.some((e: any) => e.reason === 'admin_grant'), 'grant shows in the customer’s history');
log('  ✓ admins see the overview and customers and can adjust credit; customers can’t reach any of it');

log('\n11. Cancel, then expiry');
await subscription('subscription_cancelled', A, 501, 'cancelled', { ends_at: future(10) });
m = await me(A);
assert.equal(m.plan.status, 'cancelled'); assert.equal(m.plan.active, true, 'access continues until the paid period ends');
await subscription('subscription_expired', null, 501, 'expired', { ends_at: future(-1) });
m = await me(A);
assert.equal(m.plan.active, false); near(m.credits.plan, 0, 'plan credit gone'); near(m.credits.topup, 10.05, 'top-up kept (plus the 5-cent refund of the failed image, which never expires)');
assert.equal((await api(A, 'POST', '/v1/create', { prompt: 'A lighthouse keeper receives a letter from the future.' }, [402])).error.code, 'subscription_required');
log('  ✓ cancelled plans work until they end; an expired plan blocks creating and clears plan credit');

log('\nALL VIBE CHECKS PASSED');
process.exit(0);
