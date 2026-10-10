// REST API for the front end (Lovable). Every route is scoped to the signed-in user's projects.

import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { bodyLimit } from 'hono/body-limit';
import { streamSSE } from 'hono/streaming';
import { readFile, stat } from 'node:fs/promises';
import { join, dirname, resolve, sep, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { sql, plain } from './db.js';
import { storage, verifySignature, mimeOf, isLocalStorage, PUT } from './storage.js';
import { requireUser } from './auth.js';
import { enqueue, PermanentError } from './queue.js';
import { createProject } from './pipeline/importer.js';
import { queueAllAssets, approveAsset, uploadAsset } from './pipeline/assets.js';
import { queueRender, refreshEpisodeStatus, mm } from './pipeline/render.js';
import { requestCut } from './pipeline/assemble.js';
import { costOf } from './pipeline/compiler.js';
import { projectSpend } from './usage.js';
import { ensureAccount, balanceOf, balances, settleTake, sellPrice, debit, planOf, requirePlan, requireCredit, storageUsed, storageQuotaBytes } from './billing.js';
import { paymentsEnabled, subscribeCheckout, topupCheckout, portalUrl, verifyLemonSignature, handleLemonEvent } from './lemonsqueezy.js';
import { resolveBrief } from './pipeline/writer.js';
import { startAutopilot } from './pipeline/autopilot.js';
import { endpointHealth } from './providers/runpod.js';
import { preflight } from './preflight.js';
import { admin } from './admin.js';
import { limit } from './ratelimit.js';
import { reportError } from './monitoring.js';

type Env = { Variables: { uid: string; email: string | null } };
export const app = new Hono<Env>();
const here = dirname(fileURLToPath(import.meta.url));
const DEV_USER = '11111111-2222-3333-4444-555555555555';

const tooBig = (c: Context) => c.json({ error: { code: 'too_large', message: 'Request body is too large.' } }, 413);
const jsonLimit = bodyLimit({ maxSize: 2 * 1024 * 1024, onError: tooBig });
const fileLimit = bodyLimit({ maxSize: 30 * 1024 * 1024, onError: tooBig });
const uploadLimit = bodyLimit({ maxSize: 500 * 1024 * 1024, onError: tooBig }); // rendered clips PUT by the GPU worker
app.use('*', (c, next) => (c.req.method === 'PUT' && c.req.path.startsWith('/files/') ? uploadLimit
  : /multipart\/form-data/i.test(c.req.header('content-type') || '') ? fileLimit : jsonLimit)(c, next));

app.use('*', cors({ origin: config.corsOrigins.includes('*') ? '*' : config.corsOrigins, allowHeaders: ['authorization', 'content-type', 'x-engine-key', 'x-user-id'], allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'] }));

app.onError((e: any, c) => {
  const status = e.status || (e instanceof PermanentError ? (e.code === 'not_found' ? 404 : e.code === 'conflict' || e.code === 'not_approved' || e.code === 'bad_state' ? 409 : ['insufficient_credit', 'subscription_required', 'storage_full'].includes(e.code) ? 402 : e.code === 'config' ? 503 : 400) : e.name === 'ZodError' ? 400 : 500);
  if (status >= 500) { console.error('[api]', e); reportError(e, { where: 'api', path: c.req.path, method: c.req.method }); }
  return c.json({ error: { code: e.code || (status === 400 ? 'bad_request' : 'server_error'), message: e.name === 'ZodError' ? 'Invalid request: ' + (e.issues || []).map((i: any) => `${i.path.join('.')} ${i.message}`).join('; ') : e.message, ...(e.missing ? { missing: e.missing } : {}) } }, status);
});

app.get('/health', async (c) => { await sql`select 1`; return c.json({ ok: true, mock: config.mock }); });

// Signed file access for local storage (S3 storage hands out presigned URLs instead).
// Local storage only: the GPU worker uploads a rendered clip to a signed upload link.
app.put('/files/*', async (c) => {
  const key = decodeURI(c.req.path.slice('/files/'.length));
  if (!isLocalStorage) return c.text('not found', 404);
  if (!verifySignature(PUT + key, +(c.req.query('exp') || 0), c.req.query('sig') || '')) return c.text('link expired or invalid', 403);
  await storage.put(key, Buffer.from(await c.req.arrayBuffer()), c.req.header('content-type') || mimeOf(key));
  return c.body(null, 200);
});

app.get('/files/*', async (c) => {
  const key = decodeURI(c.req.path.slice('/files/'.length));
  if (!verifySignature(key, +(c.req.query('exp') || 0), c.req.query('sig') || '')) return c.text('link expired or invalid', 403);
  if (!isLocalStorage || !(await storage.exists(key))) return c.text('not found', 404);
  const data = await storage.get(key);
  const range = c.req.header('range');
  const headers: Record<string, string> = { 'content-type': mimeOf(key), 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600' };
  if (range) { // video scrubbing in browsers needs byte ranges
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m && m[1] ? +m[1] : 0, end = m && m[2] ? Math.min(+m[2], data.length - 1) : data.length - 1;
    return new Response(new Uint8Array(data.subarray(start, end + 1)), { status: 206, headers: { ...headers, 'content-range': `bytes ${start}-${end}/${data.length}`, 'content-length': String(end - start + 1) } });
  }
  return new Response(new Uint8Array(data), { headers: { ...headers, 'content-length': String(data.length) } });
});

// Lemon Squeezy calls this for subscription and order events. Authenticated by its signature, not a user session.
app.post('/webhooks/lemonsqueezy', async (c) => {
  const raw = await c.req.text();
  if (!verifyLemonSignature(raw, c.req.header('x-signature') || '', config.lemonsqueezy.webhookSecret)) {
    return c.json({ error: { code: 'bad_signature', message: 'Invalid Lemon Squeezy signature.' } }, 400);
  }
  let evt: any;
  try { evt = JSON.parse(raw); } catch { return c.json({ error: { code: 'bad_request', message: 'Body is not JSON.' } }, 400); }
  return c.json(await handleLemonEvent(evt));
});

// The web app reads its sign-in settings at startup, so one build works in every environment.
app.get('/app-config.json', (c) => c.json({
  supabaseUrl: config.auth.supabaseUrl, supabaseAnonKey: config.auth.supabaseAnonKey,
  // Public pricing for the landing page.
  plan: { name: config.plan.name, price_usd: config.plan.priceUsd, credits_usd: config.plan.creditsUsd, storage_gb: config.plan.storageGb },
  ...(config.auth.allowDevTokens ? { devUser: DEV_USER } : {}), // local development: sign in as a fixed user
}));
app.get('/console', async (c) => c.html(await readFile(join(here, '..', 'public', 'console.html'), 'utf8')));

const v1 = new Hono<Env>();
v1.use('*', requireUser);
// Request limits per customer: generous for people, tight enough to stop a runaway script running up AI costs.
v1.use('*', limit('api', 600, 60));
v1.post('/create', limit('create', 30, 3600));
v1.post('/projects', limit('create', 30, 3600));
v1.use('/billing/*', limit('billing', 30, 3600));
v1.post('/shots/:id/retake', limit('render', 200, 3600));
v1.post('/shots/:id/render', limit('render', 200, 3600));
v1.post('/episodes/:id/render', limit('render', 200, 3600));
v1.use('/assets/*', limit('assets', 300, 3600));

// ───────── helpers ─────────
const nf = (what: string) => new PermanentError(`${what} not found`, 'not_found');
const url = async (key?: string | null) => (key ? storage.url(key) : null);
async function ownProject(c: Context<Env>, id: string) {
  const [p] = await sql`select * from projects where id = ${id} and owner_id = ${c.get('uid')}`;
  if (!p) throw nf('project'); return p;
}
async function own(c: Context<Env>, table: 'episodes' | 'assets' | 'shots' | 'takes' | 'cuts', id: string) {
  const rows = await sql`select x.* from ${sql(table)} x join projects p on p.id = x.project_id where x.id = ${id} and p.owner_id = ${c.get('uid')}`;
  if (!rows[0]) throw nf(table.slice(0, -1)); return rows[0] as any;
}
const body = async (c: Context) => { try { return await c.req.json(); } catch { return {}; } };
const UUID = /^[0-9a-f-]{36}$/i;
/** Optional render resolution from a request body; only what H3 renders is accepted. */
const resolutionOf = (v: any): string | undefined => {
  if (v === undefined || v === null || v === '') return undefined;
  if (!['768P', '2K'].includes(v)) throw new PermanentError('resolution must be 768P or 2K');
  return v;
};
v1.use('/*', async (c, next) => { // reject malformed ids early
  const seg = c.req.path.split('/'); // ['', 'v1', resource, id, ...]
  const id = seg[3];
  if (id && /^(projects|episodes|assets|shots|takes|cuts|scenes)$/.test(seg[2]) && !UUID.test(id)) return c.json({ error: { code: 'not_found', message: 'not found' } }, 404);
  if (id && seg[2] === 'jobs' && !/^\d+$/.test(id)) return c.json({ error: { code: 'not_found', message: 'not found' } }, 404);
  await next();
});

async function assetView(a: any) {
  return { ...a, url: await url(a.file_key), history: undefined, history_count: (a.history || []).length };
}
async function takeView(t: any) {
  return { id: t.id, n: t.n, status: t.status, error: t.error, error_code: t.error_code, resolution: t.resolution, seconds: t.seconds, cost_usd: t.cost_usd,
    media: t.media, created_at: t.created_at, finished_at: t.finished_at, url: await url(t.file_key), thumb_url: await url(t.thumb_key), request: t.request };
}

// ───────── projects ─────────
v1.post('/projects', async (c) => {
  await requirePlan(c.get('uid'));
  const b = await body(c);
  if (c.req.query('breakdown') !== '0') await requireCredit(c.get('uid'), config.credits.actions.breakdown);
  const p = await createProject(c.get('uid'), b.project || b);
  const job = c.req.query('breakdown') === '0' ? null : await enqueue('project.breakdown', { projectId: p.id }, { projectId: p.id, maxAttempts: 2 });
  return c.json({ project: plain(p), job_id: job }, 201);
});
v1.get('/projects', async (c) => {
  const rows = await sql`select p.id, p.title, p.format, p.aspect, p.status, p.mode, p.stage, p.stage_error, p.updated_at, p.created_at,
    (select count(*)::int from episodes e where e.project_id = p.id) episodes,
    (select thumb_key from cuts where project_id = p.id and status = 'done' order by created_at desc limit 1) thumb_key
    from projects p where owner_id = ${c.get('uid')} order by updated_at desc limit 200`;
  return c.json({ projects: await Promise.all(rows.map(async ({ thumb_key, ...r }: any) => ({ ...r, thumb_url: await url(thumb_key) }))) });
});
v1.get('/projects/:id', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  const episodes = await sql`select e.id, e.idx, e.label, e.title, e.status, length(e.script) script_chars,
      (select count(*)::int from scenes s where s.episode_id = e.id) scenes,
      (select count(*)::int from shots s where s.episode_id = e.id) shots,
      (select count(*)::int from shots s where s.episode_id = e.id and s.status = 'approved') approved,
      (select coalesce(sum(duration),0)::int from shots s where s.episode_id = e.id) seconds
    from episodes e where e.project_id = ${p.id} order by idx`;
  const assets = await sql`select kind, status, count(*)::int n from assets where project_id = ${p.id} and coalesce((meta->>'unused')::boolean,false) = false group by kind, status`;
  const jobs = await sql`select id, kind, status, progress, error, payload, updated_at from jobs where project_id = ${p.id} and (status in ('queued','running') or (status = 'failed' and updated_at > now() - interval '1 day')) order by id desc limit 50`;
  const cuts = await sql`select distinct on (episode_id) id, episode_id, kind, status, duration, error, file_key, srt_key, thumb_key, created_at, finished_at
    from cuts where project_id = ${p.id} order by episode_id, created_at desc`;
  const [{ todo }] = await sql`select coalesce(sum(duration) filter (where status <> 'approved'), 0)::int todo from shots where project_id = ${p.id}`;
  return c.json(plain({
    project: { ...p, source: undefined }, episodes, asset_counts: assets, jobs, spend: await projectSpend(p.id),
    latest_cuts: await Promise.all(cuts.map(async ({ file_key, srt_key, thumb_key, ...r }: any) => ({ ...r, url: await url(file_key), srt_url: await url(srt_key), thumb_url: await url(thumb_key) }))),
    render_price_usd: sellPrice(p.resolution, todo),
  }));
});

// ───────── vibe: prompt → finished video ─────────
v1.post('/create', async (c) => {
  const uid = c.get('uid');
  const brief = resolveBrief(await body(c));
  await ensureAccount(uid, c.get('email'));
  await requirePlan(uid);
  const p = await sql.begin(async (tx) => {
    const [p] = await tx`insert into projects (owner_id, title, format, aspect, language, mode, stage, brief, settings)
      values (${uid}, ${brief.prompt.slice(0, 80)}, ${brief.engineFormat}, ${brief.aspect}, ${brief.language}, 'vibe', 'writing', ${tx.json(brief as any)},
              ${tx.json({ chain_clips: true, burn_subtitles: true })}) returning *`;
    const fee = await debit(tx, uid, config.credits.setupFeeUsd, 'setup_fee', p.id);
    if (fee) await tx`update projects set autopilot = ${tx.json({ setup_fee: fee })} where id = ${p.id}`;
    return p;
  });
  return c.json({ project: plain({ ...p, source: undefined }), job_id: await startAutopilot(p.id) }, 201);
});
/** The checkpoint: the customer has seen the script, cast and price, and wants the film rendered. */
v1.post('/projects/:id/produce', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  if (p.mode !== 'vibe' || p.stage !== 'ready') throw new PermanentError('This project is not waiting to be rendered.', 'bad_state');
  await requirePlan(c.get('uid'));
  const [{ todo }] = await sql`select coalesce(sum(duration) filter (where status <> 'approved'), 0)::int todo from shots where project_id = ${p.id}`;
  const price = sellPrice(p.resolution, todo);
  const balance = await balanceOf(c.get('uid'));
  if (config.credits.enforce && balance < price) {
    throw new PermanentError(`Rendering costs $${price.toFixed(2)} and your balance is $${balance.toFixed(2)}. Add credits to continue.`, 'insufficient_credit');
  }
  const [go] = await sql`update projects set stage = 'rendering', stage_error = null, updated_at = now() where id = ${p.id} and stage = 'ready' returning id`;
  if (!go) throw new PermanentError('This project is already rendering.', 'bad_state');
  return c.json({ job_id: await startAutopilot(p.id), price_usd: price }, 202);
});
/** Pick a failed vibe project up again from the stage it failed in. */
v1.post('/projects/:id/resume', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  if (p.mode !== 'vibe' || p.stage !== 'failed') throw new PermanentError('Only a failed project can be resumed.', 'bad_state');
  await requirePlan(c.get('uid'));
  const st = p.autopilot || {};
  const stage = st.failed_stage || 'writing';
  await sql.begin(async (tx) => {
    const patch: any = stage === 'assembling' ? { cuts: null } : {};
    if (stage === 'writing' && st.writing) patch.writing = { ...st.writing, tries: 0, problem: null }; // a fresh try at the failed writing step
    if (st.setup_refunded) { patch.setup_fee = await debit(tx, p.owner_id, Number(st.setup_fee) || config.credits.setupFeeUsd, 'setup_fee', p.id); patch.setup_refunded = false; }
    await tx`update projects set stage = ${stage}, stage_error = null, autopilot = autopilot || ${tx.json(patch)}, updated_at = now() where id = ${p.id}`;
  });
  return c.json({ job_id: await startAutopilot(p.id), stage }, 202);
});
v1.patch('/projects/:id', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  const b = await body(c);
  const ratio = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
  if (b.aspect && !ratio.includes(b.aspect)) throw new PermanentError('aspect must be one of ' + ratio.join(', '));
  if (b.resolution && !['768P', '2K'].includes(b.resolution)) throw new PermanentError('resolution must be 768P or 2K');
  const [r] = await sql`update projects set title = ${b.title ?? p.title}, aspect = ${b.aspect ?? p.aspect}, resolution = ${b.resolution ?? p.resolution},
    language = ${b.language ?? p.language}, style = ${sql.json(b.style ? { ...p.style, ...b.style } : p.style)},
    settings = ${sql.json(b.settings ? { ...p.settings, ...b.settings } : p.settings)}, updated_at = now() where id = ${p.id} returning *`;
  return c.json(plain({ project: { ...r, source: undefined } }));
});
v1.delete('/projects/:id', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  const open = await sql`select id from takes where project_id = ${p.id} and not settled and hold_usd > 0`;
  for (const t of open) await settleTake(t.id, false); // give back credit held for renders that will never be delivered
  const running = await sql`select provider, provider_task_id from takes where project_id = ${p.id} and status in ('submitted','running') and provider_task_id is not null`;
  for (const t of running) await mm(t.provider).cancelVideoTask?.(t.provider_task_id); // and stop paying for the GPU time
  await storage.delProject(p.id); // free the customer's storage: every clip, image and cut
  await sql`delete from projects where id = ${p.id}`;
  return c.json({ deleted: true });
});
v1.post('/projects/:id/breakdown', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  await requirePlan(c.get('uid'));
  await requireCredit(c.get('uid'), config.credits.actions.breakdown);
  const b = await body(c);
  return c.json({ job_id: await enqueue('project.breakdown', { projectId: p.id, force: !!b.force }, { projectId: p.id, maxAttempts: 2, dedupeKey: `bd:${p.id}` }) }, 202);
});
v1.get('/projects/:id/scenes', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  const rows = await sql`select s.id, s.episode_id, e.idx episode, s.idx, s.heading, s.characters, s.speakers, s.props, s.looks, s.est_seconds,
    s.location_asset_id, a.key location_key, a.name location_name from scenes s join episodes e on e.id = s.episode_id
    left join assets a on a.id = s.location_asset_id where s.project_id = ${p.id} order by e.idx, s.idx`;
  return c.json({ scenes: rows });
});
v1.patch('/scenes/:id', async (c) => { // re-point a scene at a different set/variant or look
  const b = await body(c);
  const [s] = await sql`select s.* from scenes s join projects p on p.id = s.project_id where s.id = ${c.req.param('id')} and p.owner_id = ${c.get('uid')}`;
  if (!s) throw nf('scene');
  const ids = [b.location_asset_id, ...Object.values(b.looks || {})].filter((v) => v != null);
  if (ids.some((v) => typeof v !== 'string' || !UUID.test(v))) throw new PermanentError('asset ids must be UUIDs');
  if (b.props !== undefined && (!Array.isArray(b.props) || b.props.some((x: any) => typeof x !== 'string'))) throw new PermanentError('props must be a list of prop keys');
  if (ids.length) {
    const [{ n }] = await sql`select count(*)::int n from assets where project_id = ${s.project_id} and id in ${sql(ids as string[])}`;
    if (n !== new Set(ids).size) throw new PermanentError('every asset must belong to this project');
  }
  const [r] = await sql`update scenes set location_asset_id = ${b.location_asset_id ?? s.location_asset_id}, looks = ${sql.json(b.looks ? { ...s.looks, ...b.looks } : s.looks)},
    props = ${b.props ?? s.props} where id = ${s.id} returning *`;
  return c.json({ scene: r });
});

