import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { readConfig, runWorker } from '../../scripts/manager-recovery-delivery.mjs';

const host = 'https://preview.example.invalid/cabinet/';
const recipient = 'test-only@example.invalid';
const baseEnv = {
  BRON_RECOVERY_DATABASE_URL: 'postgresql://bron_manager_recovery_mailer:synthetic-password@db.example.invalid/bron',
  BRON_RECOVERY_APP_BASE_URL: host,
  BRON_RECOVERY_SMTP_HOST: 'smtp.example.invalid',
  BRON_RECOVERY_SMTP_TLS: 'implicit',
  BRON_RECOVERY_SMTP_PORT: '465',
  BRON_RECOVERY_SMTP_USERNAME: 'synthetic-smtp-account',
  BRON_RECOVERY_SMTP_PASSWORD: 'synthetic-smtp-password',
  BRON_RECOVERY_SMTP_FROM: 'recovery@example.invalid',
};

function database(jobs, { allowed = true, finishError } = {}) {
  const events = [];
  class Client {
    on() {}
    async connect() { events.push('connect'); }
    async query(sql, params = []) {
      if (sql.includes('has_function_privilege')) { events.push('permission'); return { rows: [{ allowed }] }; }
      if (sql.includes('manager_recovery_job_take')) { events.push({ take: params }); return { rows: jobs.length ? [jobs.shift()] : [] }; }
      if (sql.includes('manager_recovery_job_finish')) {
        events.push({ finish: params });
        if (finishError) throw finishError;
        return { rows: [] };
      }
      throw new Error('unexpected query');
    }
    async end() { events.push('disconnect'); }
  }
  return { Client, events };
}

test('the configuration refuses credential-bearing app URLs, fragments, query strings and SMTP downgrade', () => {
  for (const url of ['http://preview.example.invalid/', 'https://user:pass@host.invalid/',
    'https://preview.example.invalid/../cabinet', 'https://preview.example.invalid/path?x=1',
    'https://preview.example.invalid/#/recover', 'https://preview.example.invalid/path%2fother']) {
    assert.throws(() => readConfig({ ...baseEnv, BRON_RECOVERY_APP_BASE_URL: url }), /CONFIGURATION_FAILED/);
  }
  assert.throws(() => readConfig({ ...baseEnv, BRON_RECOVERY_SMTP_TLS: 'off' }), /CONFIGURATION_FAILED/);
  assert.throws(() => readConfig({ ...baseEnv, BRON_RECOVERY_SMTP_FROM: 'x@example.invalid\r\nBcc: test2@example.invalid' }), /CONFIGURATION_FAILED/);
  assert.throws(() => readConfig({ ...baseEnv, BRON_RECOVERY_DATABASE_URL: 'postgresql://postgres:pwd@db.example.invalid/bron' }), /CONFIGURATION_FAILED/);
  assert.equal(readConfig(baseEnv).appBase, host);
});

test('delivery sends one random fixed-origin link per job and stores only the corresponding SHA-256 digest', async () => {
  const jobs = ['confirm', 'reset'].map((kind, index) => ({ id: `00000000-0000-0000-0000-00000000000${index}`,
    email: recipient, kind, login: '79000001234@staff.bron.local', link: 'https://untrusted.example.invalid' }));
  const db = database([...jobs]);
  const out = [];
  const mail = [];
  assert.equal(await runWorker('--run', { env: baseEnv, Client: db.Client, report: s => out.push(s),
    sendMail: async payload => { await Promise.resolve(); db.events.push('accepted'); mail.push(payload); } }), 0);
  assert.equal(mail.length, 2);
  const hashes = db.events.filter(event => event.take).map(event => event.take[0]);
  assert.deepEqual(db.events.slice(2, 8), [
    { take: [hashes[0]] }, 'accepted', { finish: [jobs[0].id, hashes[0], true] },
    { take: [hashes[1]] }, 'accepted', { finish: [jobs[1].id, hashes[1], true] },
  ]);
  for (const [index, kind] of ['confirm', 'reset'].entries()) {
    const { link, email } = mail[index];
    assert.equal(email, recipient);
    const token = link.slice(-64);
    assert.match(token, /^[0-9a-f]{64}$/);
    assert.equal(link, `${host}#/recover/${kind}/${token}`);
    assert.equal(hashes[index], createHash('sha256').update(token, 'ascii').digest('hex'));
    assert.doesNotMatch(out.join(), new RegExp(`${token}|${hashes[index]}|synthetic|example.invalid|79000001234`));
  }
  assert.equal(mail[0].login, undefined);
  assert.equal(mail[1].login, '+79000001234');
  assert.notEqual(mail[0].link.slice(-64), mail[1].link.slice(-64));
  assert.equal(db.events.at(-1), 'disconnect');
});

