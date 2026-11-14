import { readFileSync } from 'node:fs';

// Never log the returned configuration: it contains the database password.
export function databaseConfig(connectionString, env = process.env) {
  let url;
  try { url = new URL(connectionString); } catch { throw new Error('Invalid PostgreSQL connection configuration'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname)
    throw new Error('Invalid PostgreSQL connection configuration');
  for (const key of ['host', 'hostaddr', 'port', 'user', 'password', 'database', 'dbname']) {
    if (url.searchParams.has(key)) throw new Error('Database routing overrides are not allowed in URL parameters');
  }
  // node-postgres lets URL SSL options overwrite the supplied ssl object.
  for (const key of ['ssl', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat']) {
    if (url.searchParams.has(key)) throw new Error('Use BRON_DB_CA_FILE for database TLS; URL SSL overrides are not allowed');
  }
  const modes = url.searchParams.getAll('sslmode');
  if (modes.length > 1) throw new Error('Ambiguous database TLS configuration');
  const mode = modes[0];
  url.searchParams.delete('sslmode');
  if (mode === 'disable') {
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || env.BRON_DB_ALLOW_LOCAL_PLAIN !== '1')
      throw new Error('Unencrypted PostgreSQL is allowed only for an explicitly configured local SSH tunnel');
    return { connectionString: url.toString(), ssl: false, connectionTimeoutMillis: 15000 };
  }
  if (mode !== undefined && !['require', 'verify-ca', 'verify-full'].includes(mode))
    throw new Error('PostgreSQL TLS certificate verification cannot be disabled');
  const ssl = { rejectUnauthorized: true };
  if (env.BRON_DB_CA_FILE) {
    try { ssl.ca = readFileSync(env.BRON_DB_CA_FILE, 'utf8'); }
    catch { throw new Error('Database CA certificate is unavailable'); }
  }
  return { connectionString: url.toString(), ssl, connectionTimeoutMillis: 15000 };
}