// ───────── assets ─────────
v1.get('/projects/:id/assets', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  const rows = await sql`select * from assets where project_id = ${p.id} order by
    case kind when 'character' then 0 when 'look' then 1 when 'voice' then 2 when 'location' then 3 when 'set_variant' then 4 else 5 end, priority desc, key`;
  return c.json({ assets: await Promise.all(rows.map(assetView)) });
});
v1.get('/assets/:id', async (c) => {
  const a = await own(c, 'assets', c.req.param('id'));
  return c.json({ asset: await assetView(a), history: await Promise.all((a.history || []).map(async (h: any, i: number) => ({ index: i, at: h.at, note: h.note, url: await url(h.file_key) }))) });
});
v1.patch('/assets/:id', async (c) => {
  const a = await own(c, 'assets', c.req.param('id'));
  const b = await body(c);
  const meta = { ...a.meta };
  for (const k of ['layout', 'sample_line', 'prompt_override', 'default_wardrobe']) if (b[k] !== undefined) meta[k] = b[k] || undefined;
  const changed = (b.description !== undefined && b.description !== a.description) || b.prompt_override !== undefined;
  const [r] = await sql`update assets set name = ${b.name ?? a.name}, description = ${b.description ?? a.description}, meta = ${sql.json(meta)},
    status = ${changed && a.status === 'approved' ? 'review' : a.status}, updated_at = now() where id = ${a.id} returning *`;
  return c.json({ asset: await assetView(r), note: changed ? 'Description changed: generate again to update the image.' : undefined });
});
v1.post('/assets/:id/generate', async (c) => {
  const a = await own(c, 'assets', c.req.param('id'));
  await requirePlan(c.get('uid'));
  await requireCredit(c.get('uid'), a.kind === 'voice' ? config.credits.actions.voice : config.credits.actions.image);
  const b = await body(c);
  if (a.status === 'approved') await sql`update assets set status = 'review' where id = ${a.id}`;
  await sql`update assets set status = 'planned', error = null where id = ${a.id}`;
  return c.json({ job_id: await enqueue('asset.generate', { assetId: a.id, note: b.note || null }, { projectId: a.project_id, dedupeKey: `asset:${a.id}` }) }, 202);
});
v1.post('/projects/:id/assets/generate', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  await requirePlan(c.get('uid'));
  const b = await body(c);
  return c.json({ queued: await queueAllAssets(p.id, { kinds: b.kinds }) }, 202);
});
v1.post('/assets/:id/approve', async (c) => { const a = await own(c, 'assets', c.req.param('id')); return c.json({ asset: await assetView(await approveAsset(a.id)) }); });
v1.post('/assets/:id/unapprove', async (c) => {
  const a = await own(c, 'assets', c.req.param('id'));
  const [r] = await sql`update assets set status = 'review', approved_at = null where id = ${a.id} and status = 'approved' returning *`;
  return c.json({ asset: await assetView(r || a) });
});
v1.post('/projects/:id/assets/approve-all', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  const rows = await sql`select id from assets where project_id = ${p.id} and status = 'review' order by case kind when 'character' then 0 when 'location' then 1 else 2 end`;
  for (const r of rows) await approveAsset(r.id);
  return c.json({ approved: rows.length });
});
v1.post('/assets/:id/restore', async (c) => {
  const a = await own(c, 'assets', c.req.param('id'));
  const { index } = await body(c);
  const h = (a.history || [])[+index];
  if (!h) throw new PermanentError('no such version');
  const hist = [...a.history]; hist.splice(+index, 1); if (a.file_key) hist.push({ file_key: a.file_key, at: new Date().toISOString(), note: 'swapped out' });
  const [r] = await sql`update assets set file_key = ${h.file_key}, mime = ${mimeOf(h.file_key)}, history = ${sql.json(hist)}, status = 'review', updated_at = now() where id = ${a.id} returning *`;
  return c.json({ asset: await assetView(r) });
});
v1.post('/assets/:id/upload', async (c) => {
  const a = await own(c, 'assets', c.req.param('id'));
  await requirePlan(c.get('uid'));
  const form = await c.req.parseBody();
  const f = form['file'] as File;
  if (!f || typeof f === 'string') throw new PermanentError('send multipart form-data with a "file" field');
  if (f.size > 25 * 1024 * 1024) throw new PermanentError('file over 25 MB');
  const r = await uploadAsset(a.id, Buffer.from(await f.arrayBuffer()), f.type || mimeOf(f.name), c.get('uid'), String(form['consent'] || '') === 'true');
  return c.json({ asset: await assetView(r) });
});
v1.post('/projects/:id/music', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  await requirePlan(c.get('uid'));
  const form = await c.req.parseBody();
  const f = form['file'] as File;
  if (!f || typeof f === 'string' || !/^audio\//.test(f.type)) throw new PermanentError('send an audio file in the "file" field');
  if (f.size > 25 * 1024 * 1024) throw new PermanentError('file over 25 MB');
  const key = `projects/${p.id}/music/${Date.now()}.${f.type.includes('wav') ? 'wav' : 'mp3'}`;
  await storage.put(key, Buffer.from(await f.arrayBuffer()), f.type);
  return c.json({ music_key: key, url: await url(key) });
});

