import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { newSession } from './webdriver.mjs';

const run = promisify(execFile);
const safari = 'com.apple.mobilesafari';
const springboard = 'com.apple.springboard';
const appName = 'Бронь Сервис';
const installAction = 'Add to Home Screen';
const predicate = '-ios predicate string';

function named(...names) {
  return `(${names.map(name => `(name ==[c] "${name}" OR label ==[c] "${name}")`).join(' OR ')})`;
}

function button(...names) {
  return `type == "XCUIElementTypeButton" AND ${named(...names)}`;
}

async function first(session, query, tappable = true) {
  const attributes = tappable ? 'visible == 1 AND hittable == 1' : 'visible == 1';
  return (await session.all(predicate, `(${query}) AND ${attributes}`))[0];
}

async function waitFor(label, lookup, timeout = 15_000) {
  const end = Date.now() + timeout;
  do {
    const value = await lookup();
    if (value) return value;
    await delay(350);
  } while (Date.now() < end);
  throw new Error(`iOS Simulator: не найдено «${label}».`);
}

async function openSafariPage(session, udid, url) {
  const open = () => run('xcrun', ['simctl', 'openurl', udid, url], { timeout: 20_000 });
  await open();
  const title = `(name BEGINSWITH "${appName}" OR label BEGINSWITH "${appName}")`;
  const page = `type == "XCUIElementTypeWebView" AND ${title}`;
  await waitFor('страница кабинета в Safari', async () => {
    // A newly booted Simulator can show Safari's first-run screens over the page.
    const welcome = await first(session, button('Continue', 'Get Started', 'Start Browsing', 'Done'));
    if (welcome) {
      await welcome.click();
      await open();
      return null;
    }
    return first(session, `${page} OR ${named('Кабинет франчайзи', 'Войти')}`, false);
  }, 30_000);
}

async function openShareSheet(session) {
  const share = button('Share', 'ShareButton');
  const more = button('More', 'More Options', 'MoreButton');
  const control = await waitFor('Share или More', () => first(session, `${share} OR ${more}`));
  const names = [await control.attribute('name'), await control.attribute('label')];
  await control.click();
  if (names.some(name => /share/i.test(name))) return;
  await (await waitFor('Share', () => first(session, share))).click();
}

async function scrollShareSheet(session) {
  const { x, y, width, height } = await session.command('GET', '/window/rect');
  const center = Math.round(x + width * 0.5);
  await session.execute('mobile: dragFromToWithVelocity', [{
    pressDuration: 0, holdDuration: 0, velocity: 800,
    fromX: center, toX: center,
    fromY: Math.round(y + height * 0.84),
    toY: Math.round(y + height * 0.32),
  }]);
}

async function findShareAction(session, label) {
  for (let scrolls = 0; scrolls < 4; scrolls++) {
    const action = await first(session, named(label));
    if (action) return action;
    if (scrolls < 3) await scrollShareSheet(session);
  }
}

async function chooseInstallAction(session) {
  await waitFor('меню Share', () => first(session, named('Copy', 'AirDrop', installAction, 'Edit Actions'), false));
  let action = await findShareAction(session, installAction);
  if (!action) {
    const edit = await waitFor('Edit Actions', () => first(session, named('Edit Actions')));
    await edit.click();
    const plus = await waitFor(`добавление действия ${installAction}`, async () => {
      const direct = await first(session, button(`Add ${installAction}`, `Add, ${installAction}`));
      if (direct) return direct;
      const cell = `//XCUIElementTypeCell[.//*[@label="${installAction}" or @name="${installAction}"]]`;
      return (await session.all('xpath', `${cell}//XCUIElementTypeButton[@visible="true"]`))[0];
    });
    await plus.click();
    await (await waitFor('Done', () => first(session, button('Done')))).click();
    action = await findShareAction(session, installAction);
  }
  if (!action) throw new Error(`iOS Simulator: Safari не показал «${installAction}».`);
  await action.click();
}

async function confirmInstall(session) {
  const add = await waitFor('Add на экране Add to Home Screen', () => first(session, button('Add')));
  const option = 'Open as Web App';
  const toggle = await first(session, `type == "XCUIElementTypeSwitch" AND ${named(option)}`) ??
    (await session.all('xpath', `//XCUIElementTypeCell[.//*[@label="${option}" or @name="${option}"]]//XCUIElementTypeSwitch[@visible="true"]`))[0];
  if (toggle) {
    const enabled = async () => ['1', 'true'].includes(String(await toggle.attribute('value')).toLowerCase());
    if (!await enabled()) {
      await toggle.click();
      await waitFor(option, enabled);
    }
  }
  await add.click();
}

async function openInstalledIcon(session) {
  await session.execute('mobile: pressButton', [{ name: 'home' }]);
  await waitFor('экран «Домой»', async () =>
    (await session.execute('mobile: activeAppInfo')).bundleId === springboard);
  const icon = `(type == "XCUIElementTypeIcon" OR type == "XCUIElementTypeButton") AND ` +
    `(name BEGINSWITH "${appName}" OR label BEGINSWITH "${appName}")`;
  for (let page = 0; page < 4; page++) {
    const installed = await first(session, icon);
    if (installed) {
      await installed.click();
      return;
    }
    if (page < 3) await session.execute('mobile: swipe', [{ direction: 'left' }]);
  }
  throw new Error(`iOS Simulator: значок «${appName}» не найден на экране «Домой».`);
}

export async function installAndLaunch(url) {
  const udid = process.env.IOS_UDID;
  if (!udid) throw new Error('Для проверки в iOS Simulator задайте IOS_UDID.');
  await run('xcrun', ['simctl', 'getenv', udid, 'HOME'], { timeout: 20_000 });
  const session = await newSession({
    platformName: 'iOS',
    'appium:automationName': 'XCUITest',
    'appium:bundleId': safari,
    'appium:udid': udid,
    'appium:language': 'en',
    'appium:locale': 'en_US',
    'appium:noReset': true,
    'appium:newCommandTimeout': 180,
  });
  try {
    await openSafariPage(session, udid, url);
    await openShareSheet(session);
    await chooseInstallAction(session);
    await confirmInstall(session);
    await openInstalledIcon(session);
    return () => session.close();
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
}
