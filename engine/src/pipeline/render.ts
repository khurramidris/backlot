// Rendering: one take = one H3 task. Submit → poll every ~10 s → copy the MP4 into our own
// storage (MiniMax links expire) → verify it with ffprobe → thumbnail → ready for review.

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { sql } from '../db.js';
import { config } from '../config.js';
import { storage, downloadTo } from '../storage.js';
import { PermanentError, enqueue, type Again } from '../queue.js';
import * as real from '../providers/minimax.js';
import { ProviderError, type H3Request, type H3Content, type H3Task } from '../providers/minimax.js';
import { mockMinimax } from '../providers/mock.js';
import * as runpod from '../providers/runpod.js';
import { recordUsage } from '../usage.js';
import { debit, sellPrice, settleTake } from '../billing.js';
import { probe, thumbnail } from '../media/ffmpeg.js';
import { compileShot, validateH3, costOf } from './compiler.js';
import { compileInputFor, projectAssets } from './shots.js';
import { buildClipRequest, providerFor, refreshClip } from './clips.js';
import { moderate } from '../moderation.js';

interface VideoApi {
  createVideoTask(body: H3Request, o: { key: string }): Promise<string>;
  queryVideoTask(id: string): Promise<H3Task>;
  cancelVideoTask?(id: string): Promise<void>;
}
/** RunPod is always real (tests point it at a fake server); otherwise mocks replace MiniMax in dev. */
export const mm = (provider: string = config.videoProvider): VideoApi => (provider === 'runpod' ? runpod : config.mock ? mockMinimax : real);
export const takeKey = (t: any) => `projects/${t.project_id}/takes/${t.id}.mp4`;
/** Resolutions a provider renders: our own GPUs make 768P only, so 2K is never sold there. */
export const resolutionsFor = (provider: string) => (provider === 'runpod' ? ['768P'] : ['768P', '2K']);
/** Whether a scene's previous clip goes to the next shot as a reference video (CHAIN_CLIPS, auto = not on our own GPUs). */
const chainClips = () => (config.chainClips === 'auto' ? config.videoProvider !== 'runpod' : config.chainClips === '1');

/** Create a new take for a shot and queue it. */
export async function queueRender(shotId: string, o: { resolution?: string } = {}) {
  const [s] = await sql`select s.*, p.resolution p_res, p.owner_id from shots s join projects p on p.id = s.project_id where s.id = ${shotId}`;
  if (!s) throw new PermanentError('shot not found');
  if (s.status === 'approved') throw new PermanentError('This shot is already approved. Unapprove it before rendering again.', 'bad_state');
  const [busy] = await sql`select id from takes where shot_id = ${shotId} and status in ('pending','submitted','running') limit 1`;
  if (busy) return { take_id: busy.id, already_running: true };
  const resolution = o.resolution || s.p_res || '768P';
  if (!resolutionsFor(config.videoProvider).includes(resolution)) throw new PermanentError(`${resolution} isn't available: videos are made at 768P.`, 'bad_input');
  // The hold and the take are created together: no take without its credit, no credit without its take.
  const t = await sql.begin(async (tx) => {
    const held = await debit(tx, s.owner_id, sellPrice(resolution, s.duration), 'render_hold', shotId);
    const [row] = await tx`insert into takes (project_id, shot_id, n, resolution, status, hold_usd)
      values (${s.project_id}, ${shotId}, coalesce((select max(n) from takes where shot_id = ${shotId}), 0) + 1, ${resolution}, 'pending', ${held}) returning id, n`;
    return row;
  });
  await sql`update shots set status = 'queued', error = null, updated_at = now() where id = ${shotId}`;
  await enqueue('take.submit', { takeId: t.id }, { projectId: s.project_id, maxAttempts: 5 });
  return { take_id: t.id, n: t.n };
}

