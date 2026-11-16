// Dedicated source service for migration on the owner's Russian VPS.
// Never print the returned configuration, callback result or protected file contents.
import fs from 'node:fs';
import os from 'node:os';
import { checkServerIdentity } from 'node:tls';

export const SOURCE_HOST = 'aws-1-us-west-2.pooler.supabase.com';
export const SOURCE_USER = 'postgres.vkkqffvmztpzgygzfxhq';
const SOURCE_DIRECT_HOST = 'db.vkkqffvmztpzgygzfxhq.supabase.co';
const SECRET_DIR = '/root/bron-secrets';
const SERVICE_FILE = `${SECRET_DIR}/source.pg_service.conf`;
const PASSWORD_FILE = `${SECRET_DIR}/source.pgpass`;
const SOURCE_CA = '/opt/bron/source-ca-bundle.pem';

export class MigrationSourceError extends Error {
  constructor(code) { super(code); this.name = 'MigrationSourceError'; this.code = code; }
}
const fail = code => { throw new MigrationSourceError(code); };

function privateFile(path) {
  let fd;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o077)) fail('SOURCE_PRIVATE_FILE_UNSAFE');
    return fs.readFileSync(fd);
  } catch (error) {
    if (error instanceof MigrationSourceError) throw error;
    fail('SOURCE_PRIVATE_FILE_UNAVAILABLE');
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function serviceText(port) {
  const address = port === 15432 ? 'hostaddr=127.0.0.1\n' : '';
  return `[bron_source]\nhost=${SOURCE_HOST}\n${address}port=${port}\nuser=${SOURCE_USER}\n` +
    `dbname=postgres\nsslmode=verify-full\nsslrootcert=${SOURCE_CA}\n` +
    'connect_timeout=15\napplication_name=bron-migration-readonly\n';
}

function sourcePassword(port) {
  const text = privateFile(PASSWORD_FILE).toString('utf8');
  const prefix = `${SOURCE_HOST}:${port}:postgres:${SOURCE_USER}:`;
  const line = text.endsWith('\n') ? text.slice(0, -1) : text;
  if (!line.startsWith(prefix) || /[\r\n\0]/.test(line)) fail('SOURCE_PASSWORD_FILE_INVALID');
  const escaped = line.slice(prefix.length);
  let password = '';
  for (let index = 0; index < escaped.length; index++) {
    let char = escaped[index];
    if (char === '\\') {
      char = escaped[++index];
      if (char !== '\\' && char !== ':') fail('SOURCE_PASSWORD_FILE_INVALID');
    } else if (char === ':') fail('SOURCE_PASSWORD_FILE_INVALID');
    password += char;
  }
  if (!password) fail('SOURCE_PASSWORD_FILE_INVALID');
  return password;
}

export function sourceServiceConfig() {
  if (process.env.SOURCE_DATABASE_URL) fail('SOURCE_URL_CONFLICT');
  // The reviewed SNI/password-callback path is node-postgres' pure JS backend.
  if (process.env.NODE_PG_FORCE_NATIVE) fail('SOURCE_NATIVE_BACKEND_FORBIDDEN');
  if (os.platform() !== 'linux' || typeof process.getuid !== 'function' || process.getuid() !== 0)
    fail('SOURCE_REQUIRES_RUSSIAN_VPS_ROOT');
  const localAddresses = Object.values(os.networkInterfaces()).flat().filter(Boolean);
  if (!localAddresses.some(address => address.family === 'IPv4' && address.address === '152.228.115.115'))
    fail('SOURCE_WRONG_VPS');
  try {
    const info = fs.lstatSync(SECRET_DIR);
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o077))
      fail('SOURCE_PRIVATE_DIRECTORY_UNSAFE');
  } catch (error) {
    if (error instanceof MigrationSourceError) throw error;
    fail('SOURCE_PRIVATE_DIRECTORY_UNAVAILABLE');
  }
  const text = privateFile(SERVICE_FILE).toString('utf8');
  const port = text === serviceText(15432) ? 15432 : text === serviceText(5432) ? 5432 : null;
  if (port === null) fail('SOURCE_SERVICE_TRANSPORT_OR_TLS_MISMATCH');
  sourcePassword(port); // Validate before connecting; never use an ambient password fallback.
  const ca = privateFile(SOURCE_CA);
  if (!ca.includes(Buffer.from('-----BEGIN CERTIFICATE-----')) ||
      !ca.includes(Buffer.from('-----END CERTIFICATE-----'))) fail('SOURCE_CA_INVALID');
  return {
    host: port === 15432 ? '127.0.0.1' : SOURCE_HOST,
    port, database: 'postgres', user: SOURCE_USER,
    password: async () => sourcePassword(port),
    ssl: { ca, rejectUnauthorized: true, servername: SOURCE_HOST,
      checkServerIdentity: (_hostname, certificate) => checkServerIdentity(SOURCE_HOST, certificate) },
    sslnegotiation: 'postgres',
    options: '-c default_transaction_read_only=on -c statement_timeout=30000',
    client_encoding: 'UTF8', application_name: 'bron-migration-readonly-source',
    connectionTimeoutMillis: 15000, query_timeout: 60000,
  };
}

export function assertMigrationTarget(targetUrl) {
  let url, host, user;
  try {
    url = new URL(targetUrl);
    host = decodeURIComponent(url.hostname).toLowerCase().replace(/\.+$/, '');
    user = decodeURIComponent(url.username);
  } catch { fail('MIGRATION_TARGET_URL_INVALID'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !host || !user)
    fail('MIGRATION_TARGET_URL_INVALID');
  // Reserved source port also covers localhost., shorthand/encoded IP and IPv6 aliases.
  if (Number(url.port || 5432) === 15432 || host === SOURCE_HOST ||
      host.endsWith('.pooler.supabase.com') || host === SOURCE_DIRECT_HOST || user === SOURCE_USER)
    fail('MIGRATION_TARGET_IS_SOURCE');
  // pg-connection-string can replace the explicit CA object when this URL option is present.
  if (url.searchParams.has('sslnegotiation')) fail('MIGRATION_TARGET_SSL_OVERRIDE');
}
