// Standalone worker process (no HTTP). Needs FFmpeg on the machine.
import { config } from './config.js';
import { migrate } from './db.js';
import { registerJobs } from './jobs.js';
import { startCapacityController } from './capacity.js';
import { exitOnSignals, startWorker } from './queue.js';

if (config.autoMigrate) await migrate();
registerJobs();
await startCapacityController();
startWorker();
exitOnSignals('worker');