/** Build the exact H3 body for a take. Media is referenced by URL when MiniMax can reach our files, otherwise inlined. */
export async function buildRequest(shot: any, resolution: string) {
  const [p] = await sql`select * from projects where id = ${shot.project_id}`;
  const media = async (key: string) => {
    const mode = config.minimax.mediaMode;
    if (mode !== 'inline') { const u = await storage.providerUrl(key); if (u) return u; if (mode === 'url') throw new PermanentError('MINIMAX_MEDIA_MODE=url but files are not reachable from the internet (set PUBLIC_BASE_URL or use S3 storage).', 'config'); }
    return storage.dataUri(key);
  };
  if (p.mode === 'clip') return { ...(await buildClipRequest(p, shot, media)), provider: providerFor(p), mode: p.mode };

  const scene = shot.scene_id ? (await sql`select * from scenes where id = ${shot.scene_id}`)[0] : null;
  const A = await projectAssets(p.id);

  // Continuity: pass the previous approved clip of the same scene as a reference video.
  let prev: any = null;
  if (shot.chain_prev && p.settings?.chain_clips && chainClips()) {
    [prev] = await sql`select t.file_key, t.media from shots s join takes t on t.id = s.approved_take_id
      where s.scene_id = ${shot.scene_id} and s.idx = ${shot.idx - 1} and s.status = 'approved'`;
  }
  const chainNote = prev ? 'Reference video 1 is the shot that plays just before this one: match its colour grade, lighting, lens feel and where everyone is standing, then continue from it.' : null;
  const input = compileInputFor(shot, scene, p, A, chainNote);
  const c = compileShot(input);
  const prompt = shot.prompt_locked && shot.prompt ? shot.prompt : c.prompt;

  const content: H3Content[] = [{ type: 'text', text: prompt }];
  const refs: any[] = [];
  for (const a of c.images) { content.push({ type: 'image_url', image_url: { url: await media(a.file_key!) }, role: 'reference_image' }); refs.push({ role: 'reference_image', asset: a.key }); }
  let videoNote: string | null = null;
  if (prev?.file_key) {
    const secs = +(prev.media?.duration || 0);
    if (secs >= 2 && secs <= 15) {
      content.push({ type: 'video_url', video_url: { url: await media(prev.file_key) }, role: 'reference_video' });
      refs.push({ role: 'reference_video', take_file: prev.file_key, seconds: secs });
    } else videoNote = `previous clip not used as reference (${secs}s is outside 2–15s)`;
  }
  // Voices only when there is at least one visual reference (H3 rejects audio on its own).
  if (c.images.length || prev) for (const v of c.voices) { content.push({ type: 'audio_url', audio_url: { url: await media(v.file_key!) }, role: 'reference_audio' }); refs.push({ role: 'reference_audio', asset: v.key }); }

  const body: H3Request = { model: config.minimax.videoModel, content, resolution: resolution as any, duration: shot.duration, ratio: p.aspect };
  validateH3(body);
  const bytes = JSON.stringify(body).length;
  if (bytes > 60 * 1024 * 1024) throw new PermanentError(`Request is ${(bytes / 1048576).toFixed(1)} MB, over MiniMax's 64 MB limit. Use S3 storage or PUBLIC_BASE_URL so media is sent by URL.`, 'too_large');
  const loggable = { model: body.model, resolution: body.resolution, duration: body.duration, ratio: body.ratio, prompt, refs, warnings: [...c.warnings, ...(videoNote ? [videoNote] : [])], bytes };
  return { body, loggable, owner: p.owner_id, provider: providerFor(p), mode: p.mode };
}

