import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ config: vi.fn(), connect: vi.fn(), query: vi.fn(), end: vi.fn() }));
vi.mock('pg', () => ({ default: { Client: class {
  constructor(config: unknown) { database.config(config); }
  connect = database.connect;
  query = database.query;
  end = database.end;
} } }));
vi.mock('../../scripts/env.mjs', () => ({ loadEnv: vi.fn(), need: (name: string) => ({
  MOYSKLAD_READ_TOKEN: 'test-only',
  DATABASE_URL: 'postgresql://test:test@manual.example.invalid/app',
  TARGET_DATABASE_URL: 'postgresql://test:test@target.example.invalid/app',
} as Record<string, string>)[name] }));

const originalArgs = process.argv;
const startedAt = '2026-11-30T21:15:00.000Z';
const fetchReport = vi.fn<(url: URL, init: RequestInit) => Promise<Response>>();
const storeSql = 'select app_private.supply_store($1,$2::jsonb,$3,$4)';

function rows(count: number, offset = 0) {
  return Array.from({ length: count }, (_, index) => ({
    counterparty: { name: `Партнёр ${index + offset}`, meta: {
      href: `https://api.moysklad.ru/api/remap/1.2/entity/counterparty/a1000000-0000-0000-0000-${String(index + offset).padStart(12, '0')}`,
    } },
    sellSum: 10000, sellCostSum: 4000, returnSum: 2000, returnCostSum: 800, profit: 4800,
  }));
}

function reportPage(count: number, size: number, offset = 0) {
  return Response.json({ rows: rows(count, offset), meta: { size, offset } });
}

async function runImport(...args: string[]) {
  process.argv = ['node', 'sync-moysklad.mjs', ...args];
  // @ts-expect-error server-side JavaScript entry point
  await import('../../scripts/sync-moysklad.mjs');
}

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(startedAt));
  vi.stubEnv('BRON_DB_CA_FILE', '');
  vi.stubGlobal('fetch', fetchReport);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.argv = originalArgs;
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('MoySklad purchase sync command', () => {
  it('rejects a changed total before opening the database', async () => {
    fetchReport.mockResolvedValueOnce(reportPage(200, 400)).mockResolvedValueOnce(reportPage(199, 399, 200));
    await expect(runImport('--month=2026-11')).rejects.toThrow();
    expect(database.connect).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('rejects a page that reports the wrong offset even when all UUIDs are distinct', async () => {
    fetchReport.mockResolvedValueOnce(reportPage(200, 201)).mockResolvedValueOnce(Response.json({
      rows: rows(1, 200), meta: { size: 201, offset: 199 },
    }));
    await expect(runImport('--month=2026-11')).rejects.toThrow();
    expect(database.connect).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('stores the complete report using read-start time for snapshot precedence', async () => {
    fetchReport.mockResolvedValueOnce(reportPage(200, 201)).mockImplementationOnce(async () => {
      vi.setSystemTime(new Date('2026-11-30T21:17:00.000Z'));
      return reportPage(1, 201, 200);
    });
    await runImport();
    expect(fetchReport.mock.calls.map(([url]) => url.searchParams.get('offset'))).toEqual(['0', '200']);
    const [month, stored, readAt, periodEnd] = database.query.mock.calls.find(([sql]) => sql === storeSql)?.[1] ?? [];
    expect({ month, readAt, periodEnd }).toEqual({ month: '2026-12-01', readAt: startedAt, periodEnd: '2026-12-01 00:15:00' });
    expect(JSON.parse(stored)).toHaveLength(201);
    expect(database.query).toHaveBeenCalledWith('commit');
  });

  it('refreshes both the current and previous Moscow calendar months', async () => {
    fetchReport.mockResolvedValueOnce(reportPage(1, 1)).mockResolvedValueOnce(reportPage(0, 0));
    await runImport('--recent');
    expect(fetchReport.mock.calls.map(([url]) => [url.searchParams.get('momentFrom'), url.searchParams.get('momentTo')])).toEqual([
      ['2026-12-01 00:00:00', '2026-12-01 00:15:00'],
      ['2026-11-01 00:00:00', '2026-11-30 23:59:59'],
    ]);
    expect(database.query).toHaveBeenCalledWith(storeSql, ['2026-12-01', expect.any(String), startedAt, '2026-12-01 00:15:00']);
    expect(database.query).toHaveBeenCalledWith(storeSql, ['2026-11-01', '[]', startedAt, '2026-11-30 23:59:59']);
    expect(database.config.mock.calls).toHaveLength(2);
    for (const [config] of database.config.mock.calls) {
      expect(config).toMatchObject({ connectionString: 'postgresql://test:test@target.example.invalid/app', ssl: { rejectUnauthorized: true } });
    }
  });

  it('refreshes the previous month after a current-month failure and returns failure', async () => {
    fetchReport.mockResolvedValueOnce(new Response(null, { status: 503 })).mockResolvedValueOnce(reportPage(1, 1));
    await expect(runImport('--recent')).rejects.toThrow();
    const stores = database.query.mock.calls.filter(([sql]) => sql === storeSql);
    expect(stores).toHaveLength(1);
    expect(stores[0][1][0]).toBe('2026-11-01');
    expect(database.query).toHaveBeenCalledWith('commit');
  });
});
