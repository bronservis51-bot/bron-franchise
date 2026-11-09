import { expect, it, vi } from 'vitest';
import { createInstallController, installDevice, installationUrl, type InstallPromptEvent } from '../../src/platform/install';

function setup() {
  const events = new EventTarget();
  const controller = createInstallController(events, () => false);
  controller.start();
  function offer(outcome: 'accepted' | 'dismissed' = 'accepted', error = false) {
    const event = new Event('beforeinstallprompt', { cancelable: true }) as InstallPromptEvent;
    event.prompt = vi.fn(() => error ? Promise.reject(new Error('browser refused')) : Promise.resolve({ outcome }));
    event.userChoice = Promise.resolve({ outcome });
    events.dispatchEvent(event);
    return event;
  }
  return { events, controller, offer };
}

it('recognizes iPhone, Android, desktop and iPad desktop mode', () => {
  expect(installDevice('Mozilla iPhone')).toBe('ios');
  expect(installDevice('Mozilla iPad')).toBe('ios');
  expect(installDevice('Mozilla Macintosh Safari', 5)).toBe('ios');
  expect(installDevice('Mozilla Macintosh Safari', 0)).toBe('desktop');
  expect(installDevice('Mozilla Android Chrome')).toBe('android');
  expect(installDevice('Mozilla Windows Chrome')).toBe('desktop');
});

it('copies only the base address, without route or recovery secrets', () => {
  expect(installationUrl('https://app.example.test', '/bron-franchise/')).toBe('https://app.example.test/bron-franchise/');
  expect(installationUrl('https://app.example.test', '/?token=private#access_token=private')).toBe('https://app.example.test/');
});

it('retains an offer before the guide subscribes and starts only once', () => {
  const { controller, offer } = setup(); controller.start();
  const event = offer();
  expect(event.defaultPrevented).toBe(true);
  expect(controller.getSnapshot()).toEqual({ available: true, installed: false });
  const listener = vi.fn(); const unsubscribe = controller.subscribe(listener);
  unsubscribe(); offer(); expect(listener).not.toHaveBeenCalled();
});

it('prompts synchronously once and does not equate acceptance with installation', async () => {
  const { controller, events, offer } = setup(); const event = offer();
  const pending = controller.prompt();
  expect(event.prompt).toHaveBeenCalledTimes(1);
  expect(controller.getSnapshot()).toEqual({ available: false, installed: false });
  expect(await controller.prompt()).toBe('unavailable');
  expect(await pending).toBe('accepted');
  expect(controller.getSnapshot().installed).toBe(false);
  events.dispatchEvent(new Event('appinstalled'));
  expect(controller.getSnapshot()).toEqual({ available: false, installed: true });
  offer(); expect(controller.getSnapshot().available).toBe(false);
});

it.each(['dismissed', 'error'] as const)('retains manual fallback after %s', async result => {
  const { controller, offer } = setup(); offer('dismissed', result === 'error');
  expect(await controller.prompt()).toBe(result);
  expect(controller.getSnapshot()).toEqual({ available: false, installed: false });
  offer(); expect(controller.getSnapshot().available).toBe(true);
});

it('supports legacy prompts returning userChoice', async () => {
  const { controller, offer } = setup(); const event = offer('dismissed');
  event.prompt = vi.fn(async () => undefined);
  expect(await controller.prompt()).toBe('dismissed');
});

it('observes standalone without saving a permanent installed flag', () => {
  let standalone = false;
  const c = createInstallController(new EventTarget(), () => standalone);
  standalone = true; c.refresh();
  expect(c.getSnapshot()).toEqual({ installed: true, available: false });
  expect(createInstallController(new EventTarget(), () => false).getSnapshot().installed).toBe(false);
});
