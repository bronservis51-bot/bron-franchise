import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({
  sourceConfig: vi.fn(), client: vi.fn(), read: vi.fn(), reconcile: vi.fn(),
}));
vi.mock('../../scripts/env.mjs', () => ({
  loadEnv: () => {}, need: (name: string) => {
    if (!process.env[name]) throw new Error(`Missing synthetic setting ${name}`);
    return process.env[name];
  },
}));
vi.mock('../../scripts/migration-source.mjs', async importOriginal => ({
  ...await importOriginal<object>(), sourceServiceConfig: mocks.sourceConfig,
}));
vi.mock('pg', () => ({ default: { Client: mocks.client } }));
vi.mock('../../scripts/late-leads-lib.mjs', async importOriginal => ({
  ...await importOriginal<object>(), readSourceLeads: mocks.read, reconcileLateLeads: mocks.reconcile,
}));

const script = fileURLToPath(new URL('../../scripts/late-leads.mjs', import.meta.url));
const targetUrl = 'postgresql://target:synthetic@127.0.0.1:15433/postgres?sslmode=disable';
const originalArgv = process.argv, originalExitCode = process.exitCode;
const snapshot = { columns: [], rows: [] };
let source: { connect: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
let target: typeof source;
const invoke = async (...args: string[]) => {
  process.argv = [process.execPath, script, ...args];
  // @ts-expect-error Administrative entry point, not a frontend dependency.
  await import('../../scripts/late-leads.mjs');
};

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks();
  vi.stubEnv('SOURCE_DATABASE_URL', undefined);
  vi.stubEnv('TARGET_DATABASE_URL', targetUrl);
  vi.stubEnv('BRON_DB_ALLOW_LOCAL_PLAIN', '1');
  process.exitCode = undefined;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  source = { connect: vi.fn().mockResolvedValue(undefined), end: vi.fn().mockResolvedValue(undefined) };
  target = { connect: vi.fn().mockResolvedValue(undefined), end: vi.fn().mockResolvedValue(undefined) };
  mocks.sourceConfig.mockReturnValue({ host: '127.0.0.1', port: 15432,
    ssl: { rejectUnauthorized: true, servername: 'aws-1-us-west-2.pooler.supabase.com' } });
  mocks.client.mockImplementation(function () { return mocks.client.mock.calls.length === 1 ? source : target; });
  mocks.read.mockResolvedValue(snapshot);
  mocks.reconcile.mockResolvedValue({ pending: 0, inserted: 0 });
});
afterEach(() => {
  process.argv = originalArgv; process.exitCode = originalExitCode;
  vi.restoreAllMocks(); vi.unstubAllEnvs();
});

describe('late-lead protected source CLI', () => {
  it.each([['--source-service'], ['--source-service', '--apply'], ['--apply', '--source-service']])(
    'uses the protected transport, closes the source before opening the target: %j', async (...args) => {
      await invoke(...args);
      expect(mocks.sourceConfig).toHaveBeenCalledOnce();
      expect(mocks.client.mock.calls[0][0]).toEqual({ ...mocks.sourceConfig.mock.results[0].value,
        application_name: 'bron-late-leads-source' });
      expect(mocks.client.mock.calls[1][0].connectionString).toContain(':15433/');
      expect(source.end.mock.invocationCallOrder[0]).toBeLessThan(target.connect.mock.invocationCallOrder[0]);
      expect(mocks.reconcile).toHaveBeenCalledWith(target, snapshot, { apply: args.includes('--apply') });
      expect(target.end).toHaveBeenCalledOnce();
      expect(process.exitCode).toBeUndefined();
    });

  it.each([
    'postgresql://target:synthetic@127.0.0.1:15432/postgres?sslmode=disable',
    'postgresql://target:synthetic@aws-1-us-west-2.pooler.supabase.com/postgres',
  ])('rejects a source target before opening either connection: %s', async url => {
    vi.stubEnv('TARGET_DATABASE_URL', url);
    await invoke('--source-service', '--apply');
    expect(mocks.client).not.toHaveBeenCalled();
    expect(mocks.reconcile).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith('Late-lead reconciliation failed:', 'MIGRATION_TARGET_IS_SOURCE');
    expect(process.exitCode).toBe(1);
  });

  it('preserves legacy URL dry-run mode', async () => {
    vi.stubEnv('SOURCE_DATABASE_URL', 'postgresql://source:synthetic@source.example.invalid/postgres');
    await invoke();
    expect(mocks.sourceConfig).not.toHaveBeenCalled();
    expect(mocks.reconcile).toHaveBeenCalledWith(target, snapshot, { apply: false });
  });
});

describe('actual CLI guards before loading pg', () => {
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, [script, ...args], {
    env: { PATH: process.env.PATH, TARGET_DATABASE_URL: targetUrl, ...env }, encoding: 'utf8', timeout: 10000,
  });

  it.each([['--unknown'], ['--source-service', '--source-service'], ['--apply', '--apply']])(
    'refuses unsupported or duplicate flags: %j', (...args) => {
      const result = run(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Usage: npm run migration:leads');
      expect(result.stderr).not.toContain('MODULE_NOT_FOUND');
    });

  it.each([
    [{ SOURCE_DATABASE_URL: 'postgresql://source:do-not-print@source.example.invalid/postgres' }, 'SOURCE_URL_CONFLICT'],
    [{ NODE_PG_FORCE_NATIVE: '1' }, 'SOURCE_NATIVE_BACKEND_FORBIDDEN'],
  ] as const)('rejects conflicting source configuration without exposing it', (env, code) => {
    const result = run(['--source-service', '--apply'], { ...env });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Late-lead reconciliation failed: ${code}`);
    expect(result.stdout + result.stderr).not.toContain('do-not-print');
    expect(result.stdout + result.stderr).not.toContain('pg-native');
  });
});
