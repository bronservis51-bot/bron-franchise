import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { spawnSync } from 'node:child_process';
// @ts-expect-error Administrative JavaScript module, not a frontend dependency.
import { SOURCE_HOST, SOURCE_USER, sourceServiceConfig, assertMigrationTarget } from '../../scripts/migration-source.mjs';
// @ts-expect-error Use the real reviewed pure-JS pg 8.23.1 backend in offline tests.
import Client from 'pg/lib/client.js';
// @ts-expect-error Shared administrative audit module.
import { snapshotDatabase } from '../../scripts/migration-audit.mjs';

const SECRET_DIR = '/root/bron-secrets';
const SERVICE = `${SECRET_DIR}/source.pg_service.conf`;
const PASSWORD = `${SECRET_DIR}/source.pgpass`;
const CA = '/opt/bron/source-ca-bundle.pem';
const service = (port = 15432) => `[bron_source]\nhost=${SOURCE_HOST}\n` +
  (port === 15432 ? 'hostaddr=127.0.0.1\n' : '') + `port=${port}\nuser=${SOURCE_USER}\n` +
  `dbname=postgres\nsslmode=verify-full\nsslrootcert=${CA}\nconnect_timeout=15\n` +
  'application_name=bron-migration-readonly\n';
const passwordLine = (port = 15432) => `${SOURCE_HOST}:${port}:postgres:${SOURCE_USER}:synthetic\\:pass\\\\word\n`;
let fixtureDir: string;
let trustedCa: Buffer, otherCa: Buffer, canonicalKey: Buffer, canonicalCert: Buffer, wrongKey: Buffer, wrongCert: Buffer;
let files: Map<string, Buffer>, permissions: number;

beforeAll(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bron-source-tls-'));
  const openssl = (...args: string[]) => {
    const result = spawnSync('openssl', args, { cwd: fixtureDir, stdio: 'ignore' });
    if (result.status !== 0) throw new Error('Offline TLS fixture generation failed');
  };
  for (const name of ['ca', 'other']) openssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-nodes', '-keyout', `${name}.key`, '-out', `${name}.pem`, '-days', '2', '-subj', `/CN=Synthetic-${name}`,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  for (const [name, host] of [['canonical', SOURCE_HOST], ['wrong', 'wrong.example.invalid']]) {
    openssl('req', '-new', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
      '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', `/CN=${host}`);
    fs.writeFileSync(path.join(fixtureDir, `${name}.ext`),
      `subjectAltName=DNS:${host}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n`);
    openssl('x509', '-req', '-in', `${name}.csr`, '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-out', `${name}.pem`, '-days', '2', '-extfile', `${name}.ext`);
  }
  trustedCa = fs.readFileSync(path.join(fixtureDir, 'ca.pem'));
  otherCa = fs.readFileSync(path.join(fixtureDir, 'other.pem'));
  canonicalKey = fs.readFileSync(path.join(fixtureDir, 'canonical.key'));
  canonicalCert = fs.readFileSync(path.join(fixtureDir, 'canonical.pem'));
  wrongKey = fs.readFileSync(path.join(fixtureDir, 'wrong.key'));
  wrongCert = fs.readFileSync(path.join(fixtureDir, 'wrong.pem'));
});
afterAll(() => { fs.rmSync(fixtureDir, { recursive: true, force: true }); });

