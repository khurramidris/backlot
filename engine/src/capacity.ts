// Warm-pool controller for the RunPod endpoint. RunPod's own autoscaler adds workers when its queue
// backs up and removes idle ones; this sets the floor it scales down to:
//   nobody rendering for RUNPOD_WARM_MINUTES   → 0 workers (no GPU bill while idle)
//   customers active                           → at least RUNPOD_WARM_WORKERS (no multi-minute cold starts)
//   deep queue                                 → one worker per RUNPOD_JOBS_PER_WORKER renders in flight
// and always caps at RUNPOD_MAX_WORKERS, the budget ceiling.

import { sql } from './db.js';
import { config } from './config.js';
import { enqueue, type Again } from './queue.js';
import { setWorkers } from './providers/runpod.js';

export function decideWorkersMin(o: { active: number; recent: number; warmWorkers: number; maxWorkers: number; jobsPerWorker: number }) {
  if (!o.active && !o.recent) return 0;
  return Math.min(o.maxWorkers, Math.max(o.warmWorkers, Math.ceil(o.active / Math.max(1, o.jobsPerWorker))));
}

let applied: number | null = null; // last floor sent to RunPod by this process

export async function capacityTick(): Promise<Again> {
  const rp = config.runpod;
  if (config.videoProvider !== 'runpod') return { again: 600, progress: 'video provider is not RunPod; nothing to manage' };
  const [{ active, recent }] = await sql`select
      count(*) filter (where status in ('pending','submitted','running'))::int active,
      count(*) filter (where created_at > now() - make_interval(mins => ${rp.warmMinutes}))::int recent
    from takes`;
  const want = decideWorkersMin({ active, recent, warmWorkers: rp.warmWorkers, maxWorkers: rp.maxWorkers, jobsPerWorker: rp.jobsPerWorker });
  let note = '';
  if (want !== applied) {
    if (rp.manageScaling) {
      try { await setWorkers(want, rp.maxWorkers); applied = want; note = ' (applied)'; }
      catch (e: any) { note = ` (not applied: ${e.message})`; console.error('[capacity]', e.message); }
    } else note = ' (RUNPOD_MANAGE_SCALING is off: not applied)';
  }
  const progress = `workersMin=${want} max=${rp.maxWorkers} · ${active} renders in flight, ${recent} started in the last ${rp.warmMinutes} min${note}`;
  if (note) console.log(`[capacity] ${progress}`);
  return { again: rp.tickSeconds, progress };
}

/** One controller job for the whole deployment; enqueue dedupes if it's already scheduled. */
export const startCapacityController = () => enqueue('system.capacity', {}, { dedupeKey: 'capacity', maxAttempts: 1_000_000 });
