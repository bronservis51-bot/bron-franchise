// Portable, account-scoped local work. No session, password or API key is exported.
import { CONTRACT } from './contract.generated';
import { mergeLocalWork, readLocalWork, type DraftRow, type QueuedOperation } from './offline';
import { requireClient } from './supabase';

export const MAX_RECOVERY_BYTES = 5 * 1024 * 1024;
export interface LocalRecovery {
  format: 'bron-local-work';
  version: 1;
  userId: string;
  exported_at: string;
  operations: QueuedOperation[];
  drafts: DraftRow[];
}
const kinds = new Set(['shift_close_versioned', 'revenue_total_set', 'revenue_save', 'shift_close', 'revenue_save_checked', 'shift_close_checked']);
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const timestamp = (v: unknown): v is string => typeof v === 'string' && Number.isFinite(Date.parse(v));
const invalid = (): never => { throw new Error('Файл локальных записей повреждён или имеет неподдерживаемый формат.'); };
function onlyKeys(row: Record<string, unknown>, allowed: string[]) { if (Object.keys(row).some(key => !allowed.includes(key))) invalid(); }
function jsonDepth(value: unknown, depth = 0): void {
  if (depth > 32) invalid();
  if (value && typeof value === 'object') Object.values(value).forEach(v => jsonDepth(v, depth + 1));
}

/** Also accepts the old operations-only download, without reclassifying old errors or commands. */
export function parseLocalRecovery(text: string, userId: string): LocalRecovery {
  if (new TextEncoder().encode(text).byteLength > MAX_RECOVERY_BYTES) throw new Error('Файл больше 5 МБ. Импорт отменён.');
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return invalid(); }
  jsonDepth(raw);
  if (!object(raw) || !timestamp(raw.exported_at) || !Array.isArray(raw.operations) || raw.operations.length > 10000) return invalid();
  const legacy = raw.format === 'bron-pending';
  if (legacy) onlyKeys(raw, ['format', 'exported_at', 'operations']);
  else {
    onlyKeys(raw, ['format', 'version', 'userId', 'exported_at', 'operations', 'drafts']);
    if (raw.format !== 'bron-local-work' || raw.version !== 1 || raw.userId !== userId || !Array.isArray(raw.drafts)) {
      throw new Error('Копия принадлежит другой учётной записи или имеет неподдерживаемый формат.');
    }
  }
  if (!uuid(userId)) return invalid();
  const operationIds = new Set<string>();
  for (const item of raw.operations) {
    if (!object(item)) return invalid();
    onlyKeys(item, ['userId', 'clientOpId', 'kind', 'payload', 'createdAt', 'attempts', 'lastError', 'lastErrorCode']);
    if (item.userId !== userId) throw new Error('Копия содержит записи другой учётной записи.');
    if (!uuid(item.clientOpId) || operationIds.has(item.clientOpId) || !kinds.has(String(item.kind)) || !object(item.payload) ||
      !timestamp(item.createdAt) || !Number.isSafeInteger(item.attempts) || Number(item.attempts) < 0 ||
      (item.lastError !== undefined && typeof item.lastError !== 'string') || (item.lastErrorCode !== undefined && typeof item.lastErrorCode !== 'string')) return invalid();
    operationIds.add(item.clientOpId);
    const kind = item.kind as QueuedOperation['kind'];
    const payload = item.payload;
    onlyKeys(payload, [...CONTRACT[kind].args]);
    if (Object.values(payload).some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value))) return invalid();
    if (kind !== 'revenue_save' && kind !== 'shift_close' && payload.operation !== item.clientOpId) return invalid();
    if (kind === 'revenue_total_set' && typeof payload.expected_version !== 'string') return invalid();
    if ((kind === 'revenue_save_checked' || kind === 'shift_close_versioned') && (!Number.isSafeInteger(payload.expected_revision) || Number(payload.expected_revision) < -1)) return invalid();
    if (kind === 'shift_close_checked' && payload.expected_closed_at !== null && !timestamp(payload.expected_closed_at)) return invalid();
  }
  const savedDrafts = legacy ? [] : raw.drafts as unknown[];
  if (savedDrafts.length > 10000) return invalid();
  const keys = new Set<string>();
  for (const item of savedDrafts) {
    if (!object(item)) return invalid();
    onlyKeys(item, ['userId', 'key', 'value', 'savedAt']);
    if (item.userId !== userId) throw new Error('Копия содержит черновики другой учётной записи.');
    if (typeof item.key !== 'string' || !item.key || item.key.length > 512 || keys.has(item.key) || !('value' in item) || !timestamp(item.savedAt)) return invalid();
    keys.add(item.key);
  }
  return { format: 'bron-local-work', version: 1, userId, exported_at: raw.exported_at,
    operations: raw.operations as unknown as QueuedOperation[], drafts: savedDrafts as DraftRow[] };
}

async function requireOwner(userId: string) {
  const { data, error } = await requireClient().auth.getSession();
  if (error || !data.session?.access_token || data.session.user.id !== userId) {
    throw new Error('Сначала войдите в исходную учётную запись, чтобы открыть её локальные записи.');
  }
}
export async function exportLocalRecovery(userId: string) {
  await requireOwner(userId);
  const work = await readLocalWork(userId);
  await requireOwner(userId);
  const text = JSON.stringify({ format: 'bron-local-work', version: 1, userId, exported_at: new Date().toISOString(), ...work } satisfies LocalRecovery, null, 2);
  // Never offer a backup as recoverable (or enable deletion) if this version cannot import it.
  parseLocalRecovery(text, userId);
  return text;
}
export async function importLocalRecovery(userId: string, text: string) {
  const recovery = parseLocalRecovery(text, userId);
  await requireOwner(userId);
  return mergeLocalWork(userId, recovery);
}
