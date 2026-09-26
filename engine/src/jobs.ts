// Every background step is a job. Register handlers once; the worker runs them.

import { register } from './queue.js';
import { runBreakdown } from './pipeline/breakdown.js';
import { generateAsset } from './pipeline/assets.js';
import { planEpisode, reviseShot } from './pipeline/shots.js';
import { submitTake, pollTake, takeFailedHook, queueRender } from './pipeline/render.js';
import { assembleCut } from './pipeline/assemble.js';
import { runAutopilot, autopilotFailed } from './pipeline/autopilot.js';
import { sql } from './db.js';

export function registerJobs() {
  register('project.breakdown', (p, ctx) => runBreakdown(p.projectId, ctx, { force: p.force }));
  register('project.breakdown:failed', async (p, ctx) => {
    await sql`update projects set status = 'imported', updated_at = now() where id = ${p.projectId} and status = 'breaking_down'`;
  });
  register('asset.generate', (p, ctx) => generateAsset(p.assetId, ctx, { note: p.note }));
  register('asset.generate:failed', async (p) => {
    await sql`update assets set status = 'failed', updated_at = now() where id = ${p.assetId} and status in ('generating','planned')`;
  });
  register('episode.plan', (p, ctx) => planEpisode(p.episodeId, ctx, { force: p.force }));
  register('take.submit', (p) => submitTake(p.takeId));
  register('take.poll', (p) => pollTake(p.takeId));
  register('take.submit:failed', takeFailedHook);
  register('take.poll:failed', takeFailedHook);
  register('shot.retake', async (p, ctx) => {
    if (p.note) { await ctx.progress('Revising the shot from the note'); await reviseShot(p.shotId, p.note); }
    return queueRender(p.shotId, { resolution: p.resolution });
  });
  register('shot.retake:failed', async (p) => {
    await sql`update shots set status = case when approved_take_id is null then 'failed' else status end, error = 'retake could not be prepared', updated_at = now() where id = ${p.shotId}`;
  });
  register('cut.assemble', (p, ctx) => assembleCut(p.cutId, ctx.progress));
  register('project.autopilot', (p, ctx) => runAutopilot(p.projectId, ctx));
  register('project.autopilot:failed', autopilotFailed);
}
