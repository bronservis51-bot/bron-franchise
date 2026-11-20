import { sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { databaseConfig } from './database-config.mjs';
import { buildGoogleReports, checkReportPermissions, reportSheetRequests, validateReportBooks } from './google-finance-lib.mjs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.metadata.readonly';
const MAX_RECORDS = 50_000;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

async function readJson(path, label) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch { throw new Error(`Invalid ${label} configuration`); }
}

async function request(url, init) {
  let response;
  try {
    response = await fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new Error('Google connection failed');
  }
  if (!response.ok) throw new Error(`Google returned HTTP ${response.status}`);
  try { return await response.json(); }
  catch { throw new Error('Google response is not JSON'); }
}

async function accessToken() {
  const key = await readJson(requireEnv('GOOGLE_REPORT_KEY_PATH'), 'service account');
  if (key.type !== 'service_account' || typeof key.client_email !== 'string' || typeof key.private_key !== 'string'
    || key.token_uri !== TOKEN_URL) throw new Error('Invalid service account configuration');
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const assertionBody = [encode({ alg: 'RS256', typ: 'JWT' }), encode({
    iss: key.client_email, scope: SCOPES, aud: TOKEN_URL, iat: now, exp: now + 3600,
  })].join('.');
  let signature;
  try { signature = sign('RSA-SHA256', Buffer.from(assertionBody), key.private_key).toString('base64url'); }
  catch { throw new Error('Invalid service account signing key'); }
  const answer = await request(TOKEN_URL, {
    method: 'POST', body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${assertionBody}.${signature}`,
    }),
  });
  if (typeof answer.access_token !== 'string') throw new Error('Google access token unavailable');
  return answer.access_token;
}

async function prepareReport(report, headers) {
  const id = report.spreadsheetId;
  const permissions = await request(
    `https://www.googleapis.com/drive/v3/files/${id}/permissions?fields=nextPageToken,permissions(id,type,role)&pageSize=100&supportsAllDrives=true`, { headers },
  );
  if (permissions.nextPageToken) throw new Error('Report workbook recipients do not match the approved list');
  checkReportPermissions(report.permissions, permissions.permissions);
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${id}`;
  const metadata = await request(`${url}?fields=sheets(properties(sheetId,title,gridProperties),developerMetadata(metadataKey,metadataValue))`, { headers });
  if (!Array.isArray(metadata.sheets)) throw new Error('Invalid report workbook metadata');
  const body = JSON.stringify({ requests: reportSheetRequests(report, metadata.sheets) });
  if (Buffer.byteLength(body) > 8 * 1024 * 1024) throw new Error('Report workbook update is too large');
  return { url: `${url}:batchUpdate`, body };
}

async function readSnapshot(db, from, through) {
  try {
    const { rows } = await db.query('select * from app_private.google_finance_rows($1,$2) limit $3', [from, through, MAX_RECORDS + 1]);
    if (rows.length > MAX_RECORDS) throw new Error('Snapshot too large');
    return rows;
  } catch {
    throw new Error('Finance snapshot unavailable or exceeded the export limit');
  }
}

async function main() {
  const [mode = '--check', ...extra] = process.argv.slice(2);
  if (extra.length || !['--check', '--publish'].includes(mode)) throw new Error('Use --check or --publish');
  const config = await readJson(requireEnv('GOOGLE_REPORT_CONFIG_PATH'), 'report destinations');
  if (!config || typeof config.fromMonth !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])-01$/.test(config.fromMonth)) {
    throw new Error('Expected fromMonth as YYYY-MM-01');
  }
  validateReportBooks(config.books);
  const db = new pg.Client({ ...databaseConfig(requireEnv('GOOGLE_REPORT_DATABASE_URL')),
    statement_timeout: 45000, query_timeout: 50000, application_name: 'bron-google-finance' });
  try { await db.connect(); }
  catch { throw new Error('Reporting database connection failed'); }
  try {
    const lock = await db.query("select pg_try_advisory_lock(hashtextextended('bron-google-finance', 0)) as locked");
    if (!lock.rows[0].locked) throw new Error('A finance export is already running');
    const now = new Date();
    const through = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', dateStyle: 'short' }).format(now);
    if (through < config.fromMonth) throw new Error('Report start month is in the future');
    const records = await readSnapshot(db, config.fromMonth, through);
    const reports = buildGoogleReports(config.books, records, now.toISOString());
    if (mode === '--check') {
      console.log(`Checked ${records.length} accounting records for ${reports.length} workbooks`);
      return;
    }

    const token = await accessToken();
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const prepared = await Promise.all(reports.map(report => prepareReport(report, headers)));
    let failed = 0;
    for (const { url, body } of prepared) {
      try { await request(url, { method: 'POST', headers, body }); }
      catch { failed++; }
    }
    console.log(`Updated ${prepared.length - failed} of ${prepared.length} workbooks with snapshot through ${through} MSK`);
    if (failed) process.exitCode = 1;
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  // Database/client errors can include connection metadata; print only our fixed messages.
  const allowed = /^(Missing |Invalid |Expected |Use --|Report |Duplicate |Reporting |A finance |Finance snapshot |Amount |Google )/;
  console.error(allowed.test(error?.message) ? error.message : 'Google finance export failed');
  process.exitCode = 1;
});
