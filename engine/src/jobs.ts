// Every background step is a job. Register handlers once; the worker runs them.

import { register } from './queue.js';
import { runBreakdown } from './pipeline/breakdown.js';
import { generateAsset } from './pipeline/assets.js';
import { planEpisode, reviseShot } from './pipeline/shots.js';
import { submitTake, pollTake, takeFailedHook, queueRender } from './pipeline/render.js';
import { assembleCut } from './pipeline/assemble.js';
import { runAutopilot, autopilotFailed } from './pipeline/autopilot.js';
import { capacityTick } from './capacity.js';
import { snapshotTick } from './telemetry.js';
import { sql } from './db.js';
import { config } from './config.js';
import { paidForProject } from './billing.js';
import { rewriteScene } from './pipeline/writer.js';

export function registerJobs() {
  register('project.breakdown', (p, ctx) => paidForProject(p.projectId, config.credits.actions.breakdown, 'breakdown', () => runBreakdown(p.projectId, ctx, { force: p.force })));
  register('project.breakdown:failed', async (p, ctx) => {
    await sql`update projects set status = 'imported', updated_at = now() where id = ${p.projectId} and status = 'breaking_down'`;
  });
  register('asset.generate', (p, ctx) => generateAsset(p.assetId, ctx, { note: p.note, covered: !!p.covered }));
  register('asset.generate:failed', async (p) => {
    await sql`update assets set status = 'failed', updated_at = now() where id = ${p.assetId} and status in ('generating','planned')`;
  });
  register('episode.plan', async (p, ctx) => {
    const [e] = await sql`select project_id from episodes where id = ${p.episodeId}`;
    return paidForProject(e?.project_id, config.credits.actions.plan, 'shot_plan', () => planEpisode(p.episodeId, ctx, { force: p.force }));
  });
  register('take.submit', (p) => submitTake(p.takeId));
  register('take.poll', (p) => pollTake(p.takeId));
  register('take.submit:failed', takeFailedHook);
  register('take.poll:failed', takeFailedHook);
  register('shot.retake', async (p, ctx) => {
    if (p.note) {
      await ctx.progress('Revising the shot from the note');
      const [sh] = await sql`select project_id from shots where id = ${p.shotId}`;
      await paidForProject(sh?.project_id, config.credits.actions.revision, 'revision', () => reviseShot(p.shotId, p.note));
    }
    return queueRender(p.shotId, { resolution: p.resolution });
  });
  register('shot.retake:failed', async (p) => {
    await sql`update shots set status = case when approved_take_id is null then 'failed' else status end, error = 'retake could not be prepared', updated_at = now() where id = ${p.shotId}`;
  });
  register('cut.assemble', (p, ctx) => assembleCut(p.cutId, ctx.progress));
  register('scene.rewrite', async (p, ctx) => {
    const [e] = await sql`select project_id from episodes where id = ${p.episodeId}`;
    await ctx.progress(`Rewriting scene ${p.scene}`);
    return paidForProject(e?.project_id, config.credits.actions.scene, 'scene_rewrite', () => rewriteScene(p.episodeId, p.scene - 1, p.note));
  });
  register('project.autopilot', (p, ctx) => runAutopilot(p.projectId, ctx));
  register('project.autopilot:failed', autopilotFailed);
  register('system.capacity', () => capacityTick());
  register('system.snapshot', () => snapshotTick());
}