// ───────── episodes, shots, takes ─────────
v1.get('/episodes/:id', async (c) => { const e = await own(c, 'episodes', c.req.param('id')); return c.json({ episode: e }); });
v1.patch('/episodes/:id', async (c) => {
  const e = await own(c, 'episodes', c.req.param('id'));
  const b = await body(c);
  const [r] = await sql`update episodes set title = ${b.title ?? e.title}, script = ${b.script ?? e.script}, updated_at = now() where id = ${e.id} returning *`;
  return c.json({ episode: r, note: b.script ? 'Script changed: run the breakdown again, then re-plan this episode.' : undefined });
});
v1.post('/episodes/:id/plan', async (c) => {
  const e = await own(c, 'episodes', c.req.param('id'));
  await requirePlan(c.get('uid'));
  await requireCredit(c.get('uid'), config.credits.actions.plan);
  const b = await body(c);
  return c.json({ job_id: await enqueue('episode.plan', { episodeId: e.id, force: !!b.force }, { projectId: e.project_id, maxAttempts: 2, dedupeKey: `plan:${e.id}` }) }, 202);
});
v1.get('/episodes/:id/shots', async (c) => {
  const e = await own(c, 'episodes', c.req.param('id'));
  const shots = await sql`select s.*, sc.heading scene_heading, sc.idx scene_idx from shots s left join scenes sc on sc.id = s.scene_id where s.episode_id = ${e.id} order by s.idx`;
  const takes = await sql`select * from takes where shot_id in ${sql(shots.length ? shots.map((s: any) => s.id) : ['00000000-0000-0000-0000-000000000000'])} order by n`;
  const [{ resolution }] = await sql`select resolution from projects where id = ${e.project_id}`;
  const out = await Promise.all(shots.map(async (s: any) => ({
    ...s, takes: await Promise.all(takes.filter((t: any) => t.shot_id === s.id).map(takeView)),
    estimate_usd: +costOf(resolution, s.duration).toFixed(2),
  })));
  return c.json({ shots: out, totals: { shots: out.length, approved: out.filter((s: any) => s.status === 'approved').length, seconds: out.reduce((t: number, s: any) => t + s.duration, 0) } });
});
v1.patch('/shots/:id', async (c) => {
  const s = await own(c, 'shots', c.req.param('id'));
  const b = await body(c);
  if (b.duration !== undefined && (!Number.isInteger(b.duration) || b.duration < 4 || b.duration > 15)) throw new PermanentError('duration must be a whole number from 4 to 15');
  const [r] = await sql`update shots set prompt = ${b.prompt ?? s.prompt}, prompt_locked = ${b.prompt !== undefined ? true : b.prompt_locked ?? s.prompt_locked},
    duration = ${b.duration ?? s.duration}, chain_prev = ${b.chain_prev ?? s.chain_prev}, updated_at = now() where id = ${s.id} returning *`;
  return c.json({ shot: r });
});
v1.post('/shots/:id/render', async (c) => {
  const s = await own(c, 'shots', c.req.param('id'));
  await requirePlan(c.get('uid'));
  const b = await body(c);
  return c.json(await queueRender(s.id, { resolution: resolutionOf(b.resolution) }), 202);
});
v1.post('/episodes/:id/render', async (c) => {
  const e = await own(c, 'episodes', c.req.param('id'));
  await requirePlan(c.get('uid'));
  const b = await body(c);
  const shots = await sql`select id from shots where episode_id = ${e.id} and status in ${sql(b.include_review ? ['planned', 'failed', 'review'] : ['planned', 'failed'])} order by idx`;
  const out: any[] = [];
  for (const s of shots) out.push({ shot_id: s.id, ...(await queueRender(s.id, { resolution: resolutionOf(b.resolution) })) });
  await sql`update episodes set status = 'rendering' where id = ${e.id}`;
  return c.json({ queued: out.length, takes: out }, 202);
});
v1.post('/shots/:id/retake', async (c) => {
  const s = await own(c, 'shots', c.req.param('id'));
  await requirePlan(c.get('uid'));
  const b = await body(c);
  const resolution = resolutionOf(b.resolution);
  const note = typeof b.note === 'string' ? b.note.slice(0, 1000) : '';
  if (note && !b.prompt) await requireCredit(c.get('uid'), config.credits.actions.revision); // the rewrite itself is charged too
  // One update takes the shot out of review, so an autopilot pass can't re-approve the old take in between.
  await sql`update shots set status = 'queued', approved_take_id = null, error = null,
    ${b.prompt ? sql`prompt = ${String(b.prompt)}, prompt_locked = true, review_note = ${note || null},` : sql``} updated_at = now() where id = ${s.id}`;
  let out: any;
  try {
    out = b.prompt ? await queueRender(s.id, { resolution })
      : { job_id: await enqueue('shot.retake', { shotId: s.id, note, resolution }, { projectId: s.project_id, maxAttempts: 2 }) };
  } catch (e) { // nothing was started: put the shot back as it was
    await sql`update shots set status = ${s.status}, approved_take_id = ${s.approved_take_id} where id = ${s.id}`;
    throw e;
  }
  if (b.recut) { // vibe projects: once the retake renders, use it and rebuild the finished episode
    const [p] = await sql`update projects set stage = 'rendering', stage_error = null, autopilot = autopilot || '{"cuts": null}'::jsonb, updated_at = now()
      where id = ${s.project_id} and mode = 'vibe' and stage in ('done','rendering','assembling') returning id`;
    if (p) await startAutopilot(s.project_id);
  }
  return c.json(out, 202);
});
v1.post('/takes/:id/approve', async (c) => {
  const t = await own(c, 'takes', c.req.param('id'));
  if (t.status !== 'succeeded') throw new PermanentError('Only a finished take can be approved.', 'bad_state');
  await sql`update shots set status = 'approved', approved_take_id = ${t.id}, updated_at = now() where id = ${t.shot_id}`;
  await refreshEpisodeStatus(t.shot_id);
  return c.json({ approved: true });
});
v1.post('/takes/:id/reject', async (c) => {
  const t = await own(c, 'takes', c.req.param('id'));
  const b = await body(c);
  await sql`update takes set status = 'rejected', error = ${b.note || 'rejected in review'} where id = ${t.id} and status = 'succeeded'`;
  await sql`update shots set status = case when approved_take_id = ${t.id} then 'review' else status end,
    approved_take_id = case when approved_take_id = ${t.id} then null else approved_take_id end, updated_at = now() where id = ${t.shot_id}`;
  return c.json({ rejected: true });
});
v1.post('/shots/:id/unapprove', async (c) => {
  const s = await own(c, 'shots', c.req.param('id'));
  await sql`update shots set status = 'review', approved_take_id = null, updated_at = now() where id = ${s.id}`;
  await refreshEpisodeStatus(s.id);
  return c.json({ ok: true });
});

