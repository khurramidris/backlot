// Standalone worker process (no HTTP). Needs FFmpeg on the machine.
import { config } from './config.js';
import { migrate } from './db.js';
import { registerJobs } from './jobs.js';
import { startCapacityController } from './capacity.js';
import { startWorker } from './queue.js';
import { startSnapshots } from './telemetry.js';

if (config.autoMigrate) await migrate();
registerJobs();
await startCapacityController();
await startSnapshots();
const w = startWorker();
for (const s of ['SIGINT', 'SIGTERM'] as const) process.once(s, async () => { await w.stop(20_000); process.exit(0); });
