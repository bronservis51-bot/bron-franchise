// A retry keeps its UUID, including after a reload. Only an opaque hash is stored.
const memory = new Map<string, string>();
export async function operationKey(user: string, name: string, args: unknown) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([user, name, args])));
  const key = `bron.operation.${Array.from(new Uint8Array(bytes), n => n.toString(16).padStart(2, '0')).join('')}`;
  let id: string | null = memory.get(key) ?? null;
  try { id ??= sessionStorage.getItem(key); } catch { /* In-memory receipt still protects retries. */ }
  id ??= crypto.randomUUID();
  memory.set(key, id);
  try { sessionStorage.setItem(key, id); } catch { /* Private storage can be unavailable. */ }
  return { id, complete() { memory.delete(key); try { sessionStorage.removeItem(key); } catch { /* optional cache */ } } };
}
