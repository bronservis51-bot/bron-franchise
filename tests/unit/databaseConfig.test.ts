import { describe, expect, it } from 'vitest';
// @ts-expect-error Shared administrative JavaScript module.
import { databaseConfig } from '../../scripts/database-config.mjs';
// @ts-expect-error Driver options are checked without connecting to a database.
import pg from 'pg';

const remote = 'postgresql://synthetic:never-a-real-password@db.example.invalid:5432/postgres';
describe('administrative database TLS', () => {
  it('requires certificate verification after the driver parses SSL URL parameters', () => {
    for (const suffix of ['', '?sslmode=require', '?sslmode=verify-full', '?sslmode=verify-ca']) {
      const config = databaseConfig(remote + suffix, {});
      const client = new pg.Client(config);
      expect(client.connectionParameters.ssl.rejectUnauthorized).toBe(true);
      expect(new URL(config.connectionString).searchParams.has('sslmode')).toBe(false);
    }
  });
  it('rejects downgrade modes, ambiguous SSL options and passwords in error text', () => {
    for (const suffix of ['?sslmode=disable', '?sslmode=no-verify', '?sslmode=prefer', '?sslmode=allow',
      '?sslmode=require&sslmode=disable', '?ssl=false', '?sslrootcert=unsafe', '?uselibpqcompat=true']) {
      expect(() => databaseConfig(remote + suffix, { BRON_DB_ALLOW_LOCAL_PLAIN: '1' })).toThrow();
      try { databaseConfig(remote + suffix, {}); } catch (error) {
        expect(String(error)).not.toContain('never-a-real-password');
      }
    }
    expect(() => databaseConfig('not-a-url-never-a-real-password', {})).toThrow('Invalid PostgreSQL');
  });
  it('allows plaintext only at loopback with an explicit SSH-tunnel setting', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      const url = `postgresql://synthetic:synthetic@${host}:55432/postgres?sslmode=disable`;
      expect(() => databaseConfig(url, {})).toThrow('local SSH tunnel');
      expect(new pg.Client(databaseConfig(url, { BRON_DB_ALLOW_LOCAL_PLAIN: '1' })).connectionParameters.ssl).toBe(false);
    }
    expect(() => databaseConfig(remote, { BRON_DB_CA_FILE: '/nonexistent/synthetic-ca.crt' })).toThrow('CA certificate is unavailable');
    expect(() => databaseConfig('postgresql://synthetic:synthetic@localhost/postgres?sslmode=disable&host=db.example.invalid',
      { BRON_DB_ALLOW_LOCAL_PLAIN: '1' })).toThrow('routing overrides');
  });
});