// ───────── assembly ─────────
v1.post('/episodes/:id/cuts', async (c) => {
  const e = await own(c, 'episodes', c.req.param('id'));
  const b = await body(c);
  const cut = await requestCut(e.id, b.kind === 'preview' ? 'preview' : 'final', b.options || {});
  return c.json({ cut, job_id: await enqueue('cut.assemble', { cutId: cut.id }, { projectId: e.project_id, maxAttempts: 2 }) }, 202);
});
v1.get('/episodes/:id/cuts', async (c) => {
  const e = await own(c, 'episodes', c.req.param('id'));
  const rows = await sql`select * from cuts where episode_id = ${e.id} order by created_at desc`;
  return c.json({ cuts: await Promise.all(rows.map(async (r: any) => ({ ...r, url: await url(r.file_key), srt_url: await url(r.srt_key), thumb_url: await url(r.thumb_key) }))) });
});

// ───────── money, jobs, live updates ─────────
v1.get('/projects/:id/estimate', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  const res = c.req.query('resolution') || p.resolution;
  const [s] = await sql`select coalesce(sum(duration),0)::int secs, count(*)::int n,
    coalesce(sum(duration) filter (where status <> 'approved'),0)::int todo_secs from shots where project_id = ${p.id}`;
  const [a] = await sql`select count(*) filter (where kind in ('character','look','location','set_variant','prop') and status in ('planned','failed'))::int images,
    count(*) filter (where kind = 'voice' and status in ('planned','failed'))::int voices from assets where project_id = ${p.id}`;
  const once = costOf(res, s.todo_secs);
  return c.json({
    resolution: res, shots: s.n, runtime_seconds: s.secs, seconds_left_to_approve: s.todo_secs,
    video_full_runtime_once_usd: +costOf(res, s.secs).toFixed(2),
    video_if_every_shot_works_first_time_usd: +once.toFixed(2),
    video_expected_with_retakes_usd: +(once * config.pricing.retakeFactor).toFixed(2),
    assets_pending_usd: +(a.images * config.pricing.imageEach + a.voices * 25 * config.pricing.voicePerChar).toFixed(2),
    spent: await projectSpend(p.id),
    prices: { video_per_second: config.pricing.videoPerSecond, image_each: config.pricing.imageEach },
    // What the customer pays in credits (the numbers above are our provider costs).
    customer: { per_second: config.credits.sellPerSecond[res] ?? config.credits.sellPerSecond['768P'], to_finish_usd: sellPrice(res, s.todo_secs), full_runtime_usd: sellPrice(res, s.secs) },
  });
});

