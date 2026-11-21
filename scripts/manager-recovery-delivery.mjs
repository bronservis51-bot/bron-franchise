import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { databaseConfig } from './database-config.mjs';

const DATABASE_ROLE = 'bron_manager_recovery_mailer';
const MAX_JOBS = 4;
const SMTP_PROCESS_TIMEOUT_MS = 10_000;
const SMTP_SCRIPT = fileURLToPath(new URL('./manager-recovery-smtp.py', import.meta.url));
const APP_URL = /^https:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?(?:\/[a-z0-9_-]+)*\/?$/i;
const DNS_NAME = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
const MAILBOX = /^[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@([a-z0-9.-]+)$/i;
const JOB_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CHECK_DB = `select current_user = $1 and session_user = $1
  and not (rolsuper or rolbypassrls or rolcreaterole or rolcreatedb or rolreplication)
  and pg_has_role(current_user, 'bron_recovery_mailer', 'USAGE')
  and not exists (select 1 from pg_roles r where r.rolname not in (current_user, 'bron_recovery_mailer')
    and pg_has_role(current_user, r.rolname, 'MEMBER'))
  and has_schema_privilege(current_user, 'app_private', 'USAGE')
  and has_function_privilege(current_user, 'app_private.manager_recovery_job_take(text)', 'EXECUTE')
  and has_function_privilege(current_user, 'app_private.manager_recovery_job_finish(uuid,text,boolean)', 'EXECUTE') as allowed
  from pg_roles where rolname = current_user`;

function isMailbox(value) {
  if (typeof value !== 'string' || value.length > 254 || /[\r\n]/.test(value)) return false;
  const match = MAILBOX.exec(value);
  if (!match || !DNS_NAME.test(match[1])) return false;
  const local = value.split('@', 1)[0];
  return local.length <= 64 && !local.startsWith('.') && !local.endsWith('.') && !local.includes('..');
}

function displayLogin(login) {
  if (typeof login !== 'string' || login.length > 254 || /[\x00-\x1f\x7f]/.test(login)) return undefined;
  const phone = /^([1-9][0-9]{9,14})@staff\.bron\.local$/i.exec(login);
  if (phone) return `+${phone[1]}`;
  const short = /^([a-z][a-z0-9._-]{1,39})@access\.bron\.local$/i.exec(login);
  return short?.[1] ?? login;
}

export function readConfig(env) {
  try {
    const value = env.BRON_RECOVERY_APP_BASE_URL;
    if (typeof value !== 'string' || /[\r\n]/.test(value) || !APP_URL.test(value)) throw new Error();
    const app = new URL(value);
    if (!DNS_NAME.test(app.hostname)) throw new Error();
    const appBase = `${app.origin}${app.pathname}${app.pathname.endsWith('/') ? '' : '/'}`;

    const host = env.BRON_RECOVERY_SMTP_HOST;
    const tls = env.BRON_RECOVERY_SMTP_TLS;
    const port = Number(env.BRON_RECOVERY_SMTP_PORT ?? (tls === 'implicit' ? '465' : '587'));
    const username = env.BRON_RECOVERY_SMTP_USERNAME;
    const password = env.BRON_RECOVERY_SMTP_PASSWORD;
    const from = env.BRON_RECOVERY_SMTP_FROM;
    if (!host || /[\r\n]/.test(host) || !DNS_NAME.test(host) || !['implicit', 'starttls'].includes(tls)
      || !Number.isInteger(port) || port < 1 || port > 65_535 || !username || !password
      || /[\r\n]/.test(username + password) || !isMailbox(from)) throw new Error();

    const dbUrl = new URL(env.BRON_RECOVERY_DATABASE_URL);
    if (![DATABASE_ROLE, `${DATABASE_ROLE}.bron-franchise`].includes(dbUrl.username) || !dbUrl.password) throw new Error();
    const database = { ...databaseConfig(dbUrl.href, env), connectionTimeoutMillis: 6_000,
      statement_timeout: 3_000, query_timeout: 4_000, application_name: 'bron-manager-recovery' };
    return { appBase, database, smtp: { host, port, tls, username, password, from } };
  } catch {
    throw new Error('MANAGER_RECOVERY_CONFIGURATION_FAILED');
  }
}

function deliver(payload) {
  return new Promise((resolve, reject) => {
    const failed = () => reject(new Error('SMTP operation failed'));
    const child = spawn('/usr/bin/python3', ['-I', '-B', SMTP_SCRIPT], {
      stdio: ['pipe', 'ignore', 'ignore'], env: {},
      timeout: SMTP_PROCESS_TIMEOUT_MS, killSignal: 'SIGKILL',
    });
    child.once('error', failed);
    child.once('close', code => { if (code === 0) resolve(); else failed(); });
    child.stdin.once('error', failed);
    child.stdin.end(JSON.stringify(payload));
  });
}

async function runQueue(client, config, sendMail) {
  for (let count = 0; count < MAX_JOBS; count++) {
    const token = randomBytes(32).toString('hex');
    const digest = createHash('sha256').update(token, 'ascii').digest('hex');
    const { rows } = await client.query('select * from app_private.manager_recovery_job_take($1)', [digest]);
    if (rows.length === 0) return true;
    const { id, kind, email, login } = rows[0];
    if (rows.length !== 1 || typeof id !== 'string' || !JOB_ID.test(id)) throw new Error('Invalid delivery job');
    let accepted;
    try {
      if (!['confirm', 'reset'].includes(kind) || !isMailbox(email)) throw new Error('Invalid delivery job');
      const link = `${config.appBase}#/recover/${kind}/${token}`;
      await sendMail({ mode: 'send', smtp: config.smtp, email, kind, link,
        login: kind === 'reset' ? displayLogin(login) : undefined });
      accepted = true;
    } catch {
      accepted = false;
    }
    // If the worker loses its database connection after SMTP, the lease
    // controls retry timing and previously sent links remain usable.
    await client.query('select app_private.manager_recovery_job_finish($1,$2,$3)', [id, digest, accepted]);
    if (!accepted) return false;
  }
  return true;
}

export async function runWorker(mode, { env = process.env, Client = pg.Client, sendMail = deliver,
  report = status => process.stderr.write(`${status}\n`) } = {}) {
  let config;
  try {
    if (!['--run', '--check'].includes(mode)) throw new Error();
    config = readConfig(env);
  } catch {
    report('MANAGER_RECOVERY_CONFIGURATION_FAILED');
    return 1;
  }

  let client;
  try {
    client = new Client(config.database);
    // node-postgres can emit idle connection errors out of band. Keep the
    // socket detail private; a failed query reports through this same boundary.
    client.on('error', () => {});
    await client.connect();
    const { rows } = await client.query(CHECK_DB, [DATABASE_ROLE]);
    if (rows[0]?.allowed !== true) throw new Error();

    if (mode === '--check') {
      try { await sendMail({ mode: 'check', smtp: config.smtp }); }
      catch { report('MANAGER_RECOVERY_SMTP_CHECK_FAILED'); return 1; }
      report('MANAGER_RECOVERY_MAIL_CHECK_OK');
    } else if (!await runQueue(client, config, sendMail)) {
      report('MANAGER_RECOVERY_MAIL_DEFERRED');
      return 1;
    }
    return 0;
  } catch {
    report('MANAGER_RECOVERY_DATABASE_FAILED');
    return 1;
  } finally {
    try { await client?.end(); }
    catch { /* The service timeout covers transport shutdown. */ }
  }
}

if (import.meta.main) {
  const [mode = '--run', ...extra] = process.argv.slice(2);
  process.exitCode = await runWorker(extra.length ? null : mode);
}
