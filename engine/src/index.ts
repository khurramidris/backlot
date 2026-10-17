// Entry point: API + (optionally) the worker in one process. For scale, run the API with
// RUN_WORKER=0 and start `npm run worker` on one or more separate machines.
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { migrate } from './db.js';
import { registerJobs } from './jobs.js';
import { startCapacityController } from './capacity.js';
import { startWorker } from './queue.js';
import { app } from './server.js';
import { initMonitoring } from './monitoring.js';

await initMonitoring();
if (config.autoMigrate) await migrate();
registerJobs();
await startCapacityController();
if (config.runWorker) startWorker();
serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (i) => console.log(`[api] listening on :${i.port}${config.mock ? ' (MOCK PROVIDERS)' : ''}`));
