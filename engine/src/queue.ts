// Durable job queue on Postgres. Jobs survive restarts and deploys; any number of worker
// processes can run side by side (FOR UPDATE SKIP LOCKED guarantees one claimant per job).

import { hostname } from 'node:os';
import { sql } from './db.js';
import { config } from './config.js';
import { reportError } from './monitoring.js';

export interface Job {
  id: number; project_id: string | null; kind: string; payload: any;
  attempts: number; max_attempts: number;
}
export interface JobCtx {
  job: Job;
  progress(text: string): Promise<void>;
}
/** Returned by a handler to run again later without counting a failed attempt (polling). */
export interface Again { again: number; progress?: string }
export type Handler = (payload: any, ctx: JobCtx) => Promise<any | Again>;

/** An error that retrying will not fix (bad input, content refused, missing asset). */
export class PermanentError extends Error {
  code: string;
  constructor(message: string, code = 'permanent') { super(message); this.code = code; }
}

const handlers = new Map<string, Handler>();
export function register(kind: string, h: Handler) { handlers.set(kind, h); }

export async function enqueue(kind: string, payload: any, o: { projectId?: string | null; delaySec?: number; maxAttempts?: number; dedupeKey?: string } = {}) {
  if (o.dedupeKey) {
    const [dup] = await sql`select id from jobs where kind = ${kind} and status in ('queued','running') and payload->>'_dedupe' = ${o.dedupeKey} limit 1`;
    if (dup) return Number(dup.id);
    payload = { ...payload, _dedupe: o.dedupeKey };
  }
  const [row] = await sql`
    insert into jobs (project_id, kind, payload, max_attempts, run_after)
    values (${o.projectId ?? null}, ${kind}, ${sql.json(payload)}, ${o.maxAttempts ?? 3}, now() + make_interval(secs => ${o.delaySec ?? 0}))
    returning id`;
  kick();
  return Number(row.id);
}

const me = `${hostname()}:${process.pid}`;
const mine = new Map<number, number>(); // the jobs this process is running: id → when it started them
const MAX_RUN_MS = 90 * 60_000; // longer than any step takes (the final cut's FFmpeg limit is 60 minutes)
let stopping = false;
let wake: (() => void) | null = null;
function kick() { if (wake) { const w = wake; wake = null; w(); } }

async function claim(): Promise<Job | null> {
  const [j] = await sql`
    update jobs set status = 'running', locked_at = now(), locked_by = ${me}, attempts = attempts + 1, updated_at = now()
    where id = (
      select id from jobs where status = 'queued' and run_after <= now()
      order by run_after, id for update skip locked limit 1)
    returning id, project_id, kind, payload, attempts, max_attempts`;
  return j ? ({ ...j, id: Number(j.id) } as Job) : null;
}

async function runOne(job: Job) {
  const h = handlers.get(job.kind);
  const ctx: JobCtx = {
    job,
    progress: async (text) => { await sql`update jobs set progress = ${text}, updated_at = now() where id = ${job.id}`; },
  };
  try {
    if (!h) throw new PermanentError(`no handler for job kind ${job.kind}`);
    const r = await h(job.payload, ctx);
    if (r && typeof r === 'object' && 'again' in r) {
      // Polling reschedule: give the attempt back.
      await sql`update jobs set status = 'queued', attempts = attempts - 1, locked_at = null, locked_by = null,
        run_after = now() + make_interval(secs => ${Math.max(1, (r as Again).again)}),
        progress = coalesce(${(r as Again).progress ?? null}, progress), updated_at = now() where id = ${job.id}`;
    } else {
      await sql`update jobs set status = 'done', result = ${sql.json(r ?? null)}, error = null, locked_at = null, updated_at = now() where id = ${job.id}`;
    }
  } catch (e: any) {
    const msg = String(e?.message || e).slice(0, 2000);
    const permanent = e instanceof PermanentError;
    const last = permanent || job.attempts >= job.max_attempts;
    const backoff = Math.min(300, 5 * 3 ** (job.attempts - 1));
    console.error(`[job ${job.id} ${job.kind}] ${last ? 'failed' : 'retrying'}: ${msg}`);
    if (last) reportError(e, { where: 'job', job_kind: job.kind, job_id: String(job.id), project_id: job.project_id ?? undefined });
    await sql`update jobs set status = ${last ? 'failed' : 'queued'}, error = ${msg}, locked_at = null, locked_by = null,
      run_after = now() + make_interval(secs => ${last ? 0 : backoff}), updated_at = now() where id = ${job.id}`;
    if (last) {
      const f = handlers.get(job.kind + ':failed');
      if (f) await f(job.payload, ctx).catch((x) => console.error(`[job ${job.id}] failure hook`, x));
    }
  }
}