export async function submitTake(takeId: string): Promise<any | Again> {
  const [t] = await sql`select * from takes where id = ${takeId}`;
  if (!t || t.status !== 'pending') return { skipped: t?.status };
  const [{ active }] = await sql`select count(*)::int active from takes where status in ('submitted','running')`;
  if (active >= config.minimax.maxConcurrentVideo) return { again: 15, progress: `waiting for a render slot (${active} running)` };
  const [{ mine }] = await sql`select count(*)::int mine from takes t join projects p on p.id = t.project_id
    where t.status in ('submitted','running') and p.owner_id = (select owner_id from projects where id = ${t.project_id})`;
  if (mine >= config.minimax.maxConcurrentPerUser) return { again: 15, progress: `waiting for one of your ${mine} renders to finish` };
  const [shot] = await sql`select * from shots where id = ${t.shot_id}`;
  const { body, loggable, owner, provider, mode } = await buildRequest(shot, t.resolution);
  // A prompt the customer wrote by hand goes straight to the video model: check it first (clips are checked on creation).
  if (shot.prompt_locked && mode !== 'clip') {
    const text = (body.content.find((x) => x.type === 'text') as any)?.text || '';
    const v = await moderate({ ownerId: owner, projectId: shot.project_id, text });
    if (!v.allowed) { await failTake(takeId, shot.id, `Refused by the content check: ${v.reason}`, 'sensitive_content', loggable); return { blocked: v.category }; }
  }
  try {
    const taskId = await mm(provider).createVideoTask(body, { key: takeKey(t) });
    await sql`update takes set status = 'submitted', provider = ${provider}, provider_task_id = ${taskId}, request = ${sql.json(loggable)}, submitted_at = now() where id = ${takeId}`;
    await sql`update shots set status = 'rendering', updated_at = now() where id = ${shot.id}`;
    await enqueue('take.poll', { takeId }, { projectId: t.project_id, delaySec: config.minimax.pollSeconds, maxAttempts: 8 });
    return { task_id: taskId };
  } catch (e: any) {
    if (e instanceof ProviderError && e.retryable) {
      if (e.code === 'rate_limited') return { again: 30, progress: 'MiniMax rate limit, retrying' };
      throw e; // network / 5xx: the queue retries with backoff
    }
    await failTake(takeId, shot.id, e.message, e.code || 'submit_failed', loggable);
    throw new PermanentError(e.message, e.code);
  }
}