beforeEach(() => {
  vi.stubEnv('SOURCE_DATABASE_URL', undefined);
  vi.stubEnv('NODE_PG_FORCE_NATIVE', undefined);
  files = new Map([[SERVICE, Buffer.from(service())], [PASSWORD, Buffer.from(passwordLine())], [CA, trustedCa]]);
  permissions = 0o100600;
  vi.spyOn(process, 'getuid').mockReturnValue(0);
  vi.spyOn(os, 'platform').mockReturnValue('linux');
  vi.spyOn(os, 'networkInterfaces').mockReturnValue({ eth0: [{ address: '152.228.115.115', family: 'IPv4',
    netmask: '255.255.255.0', cidr: '152.228.115.115/24', mac: '00:00:00:00:00:00', internal: false }] });
  const open = fs.openSync, stat = fs.fstatSync, read = fs.readFileSync, close = fs.closeSync, lstat = fs.lstatSync;
  const opened = new Map<number, string>();
  vi.spyOn(fs, 'lstatSync').mockImplementation(((...args: any[]) => String(args[0]) === SECRET_DIR
    ? { uid: 0, mode: 0o40700, isDirectory: () => true, isSymbolicLink: () => false }
    : (lstat as any)(...args)) as typeof fs.lstatSync);
  vi.spyOn(fs, 'openSync').mockImplementation(((...args: any[]) => {
    const name = String(args[0]);
    if (name.startsWith(SECRET_DIR) || name === CA) {
      if (!files.has(name)) throw new Error('Synthetic private file is absent');
      expect(args[1] & fs.constants.O_NOFOLLOW).not.toBe(0);
      const fd = 900000 + opened.size; opened.set(fd, name); return fd;
    }
    return (open as any)(...args);
  }) as typeof fs.openSync);
  vi.spyOn(fs, 'fstatSync').mockImplementation(((...args: any[]) => opened.has(args[0])
    ? { uid: 0, mode: permissions, isFile: () => true }
    : (stat as any)(...args)) as typeof fs.fstatSync);
  vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: any[]) => opened.has(args[0])
    ? files.get(opened.get(args[0])!)
    : (read as any)(...args)) as typeof fs.readFileSync);
  vi.spyOn(fs, 'closeSync').mockImplementation(((...args: any[]) => {
    if (!opened.delete(args[0])) return (close as any)(...args);
  }) as typeof fs.closeSync);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('protected Russian migration source', () => {
  it('uses fixed routing/TLS and a protected password callback despite hostile PG defaults', async () => {
    for (const [key, value] of Object.entries({ PGHOST: 'wrong.invalid', PGPORT: '6543', PGUSER: 'wrong',
      PGDATABASE: 'wrong', PGPASSWORD: 'inherited-do-not-use', PGSSLMODE: 'disable', PGOPTIONS: 'unsafe',
      PGSSLNEGOTIATION: 'direct' })) vi.stubEnv(key, value);
    const config = sourceServiceConfig();
    const client = new Client(config);
    const params = client.connectionParameters;
    expect([params.host, params.port, params.user, params.database]).toEqual(['127.0.0.1', 15432, SOURCE_USER, 'postgres']);
    expect(params.ssl.rejectUnauthorized).toBe(true);
    expect(params.ssl.servername).toBe(SOURCE_HOST);
    expect(params.ssl.ca).toEqual(trustedCa);
    expect(params.sslnegotiation).toBe('postgres');
    expect(params.options).toContain('default_transaction_read_only=on');
    expect(typeof params.password).toBe('function');
    expect(await params.password()).toBe('synthetic:pass\\word');
    expect(config).not.toHaveProperty('connectionString');
    expect(JSON.stringify(config)).not.toContain('synthetic:pass');
    client.connection.stream.destroy();
  });

  it('preserves canonical identity through the real pg upgradeToSSL implementation', () => {
    const client = new Client(sourceServiceConfig());
    const tlsConnect = vi.spyOn(tls, 'connect').mockImplementation(() => new net.Socket() as tls.TLSSocket);
    const original = client.connection.stream;
    client.connection.upgradeToSSL('127.0.0.1', vi.fn());
    const options = tlsConnect.mock.calls[0]?.[0] as tls.ConnectionOptions;
    expect(options.host).toBe('127.0.0.1');
    expect(options.servername).toBe(SOURCE_HOST);
    expect(options.rejectUnauthorized).toBe(true);
    expect(options.ca).toEqual(trustedCa);
    original.destroy(); client.connection.stream.destroy();
  });

  it('refuses source URLs, forced native backend and execution outside the Russian VPS', () => {
    vi.stubEnv('SOURCE_DATABASE_URL', 'postgresql://user:never-log-this@wrong.invalid/postgres');
    expect(() => sourceServiceConfig()).toThrow('SOURCE_URL_CONFLICT');
    vi.stubEnv('SOURCE_DATABASE_URL', undefined);
    vi.stubEnv('NODE_PG_FORCE_NATIVE', '0');
    expect(() => sourceServiceConfig()).toThrow('SOURCE_NATIVE_BACKEND_FORBIDDEN');
    vi.stubEnv('NODE_PG_FORCE_NATIVE', undefined);
    vi.mocked(os.platform).mockReturnValue('darwin');
    expect(() => sourceServiceConfig()).toThrow('SOURCE_REQUIRES_RUSSIAN_VPS_ROOT');
  });

  it('rejects service downgrades, mismatched ports and unsafe permissions', () => {
    files.set(SERVICE, Buffer.from(service().replace('verify-full', 'require')));
    expect(() => sourceServiceConfig()).toThrow('SOURCE_SERVICE_TRANSPORT_OR_TLS_MISMATCH');
    files.set(SERVICE, Buffer.from(service(5432)));
    expect(() => sourceServiceConfig()).toThrow('SOURCE_PASSWORD_FILE_INVALID');
    files.set(SERVICE, Buffer.from(service())); permissions = 0o100640;
    expect(() => sourceServiceConfig()).toThrow('SOURCE_PRIVATE_FILE_UNSAFE');
  });

  it('never falls back to an ambient password when the protected file disappears', async () => {
    const config = sourceServiceConfig();
    files.delete(PASSWORD); vi.stubEnv('PGPASSWORD', 'must-not-be-used');
    await expect(config.password()).rejects.toThrow('SOURCE_PRIVATE_FILE_UNAVAILABLE');
  });

  it('permits only the separately configured direct route when its credentials agree', async () => {
    files.set(SERVICE, Buffer.from(service(5432))); files.set(PASSWORD, Buffer.from(passwordLine(5432)));
    const config = sourceServiceConfig();
    expect([config.host, config.port]).toEqual([SOURCE_HOST, 5432]);
    expect(await config.password()).toBe('synthetic:pass\\word');
  });

  it('rejects source aliases, reserved tunnel port and target TLS URL overrides', () => {
    for (const url of [
      `postgresql://target:synthetic@${SOURCE_HOST.toUpperCase()}./postgres`,
      'postgresql://target:synthetic@db.vkkqffvmztpzgygzfxhq.supabase.co/postgres',
      'postgresql://%70ostgres.vkkqffvmztpzgygzfxhq:synthetic@other-pooler.invalid/postgres',
      'postgresql://another-role.vkkqffvmztpzgygzfxhq:synthetic@aws-0-us-west-2.pooler.supabase.com/postgres',
      'postgresql://target:synthetic@%31%32%37.0.0.1:15432/postgres',
      'postgresql://target:synthetic@[::ffff:7f00:1]:15432/postgres',
      'postgresql://target:synthetic@localhost.:15432/postgres',
    ]) expect(() => assertMigrationTarget(url)).toThrow('MIGRATION_TARGET_IS_SOURCE');
    expect(() => assertMigrationTarget('postgresql://target:synthetic@127.0.0.1/postgres?sslnegotiation=direct'))
      .toThrow('MIGRATION_TARGET_SSL_OVERRIDE');
    expect(() => assertMigrationTarget('postgresql://target:synthetic@127.0.0.1:5432/postgres?sslmode=disable')).not.toThrow();
  });
});