/** Put jobs whose worker died back in the queue. Live workers refresh locked_at every 30 s (the heartbeat below). */
async function recoverStale() {
  await sql`update jobs set status = 'queued', locked_at = null, locked_by = null, updated_at = now()
    where status = 'running' and locked_at < now() - interval '3 minutes'`;
}

export function startWorker(concurrency = config.workerConcurrency) {
  console.log(`[worker] ${me} started, concurrency ${concurrency}`);
  let lastRecover = 0;
  // Heartbeat: a job stays claimed while it runs here (a long final cut included), and the jobs of a worker that crashed
  // or was killed are picked up again within minutes. A job still running after MAX_RUN_MS is hung: it goes stale too.
  setInterval(() => {
    const live = [...mine].filter(([, t]) => Date.now() - t < MAX_RUN_MS).map(([id]) => id);
    if (live.length) sql`update jobs set locked_at = now() where id in ${sql(live)} and status = 'running' and locked_by = ${me}`
      .catch((e) => console.error('[worker] heartbeat', e.message));
  }, 30_000).unref();
  const loop = async () => {
    while (!stopping) {
      try {
        if (Date.now() - lastRecover > 60_000) { lastRecover = Date.now(); await recoverStale(); }
        if (mine.size >= concurrency) { await sleepOrWake(500); continue; }
        const job = await claim();
        if (!job) { await sleepOrWake(1000); continue; }
        mine.set(job.id, Date.now());
        runOne(job).finally(() => { mine.delete(job.id); kick(); });
      } catch (e) {
        console.error('[worker] loop error', e);
        await sleepOrWake(3000);
      }
    }
  };
  loop();
}

/**
 * Shutting down (a deploy or restart): stop claiming and hand this process's running jobs straight back to the queue,
 * attempt returned, so another instance picks them up at once instead of when they go stale. Call it, then exit.
 */
export async function releaseRunning() {
  stopping = true; kick();
  if (!mine.size) return 0;
  const rows = await sql`update jobs set status = 'queued', attempts = greatest(attempts - 1, 0), locked_at = null, locked_by = null,
    run_after = now(), updated_at = now() where id in ${sql([...mine.keys()])} and status = 'running' and locked_by = ${me} returning id`;
  return rows.length;
}

/** Exit cleanly on SIGTERM/SIGINT. Without a handler Node ignores SIGTERM as a container's PID 1, then gets killed. */
export function exitOnSignals(who: string) {
  for (const s of ['SIGINT', 'SIGTERM'] as const) process.once(s, () => {
    const giveUp = new Promise<never>((_, no) => setTimeout(() => no(new Error('database did not answer in 5 s')), 5000).unref());
    Promise.race([releaseRunning(), giveUp])
      .then((n) => console.log(`[${who}] ${s}: ${n} running job(s) handed back to the queue; exiting`))
      .catch((e) => console.error(`[${who}] ${s}: could not hand jobs back (they resume once stale)`, e))
      .finally(() => process.exit(0));
  });
}

function sleepOrWake(ms: number) {
  return new Promise<void>((res) => {
    const t = setTimeout(() => { wake = null; res(); }, ms);
    wake = () => { clearTimeout(t); res(); };
  });
}

/** Wait until no queued/running jobs remain for a project (used by tests and CLI). */
export async function drain(projectId?: string, timeoutMs = 600_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const [r] = projectId
      ? await sql`select count(*)::int n from jobs where project_id = ${projectId} and status in ('queued','running')`
      : await sql`select count(*)::int n from jobs where status in ('queued','running')`;
    if (!r.n) return;
    await new Promise((res) => setTimeout(res, 500));
  }
  throw new Error('drain timeout');
}
