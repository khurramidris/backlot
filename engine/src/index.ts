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
const worker = config.runWorker ? startWorker() : null;
const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (i) => console.log(`[api] listening on :${i.port}${config.mock ? ' (MOCK PROVIDERS)' : ''}`));
// A deploy stops this process: take no new work, give running jobs a moment to finish. Anything still running is
// handed back to the queue for the next instance.
for (const s of ['SIGINT', 'SIGTERM'] as const) process.once(s, async () => {
  console.log(`[api] ${s}: stopping`);
  server.close();
  await worker?.stop(20_000);
  process.exit(0);
});
