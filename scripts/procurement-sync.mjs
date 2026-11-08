// Run only on a trusted server. This process does not create orders or reserve inventory.
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { loadEnv, need } from './env.mjs';
import { createMoyskladReader, readSyncConfig, parseCatalogMap, collectCatalog, replaceCatalog } from './procurement-sync-lib.mjs';

loadEnv();
const config = readSyncConfig(process.env);
const reader = createMoyskladReader(need('MOYSKLAD_READ_TOKEN'));
const connectionString = need('DATABASE_URL');
let db;
try {
  if (process.env.PROCUREMENT_CATALOG_MAP_FILE !== undefined) {
    // A missing, malformed or empty configured file aborts. Never silently widen to the whole category.
    try {
      config.catalogMap = parseCatalogMap(JSON.parse(readFileSync(process.env.PROCUREMENT_CATALOG_MAP_FILE, 'utf8')));
    } catch {
      throw new Error('Procurement sync: reviewed catalog map is missing or invalid; previous snapshot retained');
    }
  }
  const snapshot = await collectCatalog(reader, config);
  db = new pg.Client({ connectionString, connectionTimeoutMillis: 15_000, statement_timeout: 60_000 });
  await db.connect();
  await replaceCatalog(db, snapshot);
  console.log(`Procurement snapshot updated: ${snapshot.rows.length} items; source time ${snapshot.fetchedAt}. No orders or reservations created.`);
} catch (error) {
  // Only controlled adapter messages are safe; driver errors may include sensitive connection details.
  const message = error instanceof Error && error.message.startsWith('Procurement sync:')
    ? error.message : 'Procurement sync failed; previous snapshot retained. Check the server connection without logging credentials.';
  console.error(message);
  process.exitCode = 1;
} finally {
  if (db) await db.end().catch(() => {});
}
