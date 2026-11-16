// One-off T09: target-only reconciliation of the three proven Auth timestamps.
// Execute as a file with the existing private VPS Node runtime. Never print rows/config.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';

const RUNTIME = '/opt/bron/audit-runtime-c128f9b';
const SECRETS = '/root/bron-secrets';
const AUDITOR_SHA256 = 'd63fbef0ab6fbed0bb3d09ed6d067ca5f7753d47a981bdb4c4bc8a4719468931';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const usersSql = `SELECT u.id::text AS id,to_jsonb(u)::text AS record,
  (to_jsonb(u)-'updated_at')::text AS rest,to_jsonb(u)->>'updated_at' AS updated_at,
  (extract(epoch FROM u.updated_at)*1000000)::bigint::text AS micros
  FROM auth.users u ORDER BY to_jsonb(u)::text COLLATE "C"`;
const triggersSql = `SELECT tgname,tgenabled,tgtype,tgfoid::text AS function_oid
  FROM pg_trigger WHERE tgrelid='auth.users'::regclass AND NOT tgisinternal ORDER BY tgname`;

// Dependencies are explicit so the exact transaction can be tested on isolated PGlite.
export async function reconcileAuthTimestamps({ source, target, audit, verifyTarget, saveBeforeImage }) {
  let sourceTransaction = false, targetTransaction = false, commitAttempted = false;
  try {
    const beforeSource = await audit.snapshotDatabase(source);
    const beforeTarget = await audit.snapshotDatabase(target);
    if (JSON.stringify(audit.compareSnapshots(beforeSource, beforeTarget)) !== '["data:auth.users"]')
      fail('T09_PREAUDIT_MISMATCH');
    if (beforeSource['data:auth.users']?.count !== 16 || beforeTarget['data:auth.users']?.count !== 16)
      fail('T09_AUTH_ROW_COUNT');

    await source.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    sourceTransaction = true;
    await source.query("SET LOCAL timezone='UTC'");
    await source.query('SET LOCAL search_path=pg_catalog');
    if ((await source.query("SELECT current_setting('transaction_read_only') AS mode")).rows[0]?.mode !== 'on')
      fail('T09_SOURCE_NOT_READ_ONLY');
    const sourceUsers = (await source.query(usersSql)).rows;
    if (audit.fingerprintRows(sourceUsers.map(u => u.record)) !== beforeSource['data:auth.users'].hash)
      fail('T09_SOURCE_CHANGED_SINCE_PREAUDIT');

    await target.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE');
    targetTransaction = true;
    await target.query("SET LOCAL timezone='UTC'");
    await target.query('SET LOCAL search_path=pg_catalog');
    await target.query("SET LOCAL statement_timeout='30s'");
    await target.query("SET LOCAL lock_timeout='5s'");
    // Block inserts/DDL as well as concurrent updates before taking this RR snapshot.
    await target.query('LOCK TABLE auth.users IN SHARE ROW EXCLUSIVE MODE');
    await verifyTarget(target, 'off');
    const triggers = (await target.query(triggersSql)).rows;
    if (triggers.some(t => (Number(t.tgtype) & 16) !== 0 && t.tgenabled !== 'D'))
      fail('T09_AUTH_UPDATE_TRIGGER_PRESENT');
    const targetUsers = (await target.query(usersSql + ' FOR UPDATE OF u')).rows;
    if (audit.fingerprintRows(targetUsers.map(u => u.record)) !== beforeTarget['data:auth.users'].hash)
      fail('T09_TARGET_CHANGED_SINCE_PREAUDIT');
    const targetById = new Map(targetUsers.map(u => [u.id, u]));
    if (sourceUsers.length !== 16 || targetUsers.length !== 16 || targetById.size !== 16 ||
        new Set(sourceUsers.map(u => u.id)).size !== 16 || sourceUsers.some(u => !targetById.has(u.id)))
      fail('T09_AUTH_ID_SET_MISMATCH');

    const changes = [];
    for (const row of sourceUsers) {
      const other = targetById.get(row.id);
      if (row.rest !== other.rest) fail('T09_AUTH_NON_TIMESTAMP_DIFFERENCE');
      if (row.record === other.record) continue;
      if (!row.updated_at || !other.updated_at || !/^-?\d+$/.test(row.micros ?? '') ||
          !/^-?\d+$/.test(other.micros ?? '') || BigInt(row.micros) <= BigInt(other.micros))
        fail('T09_AUTH_TIMESTAMP_DIRECTION');
      changes.push({ source: row, target: other });
    }
    if (changes.length !== 3) fail('T09_AUTH_DIFF_COUNT');
    await saveBeforeImage(changes.map(({ source: row, target: other }) => ({
      id: row.id, target_updated_at: other.updated_at, source_updated_at: row.updated_at,
    })));

    for (const { source: row, target: other } of changes) {
      const result = await target.query(`UPDATE auth.users AS u SET updated_at=$1::timestamptz
        WHERE u.id=$2::uuid AND to_jsonb(u)=$3::jsonb RETURNING u.id::text AS id`,
      [row.updated_at, row.id, other.record]);
      if (result.rows.length !== 1 || result.rows[0].id !== row.id) fail('T09_AUTH_UPDATE_GUARD_FAILED');
    }
    const afterUsers = (await target.query(usersSql)).rows;
    if (afterUsers.length !== 16 || audit.fingerprintRows(afterUsers.map(u => u.record)) !==
        audit.fingerprintRows(sourceUsers.map(u => u.record))) fail('T09_AUTH_FINAL_ROWS_MISMATCH');
    if (JSON.stringify((await target.query(triggersSql)).rows) !== JSON.stringify(triggers))
      fail('T09_AUTH_TRIGGERS_CHANGED');
    await verifyTarget(target, 'off');
    await source.query('ROLLBACK');
    sourceTransaction = false;
    commitAttempted = true;
    await target.query('COMMIT');
    targetTransaction = false;
    return { updatedRows: 3, sourceRows: 16, targetRows: 16, beforeimageSaved: true };
  } catch (error) {
    if (commitAttempted) fail('T09_COMMIT_RESULT_UNKNOWN');
    throw error;
  } finally {
    if (targetTransaction) await target.query('ROLLBACK').catch(() => {});
    if (sourceTransaction) await source.query('ROLLBACK').catch(() => {});
  }
}

