import { commandsInFlight } from './backend';
import { hasPendingLocalWork } from './offline';

let available: (() => Promise<void>) | null = null;
const listeners = new Set<(update: (() => Promise<void>) | null) => void>();
export function setAvailableUpdate(update: () => Promise<void>) { available = update; listeners.forEach(fn => fn(available)); }
export function onAvailableUpdate(fn: (update: (() => Promise<void>) | null) => void) { listeners.add(fn); fn(available); return () => { listeners.delete(fn); }; }

export function mayReload(flags: { visible: boolean; commands: number; dialog: boolean; editing: boolean; pending: boolean }) {
  return flags.visible && flags.commands === 0 && !flags.dialog && !flags.editing && !flags.pending;
}
async function safeToReload() {
  const editing = !!document.activeElement?.matches('input,textarea,select,[contenteditable="true"]') ||
    [...document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('form input:not([type="checkbox"]):not([type="radio"]), form textarea')].some(e => !!e.value);
  return mayReload({ visible: document.visibilityState === 'visible', commands: commandsInFlight(),
    dialog: !!document.querySelector('dialog[open],[role="dialog"],[data-unsaved="true"]'), editing, pending: await hasPendingLocalWork() });
}

/** Same release for Safari, installed PWA and desktop. No auth, queue or draft is removed. */
export function startAppUpdates() {
  if (!('serviceWorker' in navigator)) return;
  let registration: ServiceWorkerRegistration | undefined; let checking = false; let lastCheck = 0; let target = ''; let reloading = false;
  const base = import.meta.env.BASE_URL;
  const waitForInstall = async () => {
    const worker = registration?.installing ?? registration?.waiting;
    if (!worker || worker.state === 'activated') return;
    worker.postMessage({ type: 'SKIP_WAITING' });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { worker.removeEventListener('statechange', changed); reject(new Error('Обновление ещё загружается. Повторите через несколько секунд.')); }, 20_000);
      const changed = () => {
        if (worker.state === 'installed') worker.postMessage({ type: 'SKIP_WAITING' });
        if (worker.state === 'activated') { clearTimeout(timer); worker.removeEventListener('statechange', changed); resolve(); }
        if (worker.state === 'redundant') { clearTimeout(timer); worker.removeEventListener('statechange', changed); reject(new Error('Не удалось загрузить обновление')); }
      };
      worker.addEventListener('statechange', changed); changed();
    });
  };
  const apply = async () => {
    if (reloading) return;
    if (!(await safeToReload())) throw new Error('Завершите ввод и отправку записей перед обновлением.');
    await registration?.update(); await waitForInstall();
    if (!(await safeToReload())) return;
    reloading = true;
    try { sessionStorage.setItem('bron.update-attempt', JSON.stringify({ target, at: Date.now() })); } catch { /* no storage needed */ }
    location.reload();
  };
  const check = async () => {
    if (checking || !navigator.onLine || document.visibilityState !== 'visible' || Date.now() - lastCheck < 30_000) return;
    checking = true; lastCheck = Date.now();
    try {
      registration ??= await navigator.serviceWorker.register(`${base}sw.js`, { scope: base, updateViaCache: 'none' });
      // Also prompts a legacy waiting worker to activate. Activation never clears durable records or forces a reload.
      const response = await fetch(`${base}app-version.json`, { cache: 'no-store' });
      if (!response.ok) return;
      const release: { build?: string } = await response.json();
      if (!release.build || release.build === import.meta.env.VITE_BUILD_TIME) return;
      target = release.build; setAvailableUpdate(apply);
      let recent = false;
      try { const previous = JSON.parse(sessionStorage.getItem('bron.update-attempt') ?? '{}'); recent = previous.target === target && Date.now() - previous.at < 60_000; } catch { /* first attempt */ }
      if (!recent && await safeToReload()) await apply();
    } catch { /* Offline/temporary failure: retain the current screen and retry on next foreground. */ }
    finally { checking = false; }
  };
  void check();
  window.addEventListener('focus', () => void check());
  window.addEventListener('pageshow', () => void check());
  window.addEventListener('online', () => void check());
  document.addEventListener('visibilitychange', () => void check());
  setInterval(() => void check(), 5 * 60_000);
}
