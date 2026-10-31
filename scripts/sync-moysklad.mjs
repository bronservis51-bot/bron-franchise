// Run on the trusted server. Only GET requests are made to MoySklad.
import pg from 'pg';
import { loadEnv, need } from './env.mjs';
import { normalizeProfitRows } from './supply-lib.mjs';

loadEnv();
const token = need('MOYSKLAD_READ_TOKEN');
const connectionString = need('DATABASE_URL');
const now = new Intl.DateTimeFormat('sv-SE', { timeZone:'Europe/Moscow', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:false }).format(new Date());
const month = process.argv.find(a=>a.startsWith('--month='))?.slice(8) ?? now.slice(0,7);
if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month > now.slice(0,7)) throw new Error('Use --month=YYYY-MM, no future months');
const [year,m] = month.split('-').map(Number);
const last = new Date(Date.UTC(year,m,0)).getUTCDate();
const periodTo = month===now.slice(0,7) ? now : `${month}-${last} 23:59:59`;
const rows = [];
for (let offset=0; ; offset+=200) {
  if (offset>=100000) throw new Error('Pagination safety limit; snapshot unchanged');
  const url = new URL('https://api.moysklad.ru/api/remap/1.2/report/profit/bycounterparty');
  url.search = new URLSearchParams({ momentFrom:`${month}-01 00:00:00`,momentTo:periodTo,limit:'200',offset:String(offset) }).toString();
  let response;
  for (let attempt=0;attempt<3;attempt++) {
    response=await fetch(url,{headers:{Authorization:`Bearer ${token}`,'Accept-Encoding':'gzip'},signal:AbortSignal.timeout(30000)});
    if (response.status!==429) break;
    if (attempt<2) await new Promise(resolve=>setTimeout(resolve,Math.min(10000,Number(response.headers.get('Retry-After')??2)*1000)));
  }
  if (!response?.ok) throw new Error(`MoySklad HTTP ${response?.status}; last successful snapshot retained`);
  const page = await response.json();
  if (!Array.isArray(page.rows) || !Number.isSafeInteger(page.meta?.size)) throw new Error('Incomplete MoySklad response');
  rows.push(...page.rows);
  if (rows.length>=page.meta.size) {
    if (rows.length!==page.meta.size) throw new Error('Report changed during pagination; retry later');
    break;
  }
  if (page.rows.length!==200) throw new Error('Missing report page; snapshot unchanged');
}
const normalized = normalizeProfitRows(rows);
const db = new pg.Client({connectionString});
await db.connect();
try {
  await db.query('begin');
  await db.query('select app_private.supply_store($1,$2::jsonb,$3,$4)',[`${month}-01`,JSON.stringify(normalized),new Date().toISOString(),periodTo]);
  await db.query('commit');
  console.log(`Updated ${month}: ${normalized.length} counterparties, RUB, returns included`);
} catch(e) { await db.query('rollback'); throw e; }
finally { await db.end(); }
