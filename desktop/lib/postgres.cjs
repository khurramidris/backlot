// The database: a real Postgres that ships inside the app (the `embedded-postgres` package) and keeps its files in
// the app's data folder. Listens on this computer only, with a password made on first run.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { freePort } = require('./util.cjs');

const DB = 'backlot';
const USER = 'backlot';

async function start({ dir, log }) {
  fs.mkdirSync(dir, { recursive: true });
  const dataDir = path.join(dir, 'pgdata');
  const pwFile = path.join(dir, 'pg-password');
  let password;
  try { password = fs.readFileSync(pwFile, 'utf8').trim(); } catch { /* first run */ }
  if (!password) { password = crypto.randomBytes(18).toString('hex'); fs.writeFileSync(pwFile, password, { mode: 0o600 }); }

  const { default: EmbeddedPostgres } = await import('embedded-postgres');
  const port = await freePort(0);
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: USER, password, port, persistent: true,
    onLog: (m) => log('postgres', m), onError: (m) => log('postgres', m),
  });
  if (!fs.existsSync(path.join(dataDir, 'PG_VERSION'))) await pg.initialise();
  await pg.start();
  try { await pg.createDatabase(DB); } catch (e) { if (!/already exists/i.test(String(e && e.message))) throw e; }
  return {
    url: `postgres://${USER}:${password}@127.0.0.1:${port}/${DB}`,
    port,
    stop: async () => { try { await pg.stop(); } catch (e) { log('postgres', `stop: ${e.message}`); } },
  };
}

module.exports = { start };
