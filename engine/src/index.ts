// Entry point: API + (optionally) the worker in one process. For scale, run the API with
// RUN_WORKER=0 and start `npm run worker` on one or more separate machines.
import { serve } from '@hono/node-server';
import { config } from './config.js';
import { migrate } from './db.js';
import { registerJobs } from './jobs.js';
import { startWorker } from './queue.js';
import { app } from './server.js';

if (config.autoMigrate) await migrate();
registerJobs();
if (config.runWorker) startWorker();
serve({ fetch: app.fetch, port: config.port }, (i) => console.log(`[api] listening on :${i.port}${config.mock ? ' (MOCK PROVIDERS)' : ''}`));