function saveBeforeImage(changes) {
  const info = fs.lstatSync(SECRETS);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o077))
    fail('T09_BACKUP_DIRECTORY_UNSAFE');
  const filename = path.join(SECRETS, `t09-auth-timestamps-${randomUUID()}.json`);
  const fd = fs.openSync(filename, fs.constants.O_CREAT | fs.constants.O_EXCL |
    fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    if (fs.fstatSync(fd).uid !== 0) fail('T09_BACKUP_FILE_UNSAFE');
    fs.writeFileSync(fd, JSON.stringify({ task: 'T09', changes }) + '\n');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  const directory = fs.openSync(SECRETS, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

async function main() {
  let phase = 'source-config', source, target, probeTransaction = false;
  try {
    const { sourceServiceConfig, assertMigrationTarget } = await import(`${RUNTIME}/scripts/migration-source.mjs`);
    const { databaseConfig } = await import(`${RUNTIME}/scripts/database-config.mjs`);
    const sourceConfig = sourceServiceConfig();
    if (createHash('sha256').update(fs.readFileSync(`${RUNTIME}/scripts/migration-audit.mjs`)).digest('hex') !== AUDITOR_SHA256)
      fail('T09_AUDITOR_SHA_MISMATCH');
    const audit = await import(`${RUNTIME}/scripts/migration-audit.mjs`);
    phase = 'target-container-config';
    const records = JSON.parse(execFileSync('docker', ['--host', 'unix:///var/run/docker.sock', 'inspect', 'supabase-db'], {
      encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    }));
    const container = records[0];
    if (records.length !== 1 || container?.Name !== '/supabase-db' || !container.State?.Running)
      fail('T09_TARGET_CONTAINER_NOT_RUNNING');
    const values = {};
    for (const entry of container.Config?.Env ?? []) {
      const split = entry.indexOf('='), key = entry.slice(0, split);
      if (split < 1 || !['POSTGRES_PASSWORD','PGPASSWORD','POSTGRES_USER','POSTGRES_DB'].includes(key)) continue;
      if (Object.hasOwn(values, key)) fail('T09_TARGET_DUPLICATE_CONFIG');
      values[key] = entry.slice(split + 1);
    }
    if (!values.POSTGRES_PASSWORD || (values.PGPASSWORD !== undefined && values.PGPASSWORD !== values.POSTGRES_PASSWORD))
      fail('T09_TARGET_PASSWORD_CONFIG');
    if (values.POSTGRES_USER !== 'supabase_admin' || values.POSTGRES_DB !== 'postgres')
      fail('T09_TARGET_ADMIN_OR_DATABASE');
    const addresses = Object.values(container.NetworkSettings?.Networks ?? {})
      .flatMap(network => [network.IPAddress,network.GlobalIPv6Address]).filter(Boolean);
    if (!addresses.length) fail('T09_TARGET_CONTAINER_ADDRESS_MISSING');
    const url = new URL('postgresql://supabase_admin@127.0.0.1:15433/postgres?sslmode=disable');
    url.password = encodeURIComponent(values.POSTGRES_PASSWORD);
    assertMigrationTarget(url.href);
    const childEnv = { ...process.env, BRON_DB_ALLOW_LOCAL_PLAIN: '1', TARGET_DATABASE_URL: url.href };
    const pg = createRequire(`${RUNTIME}/package.json`)('pg');
    target = new pg.Client({ ...databaseConfig(url.href, childEnv), query_timeout: 30000 });
    source = new pg.Client({ ...sourceConfig, query_timeout: 60000 });
    const verifyTarget = async (db, mode) => {
      const row = (await db.query(`SELECT current_database() AS db,current_user AS role,
        host(inet_server_addr()) AS server_addr,inet_server_port() AS server_port,
        current_setting('transaction_read_only') AS read_only,
        current_setting('cron.launch_active_jobs') AS cron_launch,
        current_setting('pg_net.batch_size') AS net_batch`)).rows[0];
      if (row?.db !== 'postgres' || row.role !== 'supabase_admin' || !addresses.includes(row.server_addr) ||
          row.server_port !== 5432 || row.read_only !== mode) fail('T09_TARGET_IDENTITY_MISMATCH');
      if (row.cron_launch !== 'off' || row.net_batch !== '0') fail('T09_TARGET_ISOLATION_MISMATCH');
    };
    phase = 'target-readonly-probe';
    await target.connect();
    await target.query('BEGIN READ ONLY');
    probeTransaction = true;
    await verifyTarget(target, 'on');
    await target.query('ROLLBACK');
    probeTransaction = false;
    await source.connect();
    phase = 'guarded-target-auth-timestamps';
    const result = await reconcileAuthTimestamps({ source, target, audit, verifyTarget, saveBeforeImage });
    console.log('T09_TARGET_PATCH_COMMITTED', JSON.stringify(result));
    phase = 'post-commit-full-audit';
    const checked = spawnSync(process.execPath, ['scripts/migration-check.mjs','--source-service'], {
      cwd: RUNTIME, env: childEnv, stdio: ['ignore','inherit','inherit'],
    });
    if (checked.error || checked.signal || checked.status === null) fail('T09_AUDIT_EXIT_STATUS_UNAVAILABLE');
    console.log('T09_AUDIT_EXIT_STATUS', checked.status);
    process.exitCode = checked.status;
    if (checked.status !== 0) return;
    let failed = false;
    for (const [label, filename, exported] of [
      ['T09_TARGET_ACCESS','./t09-access-readonly.mjs','runTargetAccessChecks'],
      ['T09_TARGET_HTTP','./t09-http-readonly.mjs','runTargetHttpChecks'],
    ]) {
      phase = label;
      try {
        const checks = await (await import(filename))[exported](target);
        console.log(label, JSON.stringify(checks));
        if (checks.status !== 'PASS') failed = true;
      } catch (error) {
        const code = /^[A-Z0-9_]{3,60}$/.test(error.code ?? '') ? error.code : 'TARGET_CHECK_FAILED';
        console.error(label, JSON.stringify({ status:'FAIL',code }));
        failed = true;
      }
    }
    process.exitCode = failed ? 3 : 0;
  } catch (error) {
    const code = /^[A-Z0-9_]{3,60}$/.test(error.code ?? '') ? error.code : 'T09_OPERATION_FAILED';
    console.error('T09_BLOCKED', phase, code);
    process.exitCode = 2;
  } finally {
    if (target) {
      if (probeTransaction) await target.query('ROLLBACK').catch(() => {});
      await target.end().catch(() => {});
    }
    if (source) await source.end().catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