export async function pollTake(takeId: string): Promise<any | Again> {
  const [t] = await sql`select * from takes where id = ${takeId}`;
  if (!t || !['submitted', 'running'].includes(t.status)) return { skipped: t?.status };
  const task = await mm(t.provider).queryVideoTask(t.provider_task_id); // the provider that took the job, not today's setting
  const age = (Date.now() - new Date(t.submitted_at).getTime()) / 60000;
  if (task.status === 'queued' || task.status === 'running' || task.status === 'processing' || task.status === 'preparing') {
    if (age > config.minimax.taskTimeoutMinutes) {
      await mm(t.provider).cancelVideoTask?.(t.provider_task_id); // stop paying for GPU time on a clip we've given up on
      await failTake(takeId, t.shot_id, `H3 task still ${task.status} after ${Math.round(age)} minutes`, 'timeout');
      return { timeout: true };
    }
    if (task.status === 'running' && t.status !== 'running') await sql`update takes set status = 'running' where id = ${takeId}`;
    return { again: config.minimax.pollSeconds, progress: `H3 ${task.status} (${Math.round(age * 60)}s)` };
  }
  if (task.status !== 'succeeded' || !task.url) {
    const why = task.error || `H3 task ${task.status}`;
    await failTake(takeId, t.shot_id, why, /sensitive|moderat|policy/i.test(why) ? 'sensitive_content' : task.status);
    return { failed: why };
  }

  // The provider has charged us from this point on, so record the spend once, even if our own copy step fails.
  const [shot] = await sql`select duration from shots where id = ${t.shot_id}`;
  const outSec = +(task.usage?.output_seconds ?? shot.duration);
  const inSec = +(task.usage?.input_seconds ?? 0);
  // RunPod reports GPU time (priced by RUNPOD_GPU_PRICE_PER_SECOND); otherwise estimate from list prices.
  const cost = (task.usage as any)?.cost_usd || (config.mock ? 0 : costOf(t.resolution, outSec + inSec));
  const [first] = await sql`update takes set seconds = ${outSec + inSec}, cost_usd = ${cost} where id = ${takeId} and cost_usd is null returning project_id`;
  if (first) {
    const [pr] = await sql`select owner_id from projects where id = ${t.project_id}`;
    await recordUsage({ ownerId: pr.owner_id, projectId: t.project_id, kind: 'video', units: outSec + inSec, cost, ref: takeId, estimated: task.usage?.output_seconds === undefined });
  }

  // Copy the video into our storage and check it is what we asked for.
  const key = takeKey(t);
  await downloadTo(key, task.url);
  const dir = await mkdtemp(join(tmpdir(), 'take-'));
  try {
    const local = await storage.toLocal(key, dir);
    await storage.record(key, (await stat(local)).size); // counts toward storage even when the worker uploaded it directly
    const info = await probe(local).catch((e) => { throw new PermanentError(`downloaded file is not a readable video: ${e.message}`, 'invalid_output'); });
    const problems: string[] = [];
    if (!info.width || !info.height) problems.push('no video stream');
    if (Math.abs(info.duration - shot.duration) > 1.5) problems.push(`length ${info.duration.toFixed(1)}s, asked for ${shot.duration}s`);
    if (!info.has_audio) problems.push('no audio track');
    const thumbKey = `projects/${t.project_id}/takes/${takeId}.jpg`;
    const thumbLocal = join(dir, 'thumb.jpg');
    await thumbnail(local, thumbLocal, 0.4);
    await storage.putFile(thumbKey, thumbLocal, 'image/jpeg');
    const fatal = problems.includes('no video stream');
    await sql`update takes set status = ${fatal ? 'failed' : 'succeeded'}, file_key = ${key}, thumb_key = ${thumbKey}, media = ${sql.json({ ...info, problems })},
      error = ${problems.join('; ') || null}, error_code = ${fatal ? 'invalid_output' : null}, finished_at = now() where id = ${takeId}`;
    await settleTake(takeId, !fatal); // the customer only pays for a usable clip
    await sql`update shots set status = ${fatal ? 'failed' : 'review'}, error = ${fatal ? problems.join('; ') : null}, updated_at = now() where id = ${t.shot_id} and status <> 'approved'`;
    await refreshEpisodeStatus(t.shot_id);
    await refreshClip(t.project_id);
    return { file_key: key, problems };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

async function failTake(takeId: string, shotId: string, error: string, code: string, request?: any) {
  await sql`update takes set status = 'failed', error = ${error.slice(0, 1000)}, error_code = ${code}, finished_at = now()
    ${request ? sql`, request = ${sql.json(request)}` : sql``} where id = ${takeId}`;
  await settleTake(takeId, false);
  const [other] = await sql`select 1 from takes where shot_id = ${shotId} and status = 'succeeded' limit 1`;
  const [s] = await sql`update shots set status = ${other ? 'review' : code === 'sensitive_content' ? 'blocked' : 'failed'}, error = ${error.slice(0, 500)}, updated_at = now()
    where id = ${shotId} and status <> 'approved' returning project_id`;
  if (s) await refreshClip(s.project_id);
}

export async function refreshEpisodeStatus(shotId: string) {
  const [s] = await sql`select episode_id from shots where id = ${shotId}`;
  if (!s) return;
  const [c] = await sql`select count(*)::int total, count(*) filter (where status = 'approved')::int approved,
    count(*) filter (where status in ('queued','rendering'))::int busy from shots where episode_id = ${s.episode_id}`;
  const status = c.total && c.approved === c.total ? 'approved' : c.busy ? 'rendering' : 'review';
  await sql`update episodes set status = ${status}, updated_at = now() where id = ${s.episode_id} and status <> 'assembled'`;
}

export async function takeFailedHook(p: any) {
  const [t] = await sql`select * from takes where id = ${p.takeId}`;
  if (t && ['pending', 'submitted', 'running'].includes(t.status)) await failTake(t.id, t.shot_id, 'render job gave up after repeated errors', 'job_failed');
}