async function fakePostgres(key: Buffer, cert: Buffer, acceptsTls: boolean, action: (port: number) => Promise<void>) {
  const sockets = new Set<net.Socket>();
  const context = tls.createSecureContext({ key, cert });
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('data', packet => {
      const request = typeof packet === 'string' ? Buffer.from(packet) : packet;
      if (request.length !== 8 || request.readInt32BE(4) !== 80877103 || !acceptsTls) { socket.end('N'); return; }
      socket.write('S');
      const secure = new tls.TLSSocket(socket, { isServer: true, secureContext: context });
      sockets.add(secure); secure.on('error', () => {});
      let stage = 0, buffered = Buffer.alloc(0);
      secure.on('data', data => {
        buffered = Buffer.concat([buffered, typeof data === 'string' ? Buffer.from(data) : data]);
        if (stage === 0 && buffered.length >= 4 && buffered.length >= buffered.readInt32BE(0)) {
          buffered = Buffer.alloc(0); stage = 1;
          secure.write(Buffer.from('520000000800000003', 'hex')); // AuthenticationCleartextPassword inside TLS.
        } else if (stage === 1 && buffered[0] === 0x70 && buffered.length >= 5 && buffered.length >= 1 + buffered.readInt32BE(1)) {
          buffered = Buffer.alloc(0); stage = 2;
          secure.write(Buffer.from('5200000008000000005a0000000549', 'hex')); // AuthenticationOk + ReadyForQuery.
        } else if (stage === 2) secure.end();
      });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await action((server.address() as net.AddressInfo).port); }
  finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('actual offline pg TLS negotiation', () => {
  it('authenticates only after trusted canonical TLS succeeds', async () => {
    await fakePostgres(canonicalKey, canonicalCert, true, async port => {
      const config = sourceServiceConfig(), password = vi.fn(config.password);
      const client = new Client({ ...config, port, password, connectionTimeoutMillis: 2000 });
      try { await client.connect(); expect(password).toHaveBeenCalledOnce(); }
      finally { await client.end(); }
    });
  });
  it('rejects trusted wrong SAN, untrusted CA and absent TLS before the authentication password callback', async () => {
    vi.stubEnv('NODE_TLS_REJECT_UNAUTHORIZED', '0');
    for (const scenario of ['wrong-san', 'wrong-ca', 'no-tls']) {
      files.set(CA, scenario === 'wrong-ca' ? otherCa : trustedCa);
      await fakePostgres(scenario === 'wrong-san' ? wrongKey : canonicalKey,
        scenario === 'wrong-san' ? wrongCert : canonicalCert, scenario !== 'no-tls', async port => {
          const config = sourceServiceConfig(), password = vi.fn(config.password);
          const client = new Client({ ...config, port, password, connectionTimeoutMillis: 2000 });
          try { await expect(client.connect()).rejects.toThrow(); expect(password).not.toHaveBeenCalled(); }
          finally { await client.end(); }
        });
    }
  });
});

describe('audit transaction guard', () => {
  it('rolls back before reading data when the actual transaction is read-write', async () => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes('transaction_read_only') ? [{ mode: 'off' }] : [] }));
    await expect(snapshotDatabase({ query })).rejects.toMatchObject({ code: 'MIGRATION_TRANSACTION_NOT_READ_ONLY' });
    expect(query.mock.calls.map(args => args[0])).toEqual([
      'begin isolation level repeatable read read only',
      "select current_setting('transaction_read_only') as mode", 'rollback',
    ]);
  });
});
