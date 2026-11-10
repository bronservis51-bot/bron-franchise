// Read-only reconciliation. Full transfer/restore must happen separately.
import pg from 'pg';
import { loadEnv, need } from './env.mjs';
import { databaseConfig } from './database-config.mjs';
import { snapshotDatabase, compareSnapshots } from './migration-audit.mjs';
loadEnv();
const sourceUrl = need('SOURCE_DATABASE_URL'), targetUrl = need('TARGET_DATABASE_URL');
const endpoint = value => { const u = new URL(value); return `${u.hostname}:${u.port || '5432'}${u.pathname}`; };
async function state(url) {
  const db = new pg.Client(databaseConfig(url));
  try { await db.connect(); return await snapshotDatabase(db); }
  finally { await db.end(); }
}
try {
  if (endpoint(sourceUrl) === endpoint(targetUrl)) throw new Error('Source and target must be different databases.');
  const source = await state(sourceUrl), target = await state(targetUrl);
  const mismatch = compareSnapshots(source, target);
  if (mismatch.length) { console.error('Mismatch:', mismatch.join(', ')); process.exitCode = 1; }
  else console.log(`Matched ${Object.keys(source).length} data/schema/sequence checks, including Auth identities, password hashes and all application tables. Verify storage bytes, new login, permissions, revoked sessions, late leads and backups separately. This is not migration completion.`);
} catch (error) {
  // Do not log connection objects or dump rows on errors.
  console.error('Migration comparison failed:', error.code || error.message);
  process.exitCode = 1;
}