test('a rejected delivery finishes only its claimed id and digest with a sanitized failure', async () => {
  const id = '00000000-0000-0000-0000-000000000009';
  const db = database([{ id, email: recipient, kind: 'reset', login: 'private.login@access.bron.local' }]);
  const out = [];
  let attemptedLogin;
  assert.equal(await runWorker('--run', { env: baseEnv, Client: db.Client, report: s => out.push(s), sendMail: payload => {
    attemptedLogin = payload.login;
    throw new Error(`${payload.email} ${payload.link} ${payload.login} ${payload.smtp.password}`);
  } }), 1);
  assert.equal(attemptedLogin, 'private.login');
  assert.deepEqual(db.events.slice(2), [
    { take: db.events.find(e => e.take).take }, { finish: [id, db.events.find(e => e.take).take[0], false] }, 'disconnect',
  ]);
  assert.deepEqual(out, ['MANAGER_RECOVERY_MAIL_DEFERRED']);
});

test('a database failure after SMTP acceptance leaves the claim to the lease and stops the run', async () => {
  const job = { id: '00000000-0000-0000-0000-000000000008', email: recipient, kind: 'confirm' };
  const queued = [job, { ...job, id: '00000000-0000-0000-0000-000000000009' }];
  const db = database(queued, { finishError: new Error(`${recipient} private-db-error`) });
  const out = [];
  assert.equal(await runWorker('--run', { env: baseEnv, Client: db.Client, report: s => out.push(s),
    sendMail: () => db.events.push('accepted') }), 1);
  const { take } = db.events[2];
  assert.deepEqual(db.events.slice(2), [
    { take }, 'accepted', { finish: [job.id, take[0], true] }, 'disconnect',
  ]);
  assert.equal(queued.length, 1);
  assert.deepEqual(out, ['MANAGER_RECOVERY_DATABASE_FAILED']);
});

test('invalid mail data fails the claim before invoking SMTP', async () => {
  const id = '00000000-0000-0000-0000-000000000006';
  const db = database([{ id, email: `${recipient}\r\nBcc: other@example.invalid`, kind: 'reset' }]);
  const out = [];
  let sent = false;
  assert.equal(await runWorker('--run', { env: baseEnv, Client: db.Client, report: s => out.push(s),
    sendMail: () => { sent = true; } }), 1);
  assert.equal(sent, false);
  assert.deepEqual(db.events.find(e => e.finish).finish, [id, db.events.find(e => e.take).take[0], false]);
  assert.deepEqual(out, ['MANAGER_RECOVERY_MAIL_DEFERRED']);
});

test('health checks verify the dedicated DB account and SMTP auth without claiming or addressing jobs', async () => {
  const db = database([]);
  const calls = [];
  const out = [];
  assert.equal(await runWorker('--check', { env: baseEnv, Client: db.Client, report: s => out.push(s),
    sendMail: payload => calls.push(payload) }), 0);
  assert.deepEqual(db.events, ['connect', 'permission', 'disconnect']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].mode, 'check');
  assert.equal(calls[0].email, undefined);
  assert.deepEqual(out, ['MANAGER_RECOVERY_MAIL_CHECK_OK']);

  const denied = database([], { allowed: false });
  assert.equal(await runWorker('--check', { env: baseEnv, Client: denied.Client, report: s => out.push(s),
    sendMail: () => assert.fail('SMTP accessed with wrong DB role') }), 1);
  assert.equal(out.at(-1), 'MANAGER_RECOVERY_DATABASE_FAILED');
});

test('a busy queue is bounded per systemd run', async () => {
  const db = database(Array.from({ length: 10 }, () => ({ id: '00000000-0000-0000-0000-000000000001', email: recipient, kind: 'confirm' })));
  let sent = 0;
  assert.equal(await runWorker('--run', { env: baseEnv, Client: db.Client, report: () => {}, sendMail: () => { sent++; } }), 0);
  assert.equal(sent, 4);
  assert.equal(db.events.filter(event => event.take).length, 4);
  assert.equal(db.events.filter(event => event.finish).length, 4);
});

test('the real PostgreSQL health query allows inherited worker access and refuses unrelated role memberships', async () => {
  const out = [];
  let authenticated = 0;
  for (const extraMembership of [false, true]) {
    const sql = new PGlite();
    class Client {
      on() {}
      async connect() { await sql.exec('set session authorization bron_manager_recovery_mailer'); }
      async query(query, params) { return sql.query(query, params); }
      async end() {}
    }
    try {
      await sql.exec(`create role bron_recovery_mailer nologin;
        create role bron_manager_recovery_mailer login inherit;
        grant bron_recovery_mailer to bron_manager_recovery_mailer;
        create schema app_private;
        create function app_private.manager_recovery_job_take(text) returns void language sql as 'select';
        create function app_private.manager_recovery_job_finish(uuid,text,boolean) returns void language sql as 'select';
        revoke all on all functions in schema app_private from public;
        grant usage on schema app_private to bron_recovery_mailer;
        grant execute on all functions in schema app_private to bron_recovery_mailer;`);
      if (extraMembership) await sql.exec(`create role unrelated_recovery_fixture nologin;
        grant unrelated_recovery_fixture to bron_manager_recovery_mailer;`);
      assert.equal(await runWorker('--check', { env: baseEnv, Client, report: status => out.push(status),
        sendMail: () => { authenticated++; } }), extraMembership ? 1 : 0);
    } finally {
      await sql.close();
    }
  }
  assert.equal(authenticated, 1);
  assert.deepEqual(out, ['MANAGER_RECOVERY_MAIL_CHECK_OK', 'MANAGER_RECOVERY_DATABASE_FAILED']);
});
