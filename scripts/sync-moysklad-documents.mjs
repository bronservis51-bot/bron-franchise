// Run on the trusted staging server with a dedicated read-only account.
import pg from 'pg';
import { loadEnv, need } from './env.mjs';
import { databaseConfig } from './database-config.mjs';
import { readMonthSnapshots, shiftMonth, documentReader, sourceCostCurrency } from './moysklad-documents-lib.mjs';

loadEnv();
const get = documentReader(need('MOYSKLAD_DOCUMENTS_READ_TOKEN'));
const organization = need('MOYSKLAD_DOCUMENTS_ORGANIZATION_ID');
const observed = new Date();
const current = new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Moscow',year:'numeric',month:'2-digit'}).format(observed) + '-01';
const arg = process.argv.slice(2);
if (arg.length !== 1 || !(arg[0] === '--recent' || /^--month=\d{4}-(0[1-9]|1[0-2])$/.test(arg[0]))) {
  throw new Error('Use --recent or --month=YYYY-MM');
}
const months = arg[0] === '--recent' ? [shiftMonth(current,-1),current] : [arg[0].slice(8) + '-01'];
if (months.some(month => month > current)) throw new Error('Future months cannot be imported');
const costCurrency = await sourceCostCurrency(get);
const snapshots = await readMonthSnapshots(get, months, costCurrency, organization);
const db = new pg.Client(databaseConfig(need('DOCUMENTS_DATABASE_URL')));
await db.connect();
try {
  await db.query('begin');
  for (const {month, documents} of snapshots) {
    await db.query('select app_private.purchase_documents_store($1,$2,$3::jsonb)',[month, observed, JSON.stringify(documents)]);
  }
  await db.query('commit');
  console.log('Completed document refresh for ' + months.join(', '));
} catch {
  await db.query('rollback');
  throw new Error('Could not store document snapshots');
} finally { await db.end(); }