// Operators only (ADMIN_USER_IDS): render queue, RunPod workers and the warm-pool controller's last decision.
v1.get('/admin/capacity', async (c) => {
  if (!config.admins.includes(c.get('uid'))) throw nf('page');
  const [queue] = await sql`select count(*) filter (where status = 'pending')::int pending, count(*) filter (where status = 'submitted')::int submitted,
    count(*) filter (where status = 'running')::int running from takes`;
  const [ctl] = await sql`select progress, updated_at from jobs where kind = 'system.capacity' order by id desc limit 1`;
  const runpod = config.videoProvider === 'runpod' ? await endpointHealth().catch((e: any) => ({ error: e.message })) : null;
  return c.json(plain({ provider: config.videoProvider, queue, runpod, controller: ctl ?? null }));
});

// Operators only: the launch checklist against the real services (the web app shows it at /setup).
v1.get('/admin/preflight', async (c) => {
  if (!config.admins.includes(c.get('uid'))) throw nf('page');
  return c.json({ checks: await preflight() });
});

v1.get('/me', async (c) => {
  const uid = c.get('uid');
  await ensureAccount(uid, c.get('email'));
  const events = await sql`select delta_usd::float delta_usd, reason, ref, created_at from credit_events where owner_id = ${uid} order by id desc limit 20`;
  const credits = await balances(uid);
  return c.json({
    user_id: uid, email: c.get('email'), is_admin: config.admins.includes(uid), balance_usd: credits.total, credits, credits_enforced: config.credits.enforce,
    plan: { ...(await planOf(uid)), name: config.plan.name, price_usd: config.plan.priceUsd, credits_usd: config.plan.creditsUsd, storage_gb: config.plan.storageGb },
    storage: { used_bytes: await storageUsed(uid), quota_bytes: storageQuotaBytes() },
    prices: { per_second: config.credits.sellPerSecond, setup_fee_usd: config.credits.setupFeeUsd, actions: config.credits.actions },
    packs: config.credits.packs.map((p) => ({ id: p.id, usd: p.usd, available: !!p.variantId })),
    payments_enabled: paymentsEnabled(), recent: events,
  });
});
v1.post('/billing/subscribe', async (c) => c.json(await subscribeCheckout(c.get('uid'), c.get('email'))));
v1.post('/billing/topup', async (c) => {
  const b = await body(c);
  return c.json(await topupCheckout(c.get('uid'), String(b.pack || ''), c.get('email')));
});
v1.get('/billing/portal', async (c) => c.json(await portalUrl(c.get('uid'))));
v1.get('/jobs/:id', async (c) => {
  const [j] = await sql`select j.id, j.kind, j.status, j.progress, j.error, j.result, j.attempts, j.created_at, j.updated_at from jobs j
    join projects p on p.id = j.project_id where j.id = ${+c.req.param('id')} and p.owner_id = ${c.get('uid')}`;
  if (!j) throw nf('job');
  return c.json({ job: plain(j) });
});
/** Server-sent events: one "change" event whenever anything in the project moves. */
v1.get('/projects/:id/events', async (c) => {
  const p = await ownProject(c, c.req.param('id'));
  return streamSSE(c, async (stream) => {
    let last = '';
    for (let i = 0; i < 1800 && !stream.aborted; i++) { // ~1 hour, then the client reconnects
      const [d] = await sql`select
        (select max(updated_at) from projects where id = ${p.id})::text a,
        (select max(updated_at) from assets where project_id = ${p.id})::text b,
        (select max(updated_at) from shots where project_id = ${p.id})::text c,
        (select max(coalesce(finished_at, submitted_at, created_at)) from takes where project_id = ${p.id})::text d,
        (select max(updated_at) from jobs where project_id = ${p.id})::text e,
        (select max(coalesce(finished_at, created_at)) from cuts where project_id = ${p.id})::text f`;
      const sig = Object.values(d).join('|');
      if (sig !== last) {
        last = sig;
        const jobs = await sql`select id, kind, status, progress from jobs where project_id = ${p.id} and status in ('queued','running') order by id limit 20`;
        await stream.writeSSE({ event: 'change', data: JSON.stringify(plain({ at: new Date().toISOString(), active_jobs: jobs })) });
      } else if (i % 15 === 0) await stream.writeSSE({ event: 'ping', data: '{}' });
      await stream.sleep(2000);
    }
  });
});

v1.route('/admin', admin);
app.route('/v1', v1);

// ───────── the web app (web/dist): static files, and index.html for every app route ─────────
const WEB_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json',
};
const webDir = resolve(config.webDir);
app.get('*', async (c) => {
  const path = decodeURIComponent(c.req.path);
  if (/^\/(v1|files|webhooks|health|console)(\/|$)/.test(path)) return c.json({ error: { code: 'not_found', message: 'not found' } }, 404);
  const file = resolve(webDir, '.' + path);
  if (path !== '/' && file.startsWith(webDir + sep) && (await stat(file).then((s) => s.isFile(), () => false))) {
    return new Response(new Uint8Array(await readFile(file)), { headers: {
      'content-type': WEB_MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache', // Vite hashes /assets names
    } });
  }
  const index = await readFile(join(webDir, 'index.html'), 'utf8').catch(() => null);
  return index ? c.html(index, 200, { 'cache-control': 'no-cache' }) : c.text('The web app is not built. Run `npm run build` in web/.', 404);
});
