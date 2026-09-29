// Error alerts. With SENTRY_DSN set, server errors and jobs that fail for good are sent to Sentry, which emails
// you and groups repeats. Without it, errors only go to the logs (Railway → Deployments → Logs).

import { config } from './config.js';

let sentry: typeof import('@sentry/node') | null = null;

export async function initMonitoring() {
  if (!config.sentryDsn) return;
  sentry = await import('@sentry/node');
  sentry.init({ dsn: config.sentryDsn, environment: process.env.NODE_ENV || 'development', tracesSampleRate: 0 });
  process.on('unhandledRejection', (e) => reportError(e, { where: 'unhandledRejection' }));
  console.log('[monitoring] Sentry on');
}

/** Send an unexpected error to Sentry (when configured). `context` shows up as tags and extra data. */
export function reportError(err: unknown, context: Record<string, unknown> = {}) {
  if (!sentry) return;
  sentry.withScope((scope) => {
    for (const [k, v] of Object.entries(context)) {
      if (typeof v === 'string' && v.length < 200) scope.setTag(k, v);
      else scope.setExtra(k, v);
    }
    sentry!.captureException(err);
  });
}
