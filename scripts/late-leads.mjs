import { loadEnv, need } from './env.mjs';
import { databaseConfig } from './database-config.mjs';
import { readSourceLeads, reconcileLateLeads, LeadBridgeError } from './late-leads-lib.mjs';
import { sourceServiceConfig, assertMigrationTarget } from './migration-source.mjs';

loadEnv();
const args = process.argv.slice(2);
if (args.some(a => !['--apply', '--source-service'].includes(a)) || new Set(args).size !== args.length) {
  console.error('Usage: npm run migration:leads -- [--source-service] [--apply]. Default: read-only dry-run.');
  process.exit(1);
}
const service = args.includes('--source-service');
const sourceUrl = service ? undefined : need('SOURCE_DATABASE_URL'), targetUrl = need('TARGET_DATABASE_URL');
const endpoint = value => { const u = new URL(value); return `${u.hostname}:${u.port || '5432'}${u.pathname}`; };
let source, target;
try {
  let sourceConfig;
  if (service) {
    sourceConfig = sourceServiceConfig();
    assertMigrationTarget(targetUrl);
  } else {
    if (endpoint(sourceUrl) === endpoint(targetUrl)) throw new LeadBridgeError('same-database-endpoint');
    sourceConfig = databaseConfig(sourceUrl);
  }
  // The protected source rejects forced native backends before pg is imported.
  const { default: pg } = await import('pg');
  source = new pg.Client({ ...sourceConfig, application_name: 'bron-late-leads-source' });
  target = new pg.Client({ ...databaseConfig(targetUrl), application_name: 'bron-late-leads-target' });
  await source.connect();
  const snapshot = await readSourceLeads(source);
  await source.end(); source = null;
  await target.connect();
  console.log(JSON.stringify(await reconcileLateLeads(target, snapshot, { apply: args.includes('--apply') })));
} catch (error) {
  // Database messages/details can contain contacts, SQL values and credentials.
  console.error('Late-lead reconciliation failed:', error instanceof LeadBridgeError ? error.code : (/^[A-Z0-9_]{3,40}$/.test(error.code || '') ? error.code : 'database-error'));
  process.exitCode = 1;
} finally {
  if (source) await source.end().catch(() => {});
  if (target) await target.end().catch(() => {});
}
