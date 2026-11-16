// Read-only reconciliation. Full transfer/restore must happen separately.
import { loadEnv, need } from './env.mjs';
import { databaseConfig } from './database-config.mjs';
import { snapshotDatabase, compareSnapshots } from './migration-audit.mjs';
import { sourceServiceConfig, assertMigrationTarget, MigrationSourceError } from './migration-source.mjs';
const endpoint = value => { const u = new URL(value); return `${u.hostname}:${u.port || '5432'}${u.pathname}`; };
async function state(config, Client) {
  const db = new Client(config);
  try { await db.connect(); return await snapshotDatabase(db); }
  finally { await db.end(); }
}
try {
  loadEnv();
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--source-service'))
    throw new MigrationSourceError('MIGRATION_CHECK_USAGE');
  const service = args[0] === '--source-service';
  const targetUrl = need('TARGET_DATABASE_URL');
  let sourceConfig;
  if (service) {
    sourceConfig = sourceServiceConfig();
    assertMigrationTarget(targetUrl);
  } else {
    const sourceUrl = need('SOURCE_DATABASE_URL');
    if (endpoint(sourceUrl) === endpoint(targetUrl))
      throw new MigrationSourceError('MIGRATION_SAME_DATABASE_ENDPOINT');
    sourceConfig = databaseConfig(sourceUrl);
  }
  // The source factory rejects native-backend overrides before importing pg.
  const { default: pg } = await import('pg');
  const source = await state(sourceConfig, pg.Client), target = await state(databaseConfig(targetUrl), pg.Client);
  const mismatch = compareSnapshots(source, target);
  if (mismatch.length) { console.error('Mismatch:', mismatch.join(', ')); process.exitCode = 1; }
  else console.log(`Matched ${Object.keys(source).length} data/schema/sequence checks, including Auth identities, password hashes and all application tables. Verify storage bytes, new login, permissions, revoked sessions, late leads and backups separately. This is not migration completion.`);
} catch (error) {
  // Do not log connection objects or dump rows on errors.
  console.error('Migration comparison failed:', /^[A-Z0-9_]{3,60}$/.test(error.code || '') ? error.code : 'DATABASE_ERROR');
  process.exitCode = 1;
}
