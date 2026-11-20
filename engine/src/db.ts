import postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

// postgres.js connects in plain text unless told otherwise, and Supabase's connection string has no sslmode. A database
// on another machine is encrypted whenever the server offers TLS (libpq's default, 'prefer'); an sslmode in the URL wins.
const remote = !/@(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(config.databaseUrl) && !/[?&](sslmode|ssl)=/i.test(config.databaseUrl);

// Which service holds a connection (the ops dashboard groups them by this name): the app, a separate worker, or ops.
const script = basename(process.argv[1] || '');
const appName = /^ops\.[jt]s$/.test(script) ? 'backlot-ops' : /^worker\.[jt]s$/.test(script) ? 'backlot-worker' : 'backlot';

export const sql = postgres(config.databaseUrl, {
  ...(remote ? { ssl: 'prefer' as const } : {}),
  connection: { application_name: appName },
  // Supabase's session pooler allows only so many connections in all: the dashboard makes do with a few.
  max: Number(process.env.DB_POOL_MAX) || (appName === 'backlot-ops' ? 3 : 10),
  idle_timeout: 30,
  onnotice: () => {},
  // Supabase's pooler (port 6543, transaction mode) does not support prepared statements.
  prepare: !/:6543\b/.test(config.databaseUrl),
  types: { bigint: postgres.BigInt },
});

export type Sql = typeof sql;

const here = dirname(fileURLToPath(import.meta.url));

export async function migrate() {
  const dir = join(here, '..', 'db', 'migrations');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  // Instances starting together take turns: each migration runs under a lock and is re-checked inside it.
  const LOCK = 7_212_650;
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK})`;
    await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  });
  for (const f of files) {
    const [done] = await sql`select 1 from schema_migrations where name = ${f}`;
    if (done) continue;
    const text = await readFile(join(dir, f), 'utf8');
    const applied = await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${LOCK})`;
      if ((await tx`select 1 from schema_migrations where name = ${f}`).length) return false;
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${f})`;
      return true;
    });
    if (applied) console.log(`[db] applied ${f}`);
  }
}

/** Convert bigint ids in rows to numbers for JSON responses. */
export function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)));
}
