// Run on the trusted server. Only GET requests are made to MoySklad.
import pg from 'pg';
import { loadEnv, need } from './env.mjs';
import { databaseConfig } from './database-config.mjs';
import { normalizeProfitRows } from './supply-lib.mjs';

const PAGE_SIZE = 200;
const MAX_ROWS = 10_000;

async function readPage(token, month, periodTo, offset) {
  const url = new URL('https://api.moysklad.ru/api/remap/1.2/report/profit/bycounterparty');
  url.search = new URLSearchParams({
    momentFrom: `${month}-01 00:00:00`, momentTo: periodTo, limit: String(PAGE_SIZE), offset: String(offset),
  }).toString();
  let response;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip' },
        redirect: 'error', signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('MoySklad report could not be read');
    }
    if (response.status !== 429 || attempt === 2) break;
    await response.body?.cancel();
    const retryAfter = Number(response.headers.get('Retry-After') ?? 2);
    const wait = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : 2;
    await new Promise(resolve => setTimeout(resolve, Math.min(10_000, wait * 1000)));
  }
  if (!response?.ok) throw new Error(`MoySklad HTTP ${response?.status}; last successful snapshot retained`);
  try {
    return await response.json();
  } catch {
    throw new Error('Invalid MoySklad report JSON');
  }
}

async function readReport(token, month, periodTo) {
  const rows = [];
  let total;
  for (let offset = 0; total === undefined || offset < total; offset += PAGE_SIZE) {
    const page = await readPage(token, month, periodTo, offset);
    const size = page?.meta?.size;
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_ROWS || !Array.isArray(page.rows)) {
      throw new Error('Incomplete MoySklad response');
    }
    if (total === undefined) total = size;
    if (size !== total || (page.meta.offset !== undefined && page.meta.offset !== offset)) {
      throw new Error('MoySklad report changed during pagination');
    }
    if (page.rows.length !== Math.min(PAGE_SIZE, total - offset)) {
      throw new Error('Incomplete MoySklad report page');
    }
    rows.push(...page.rows);
  }
  return normalizeProfitRows(rows);
}

async function storeReport(config, month, periodTo, fetchedAt, rows) {
  const db = new pg.Client({ ...config, statement_timeout: 30_000, query_timeout: 35_000, application_name: 'bron-moysklad-sync' });
  await db.connect();
  try {
    await db.query('begin');
    await db.query('select app_private.supply_store($1,$2::jsonb,$3,$4)', [`${month}-01`, JSON.stringify(rows), fetchedAt, periodTo]);
    await db.query('commit');
  } catch {
    await db.query('rollback');
    throw new Error('Could not store MoySklad report');
  } finally {
    await db.end();
  }
}

loadEnv();
const token = need('MOYSKLAD_READ_TOKEN');
// A delayed run keeps its original observation time and cannot replace a newer snapshot.
const startedAt = new Date();
const moscowNow = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
}).format(startedAt);
const currentMonth = moscowNow.slice(0, 7);
const [arg, ...extraArgs] = process.argv.slice(2);
const month = arg?.startsWith('--month=') ? arg.slice(8) : currentMonth;
if (extraArgs.length || (arg && arg !== '--recent' && !arg.startsWith('--month=')) ||
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month > currentMonth) {
  throw new Error('Use --month=YYYY-MM or --recent, no future months');
}
const previousMonthEnd = new Date(`${currentMonth}-01T00:00:00Z`);
previousMonthEnd.setUTCDate(0);
const months = arg === '--recent' ? [currentMonth, previousMonthEnd.toISOString().slice(0, 7)] : [month];
const config = databaseConfig(need(arg === '--recent' ? 'TARGET_DATABASE_URL' : 'DATABASE_URL'));

const failed = [];
for (const selectedMonth of months) {
  const monthEnd = new Date(`${selectedMonth}-01T00:00:00Z`);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  const periodTo = selectedMonth === currentMonth ? moscowNow : `${monthEnd.toISOString().slice(0, 10)} 23:59:59`;
  let rows;
  try {
    rows = await readReport(token, selectedMonth, periodTo);
  } catch (error) {
    console.error(`${selectedMonth}: ${error.message}`);
    failed.push(selectedMonth);
    continue;
  }
  try {
    await storeReport(config, selectedMonth, periodTo, startedAt.toISOString(), rows);
    console.log(`Synced ${selectedMonth}: ${rows.length} counterparties, through ${periodTo} MSK, RUB, returns included`);
  } catch {
    console.error(`${selectedMonth}: could not store the MoySklad report`);
    failed.push(selectedMonth);
  }
}
if (failed.length) throw new Error(`MoySklad sync failed: ${failed.join(', ')}`);
