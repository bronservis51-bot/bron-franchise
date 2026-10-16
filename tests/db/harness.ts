// Локальная БД для проверок (ADR-0006): PGlite + эмуляция Supabase + те же миграции и seed.
import type { PGlite } from '@electric-sql/pglite';
// @ts-expect-error — общий модуль на JS без деклараций типов
import { createDb, demoUsers } from '../../scripts/db-lib.mjs';

export const DEMO_USERS: { email: string; name: string; locale?: string }[] = demoUsers;

export interface TestDb {
  db: PGlite;
  /** Выполнить SQL от имени пользователя (по email из seed) с ролью authenticated. */
  as<T = Record<string, unknown>>(email: string | null, sql: string, params?: unknown[]): Promise<T[]>;
  /** Выполнить SQL от имени владельца БД (как миграция/администратор). */
  admin<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  userId(email: string): Promise<string>;
  /** Ожидать ошибку команды с кодом API-04. */
  expectError(email: string, sql: string, code: string, params?: unknown[]): Promise<string>;
}

export async function createTestDb(opts: { seed?: boolean; users?: boolean } = {}): Promise<TestDb> {
  const db: PGlite = await createDb(opts);
  const ids = new Map<string, string>();
  async function userId(email: string): Promise<string> {
    if (!ids.has(email)) {
      const r = await db.query<{ id: string }>(`select id from auth.users where email = $1`, [email]);
      if (!r.rows[0]) throw new Error(`Нет пользователя ${email}`);
      ids.set(email, r.rows[0].id);
    }
    return ids.get(email)!;
  }

  async function as<T>(email: string | null, sql: string, params: unknown[] = []): Promise<T[]> {
    const sub = email ? await userId(email) : null;
    const claims = sub ? JSON.stringify({ sub, role: 'authenticated' }) : '';
    return db.transaction(async (tx) => {
      await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
      await tx.exec(sub ? 'set local role authenticated' : 'set local role anon');
      const r = await tx.query<T>(sql, params);
      return r.rows;
    });
  }

  async function admin<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const r = await db.query<T>(sql, params);
    return r.rows;
  }

  async function expectError(email: string, sql: string, code: string, params: unknown[] = []): Promise<string> {
    try {
      await as(email, sql, params);
    } catch (e) {
      const msg = (e as Error).message;
      const { detail = '', hint = '' } = e as { detail?: string; hint?: string };
      if (msg !== code) throw new Error(`Ожидалась ошибка «${code}», получена «${msg}» (${detail} ${hint})`);
      return `${detail} ${hint}`.trim();
    }
    throw new Error(`Ожидалась ошибка «${code}», но команда выполнилась`);
  }

  return { db, as, admin, userId, expectError };
}
