export type InstallDevice = 'ios' | 'android' | 'desktop';
type InstallChoice = { outcome: 'accepted' | 'dismissed' };
export interface InstallPromptEvent extends Event {
  prompt(): Promise<InstallChoice | void>;
  userChoice: Promise<InstallChoice>;
}

export function installDevice(ua: string, touchPoints = 0): InstallDevice {
  if (/iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && touchPoints > 1)) return 'ios';
  return /android/i.test(ua) ? 'android' : 'desktop';
}

export function isStandalone() {
  return Boolean(window.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone);
}

/** Never copy the current route, query, credentials or recovery token. */
export function installationUrl(origin: string, base: string) {
  const url = new URL(base, origin);
  url.search = ''; url.hash = '';
  return url.href;
}

/** Capture before React mounts. A browser prompt can be used only once. */
export function createInstallController(events: EventTarget, installed: () => boolean) {
  let deferred: InstallPromptEvent | null = null;
  let snapshot = { available: false, installed: installed() };
  let started = false;
  const listeners = new Set<() => void>();
  const publish = (done = installed()) => {
    const next = { available: Boolean(deferred) && !done, installed: done };
    if (next.available === snapshot.available && next.installed === snapshot.installed) return;
    snapshot = next;
    listeners.forEach(fn => fn());
  };
  return {
    start() {
      if (started) return;
      started = true;
      events.addEventListener('beforeinstallprompt', e => {
        if (snapshot.installed || installed()) return;
        e.preventDefault(); deferred = e as InstallPromptEvent; publish();
      });
      events.addEventListener('appinstalled', () => { deferred = null; publish(true); });
    },
    refresh() { publish(snapshot.installed || installed()); },
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    getSnapshot: () => snapshot,
    async prompt(): Promise<'accepted' | 'dismissed' | 'unavailable' | 'error'> {
      const event = deferred;
      if (!event || snapshot.installed) return 'unavailable';
      deferred = null; publish();
      try {
        // Invoke in the click's activation, before awaiting anything else.
        const choice = await event.prompt();
        return (choice ?? await event.userChoice).outcome;
      } catch { return 'error'; }
    },
  };
}

let controller: ReturnType<typeof createInstallController> | undefined;
export function getInstallController() {
  return controller ??= createInstallController(window, isStandalone);
}
export function startInstallCapture() {
  const c = getInstallController();
  c.start();
  window.matchMedia?.('(display-mode: standalone)').addEventListener('change', () => c.refresh());
}
