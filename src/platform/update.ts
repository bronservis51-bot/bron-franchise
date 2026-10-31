let available: (() => Promise<void>) | null = null;
const listeners = new Set<(update: (() => Promise<void>) | null) => void>();
export function setAvailableUpdate(update: () => Promise<void>) { available = update; listeners.forEach(fn => fn(available)); }
export function onAvailableUpdate(fn: (update: (() => Promise<void>) | null) => void) { listeners.add(fn); fn(available); return () => { listeners.delete(fn); }; }
