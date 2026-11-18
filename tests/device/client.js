// Served only by the loopback QA server. The installed web app drives its real UI.
(() => {
  if (!matchMedia('(display-mode: standalone)').matches && navigator.standalone !== true) return;
  const build = document.currentScript.dataset.build;
  const marker = 'bron.qa-device-updating';
  const comment = 'Тест выручки на установленной PWA';
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const text = element => element?.textContent.trim().replace(/\s+/g, ' ');
  const button = (label, root = document) => [...root.querySelectorAll('button')].find(item => text(item) === label && !item.disabled);
  const field = (label, root) => {
    const match = [...root.querySelectorAll('label')].find(item => text(item)?.startsWith(label));
    return match && root.querySelector(`#${CSS.escape(match.htmlFor)}`);
  };
  const today = () => [...document.querySelectorAll('button')].find(item => /^Внести выручку за сегодня|^Сегодня внесено:/.test(text(item)));
  const queued = () => document.body.textContent.includes('Сохранено на устройстве и ждёт отправки:');
  const focus = () => window.dispatchEvent(new Event('focus'));

  async function wait(check, label, timeout = 25_000) {
    const deadline = Date.now() + timeout;
    do {
      const result = await check();
      if (result) return result;
      await sleep(250);
    } while (Date.now() < deadline);
    throw new Error(`Timed out: ${label}`);
  }
  async function command(action, state = {}) {
    const response = await fetch('/__qa/device-command', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...state }),
    });
    if (!response.ok) throw new Error(`QA command ${action} returned ${response.status}`);
    return response.json();
  }
  const report = (stage, detail) => command('report', { stage, detail });
  function fill(input, value) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  const profile = () => document.querySelector('button[aria-label="Профиль"]');

  async function drive() {
    if (new Date().getTimezoneOffset() !== -180) {
      throw new Error(`Expected UTC+3 on the device, saw ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
    }
    await wait(async () => (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated', 'active service worker');
    if (!navigator.serviceWorker.controller) {
      const initialNavigation = 'bron.qa-device-claimed';
      if (sessionStorage.getItem(initialNavigation) === build) throw new Error('Service worker did not control the app after reload');
      sessionStorage.setItem(initialNavigation, build);
      location.reload();
      return;
    }

    const expected = sessionStorage.getItem(marker);
    if (expected !== null) {
      if (expected !== build) throw new Error(`Expected build ${expected}, saw ${build}`);
      await wait(profile, 'session after update');
      await wait(() => !queued() && today()?.classList.contains('today-entered'), 'synced revenue after update');
      today().click();
      const dialog = await wait(() => document.querySelector('dialog[open]'), 'saved revenue dialog');
      const amount = field('Вся выручка точки за день', dialog)?.value.replace(/\s/g, '');
      if (amount !== '14321,05' || field('Комментарий', dialog)?.value !== comment) {
        throw new Error('Saved revenue does not match the queued edit');
      }
      await report('passed', build);
      return;
    }

    await report('installed', build);
    const login = await wait(() => document.querySelector('input[autocomplete="username"]'), 'login input');
    fill(login, 'alpha.owner@demo.example.com');
    fill(document.querySelector('input[autocomplete="current-password"]'), 'Browser-QA-2026!');
    (await wait(() => button('Войти'), 'enabled login button')).click();
    await wait(profile, 'authenticated app');
    (await wait(() => button('Волжский'), 'seeded location')).click();
    (await wait(today, 'today revenue action')).click();
    const dialog = await wait(() => document.querySelector('dialog[open]'), 'revenue dialog');
    fill(field('Вся выручка точки за день', dialog), '14321,05');
    fill(field('Комментарий', dialog), comment);

    await command('block');
    (await wait(() => button('Сохранить', dialog), 'enabled save button')).click();
    await wait(queued, 'revenue recorded in the offline queue');
    await report('queued', build);

    const { build: next } = await command('publish');
    if (next === build) throw new Error('QA publish did not change the build');
    // The real app throttles version checks to one per 30 seconds.
    await sleep(31_000);
    focus();
    (await wait(() => button('Обновить'), 'update offered with queued revenue')).click();
    await wait(() => document.body.textContent.includes('Завершите ввод и отправку записей перед обновлением.'),
      'update blocked until queued revenue is delivered');
    if (!queued()) throw new Error('Queued revenue disappeared before reconnect');
    sessionStorage.setItem(marker, next);
    await report('updating', next);
    await command('unblock');
    focus();
    await wait(() => !queued(), 'queued revenue delivered after reconnect');
    await report('synced', next);
    (await wait(() => button('Обновить'), 'update action')).click();
  }
  void drive().catch(error => report('failed', error.message));
})();
