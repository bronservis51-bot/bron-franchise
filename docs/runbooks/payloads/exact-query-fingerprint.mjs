// Optional transport for the audit's trusted, static SELECT ... AS value SQL.
// It hashes the SAME full UTF8 canonical rows as fingerprintRows, not row hashes.
// Call only inside snapshotDatabase's consistent READ ONLY/REPEATABLE READ session.
// No credentials, canonical rows or private digests are printed by this module.
const HARD_MAX_ROWS = 25_000;
const HARD_MAX_FRAMED_BYTES = 64 * 1024 * 1024;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const integer = value => typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);

export async function exactQueryFingerprint(db, sql, {
  maxRows = HARD_MAX_ROWS, maxFramedBytes = HARD_MAX_FRAMED_BYTES,
} = {}) {
  // These are audit-generated SELECT statements, never user-provided SQL. This
  // check is not an SQL sanitizer; nesting preserves quoted identifiers/strings.
  if (typeof sql !== 'string' || !/^\s*select\b/i.test(sql) || sql.includes('\0'))
    fail('EXACT_FINGERPRINT_QUERY_REQUIRED');
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > HARD_MAX_ROWS ||
      !Number.isSafeInteger(maxFramedBytes) || maxFramedBytes < 1 || maxFramedBytes > HARD_MAX_FRAMED_BYTES)
    fail('EXACT_FINGERPRINT_LIMIT_REQUIRED');

  // LIMIT is for the admission count only. The hash below always reads the full
  // original query. Exceeding either bound stops BEFORE string_agg is issued.
  const stats = (await db.query(`select
    current_setting('transaction_read_only') as mode,
    current_setting('transaction_isolation') as isolation,
    current_setting('server_encoding') as server_encoding,
    current_setting('client_encoding') as client_encoding,
    current_setting('TimeZone') as timezone,
    current_setting('search_path') as search_path,
    count(*)::text as count,
    count(*) filter (where value is null)::text as null_values,
    coalesce(sum(octet_length(convert_to(value,'UTF8')) +
      length(octet_length(convert_to(value,'UTF8'))::text) + 2),0)::text as framed_bytes
    from (select value from (${sql}) exact_input limit ${maxRows + 1}) exact_bounded`)).rows[0];
  if (!stats || stats.mode !== 'on' || stats.isolation !== 'repeatable read' ||
      stats.timezone !== 'UTC' || stats.search_path !== 'pg_catalog')
    fail('EXACT_FINGERPRINT_TRANSACTION_REQUIRED');
  if (stats.server_encoding !== 'UTF8' || stats.client_encoding !== 'UTF8')
    fail('EXACT_FINGERPRINT_ENCODING_REQUIRED');
  if (!integer(stats.count) || !integer(stats.null_values) || !integer(stats.framed_bytes))
    fail('EXACT_FINGERPRINT_STATS_INVALID');
  if (BigInt(stats.count) > BigInt(maxRows)) fail('EXACT_FINGERPRINT_ROW_LIMIT');
  if (BigInt(stats.null_values) !== 0n) fail('EXACT_FINGERPRINT_NULL_VALUE');
  if (BigInt(stats.framed_bytes) > BigInt(maxFramedBytes)) fail('EXACT_FINGERPRINT_BYTE_LIMIT');

  // bytea string_agg avoids collation/encoding reinterpretation of framed bytes.
  // Aggregate ORDER BY is explicit; input order is not relied on. Empty => SHA256('').
  const row = (await db.query(`select count(*)::text as count,
    encode(pg_catalog.sha256(coalesce(string_agg(
      convert_to(octet_length(convert_to(value,'UTF8'))::text || ':' || value || chr(10),'UTF8'),
      ''::bytea order by value collate "C"), ''::bytea)), 'hex') as hash
    from (${sql}) exact_full`)).rows[0];
  if (!row || row.count !== stats.count || typeof row.hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.hash))
    fail('EXACT_FINGERPRINT_RESULT_INVALID');
  return { count: Number(row.count), hash: row.hash };
}
