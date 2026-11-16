import assert from 'node:assert/strict';
import test from 'node:test';
import { exactQueryFingerprint } from '../../docs/runbooks/payloads/exact-query-fingerprint.mjs';

const QUERY = 'select to_jsonb(t)::text as value from public.synthetic_fixture t';
const HASH = 'a'.repeat(64);
const CONTEXT = { mode: 'on', isolation: 'repeatable read', server_encoding: 'UTF8', client_encoding: 'UTF8', timezone: 'UTC', search_path: 'pg_catalog' };
const STATS = { count: '2', null_values: '0', framed_bytes: '8' };
const RESULT = { count: '2', hash: HASH };

function fixture({ context = CONTEXT, stats = STATS, result = RESULT } = {}) {
  const queries = [];
  const replies = [{ ...context, ...stats }, result];
  return {
    queries,
    db: {
      async query(sql) {
        queries.push(sql);
        assert.ok(queries.length <= 2, 'unexpected additional query');
        return { rows: [replies[queries.length - 1]] };
      },
    },
  };
}

test('returns the exact bounded aggregate without exposing canonical rows', async () => {
  const { db, queries } = fixture();
  assert.deepEqual(await exactQueryFingerprint(db, QUERY), { count: 2, hash: HASH });
  assert.equal(queries.length, 2);
  assert.match(queries[0], /transaction_read_only/i);
  assert.match(queries[0], /transaction_isolation/i);
  assert.match(queries[0], /limit\s+25001/i);
  assert.match(queries[0], /framed_bytes/i);
  assert.match(queries[1], /pg_catalog\.sha256/i);
  assert.match(queries[1], /collate\s+"C"/i);
  assert.match(queries[1], /octet_length/i);
  assert.match(queries[1], /chr\(10\)/i);
});

test('empty query results retain the SHA-256 of the empty byte stream', async () => {
  const emptyHash = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
  const { db } = fixture({ stats: { count: '0', null_values: '0', framed_bytes: '0' }, result: { count: '0', hash: emptyHash } });
  assert.deepEqual(await exactQueryFingerprint(db, QUERY), { count: 0, hash: emptyHash });
});

test('accepts values exactly at explicitly reduced row and byte bounds', async () => {
  const { db } = fixture();
  assert.deepEqual(await exactQueryFingerprint(db, QUERY, { maxRows: 2, maxFramedBytes: 8 }),
    { count: 2, hash: HASH });
});

test('preserves punctuation in trusted audit-generated quoted identifiers', async () => {
  const { db, queries } = fixture();
  const query = 'select to_jsonb(t)::text as value from public."synthetic;fixture" t';
  assert.deepEqual(await exactQueryFingerprint(db, query), { count: 2, hash: HASH });
  assert.ok(queries.every(sql => sql.includes(query)));
});

for (const context of [
  { ...CONTEXT, mode: 'off' },
  { ...CONTEXT, isolation: 'read committed' },
  { ...CONTEXT, timezone: 'Europe/Moscow' },
  { ...CONTEXT, search_path: 'public' },
]) {
  test(`requires actual read-only repeatable-read state (${context.mode}/${context.isolation})`, async () => {
    const { db, queries } = fixture({ context });
    await assert.rejects(exactQueryFingerprint(db, QUERY), { code: 'EXACT_FINGERPRINT_TRANSACTION_REQUIRED' });
    assert.equal(queries.length, 1);
  });
}

for (const field of ['server_encoding', 'client_encoding']) {
  test(`rejects non-UTF8 ${field} before reading values`, async () => {
    const { db, queries } = fixture({ context: { ...CONTEXT, [field]: 'LATIN1' } });
    await assert.rejects(exactQueryFingerprint(db, QUERY), { code: 'EXACT_FINGERPRINT_ENCODING_REQUIRED' });
    assert.equal(queries.length, 1);
  });
}

for (const [name, stats, options, code] of [
  ['row limit', { ...STATS, count: '25001' }, undefined, 'EXACT_FINGERPRINT_ROW_LIMIT'],
  ['lower custom row limit', STATS, { maxRows: 1 }, 'EXACT_FINGERPRINT_ROW_LIMIT'],
  ['byte limit', { ...STATS, framed_bytes: '67108865' }, undefined, 'EXACT_FINGERPRINT_BYTE_LIMIT'],
  ['lower custom byte limit', STATS, { maxFramedBytes: 7 }, 'EXACT_FINGERPRINT_BYTE_LIMIT'],
  ['NULL canonical value', { ...STATS, null_values: '1' }, undefined, 'EXACT_FINGERPRINT_NULL_VALUE'],
]) {
  test(`rejects ${name} before the string aggregate`, async () => {
    const { db, queries } = fixture({ stats });
    await assert.rejects(exactQueryFingerprint(db, QUERY, options), { code });
    assert.equal(queries.length, 1);
    assert.ok(queries.every(sql => !/pg_catalog\.sha256/i.test(sql)));
  });
}

for (const stats of [
  { ...STATS, count: '-1' },
  { ...STATS, count: '1.5' },
  { ...STATS, count: 'NaN' },
  { ...STATS, null_values: '-1' },
  { ...STATS, null_values: 'NaN' },
  { ...STATS, framed_bytes: '-1' },
  { ...STATS, framed_bytes: null },
]) {
  test(`rejects malformed aggregate bounds ${JSON.stringify(stats)}`, async () => {
    const { db, queries } = fixture({ stats });
    await assert.rejects(exactQueryFingerprint(db, QUERY), { code: 'EXACT_FINGERPRINT_STATS_INVALID' });
    assert.equal(queries.length, 1);
  });
}

for (const result of [
  { ...RESULT, count: '1' },
  { ...RESULT, count: '2.0' },
  { ...RESULT, hash: 'a'.repeat(63) },
  { ...RESULT, hash: 'g'.repeat(64) },
  { ...RESULT, hash: null },
]) {
  test(`rejects inconsistent or invalid final result ${JSON.stringify(result)}`, async () => {
    const { db, queries } = fixture({ result });
    await assert.rejects(exactQueryFingerprint(db, QUERY), { code: 'EXACT_FINGERPRINT_RESULT_INVALID' });
    assert.equal(queries.length, 2);
  });
}

for (const query of ['', '  ', 'delete from public.synthetic_fixture', 'select 1\0', null, undefined]) {
  test(`rejects unsafe or absent audited SELECT input ${JSON.stringify(query)}`, async () => {
    const { db, queries } = fixture();
    await assert.rejects(exactQueryFingerprint(db, query), { code: 'EXACT_FINGERPRINT_QUERY_REQUIRED' });
    assert.equal(queries.length, 0);
  });
}

for (const options of [
  { maxRows: 0 }, { maxRows: 1.5 }, { maxRows: 25001 },
  { maxFramedBytes: 0 }, { maxFramedBytes: 1.5 }, { maxFramedBytes: 67108865 },
]) {
  test(`rejects invalid or expanded hard limits ${JSON.stringify(options)}`, async () => {
    const { db, queries } = fixture();
    await assert.rejects(exactQueryFingerprint(db, QUERY, options), { code: 'EXACT_FINGERPRINT_LIMIT_REQUIRED' });
    assert.equal(queries.length, 0);
  });
}
