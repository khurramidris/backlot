import postgres from 'postgres';
import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

// postgres.js connects in plain text unless told otherwise, and Supabase's connection string has no sslmode. A database
// on another machine is encrypted whenever the server offers TLS (libpq's default, 'prefer'); an sslmode in the URL wins.
const remote = !/@(localhost|127\.0\.0\.1|\[::1\])(:\d+)?\//.test(config.databaseUrl) && !/[?&](sslmode|ssl)=/i.test(config.databaseUrl);

export const sql = postgres(config.databaseUrl, {
  ...(remote ? { ssl: 'prefer' as const } : {}),
  max: 10,
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
  await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
  for (const f of files) {
    const [done] = await sql`select 1 from schema_migrations where name = ${f}`;
    if (done) continue;
    const text = await readFile(join(dir, f), 'utf8');
    await sql.begin(async (tx) => {
      await tx.unsafe(text);
      await tx`insert into schema_migrations (name) values (${f}) on conflict do nothing`;
    });
    console.log(`[db] applied ${f}`);
  }
}

/** Convert bigint ids in rows to numbers for JSON responses. */
export function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)));
}
