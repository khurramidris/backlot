// Standalone worker process (no HTTP). Needs FFmpeg on the machine.
import { config } from './config.js';
import { migrate } from './db.js';
import { registerJobs } from './jobs.js';
import { startCapacityController } from './capacity.js';
import { startWorker } from './queue.js';

if (config.autoMigrate) await migrate();
registerJobs();
await startCapacityController();
const w = startWorker();
for (const s of ['SIGINT', 'SIGTERM'] as const) process.on(s, () => { w.stop(); setTimeout(() => process.exit(0), 2000); });
