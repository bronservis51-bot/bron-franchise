import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { newSession } from './webdriver.mjs';

const exec = promisify(execFile);
const firefox = 'org.mozilla.firefox';
const firefoxData = `/data/user/0/${firefox}`;
const appName = 'Бронь Сервис';
const adb = (...args) => exec('adb', args, { timeout: 40_000 });
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

function localEndpoint(value, protocols) {
  const endpoint = new URL(value);
  if (!protocols.includes(endpoint.protocol) || !['127.0.0.1', 'localhost'].includes(endpoint.hostname)
      || !endpoint.port || endpoint.username || endpoint.password) {
    throw new Error(`Android QA requires a loopback URL with an explicit port: ${endpoint.origin}`);
  }
  return endpoint;
}

function labels(names, qualifier = '') {
  const matches = names.flatMap(name => ['@text', '@content-desc'].map(attribute =>
    `${attribute} = ${JSON.stringify(name)}`));
  return ['xpath', `//*[(${matches.join(' or ')})${qualifier}]`];
}

const menu = [
  ['accessibility id', 'More options'],
  ['id', `${firefox}:id/mozac_browser_toolbar_menu`],
];
const startup = labels(['Not now', 'Continue', 'Save and continue', 'Confirm', 'Confirm and start browsing',
  'Agree and start browsing', 'Save and start browsing', 'Start browsing', "Don’t allow", "Don't allow"]);
const translations = labels(['Close Translations sheet']);
const skipTranslation = labels(['Not now'], " and @clickable = 'true'");
const loginPage = labels(['Кабинет франчайзи']);
const moreMenu = labels(['More', 'More Collapsed']);
const installMenu = labels(['Add app to Home screen', 'Install']);
const confirmPin = labels(['Add to Home screen', 'Add to home screen', 'Add automatically'],
  " and @clickable = 'true' and contains(@package, 'launcher')");
const launcherIcon = ['xpath', `//*[contains(@package, 'launcher') and (starts-with(@text, '${appName}') or starts-with(@content-desc, '${appName}'))]`];

async function firstElement(session, ...selectors) {
  for (const [using, value] of selectors) {
    const [element] = await session.all(using, value);
    if (element) return element;
  }
}

async function until(attempt, timeout) {
  const deadline = Date.now() + timeout;
  do {
    const result = await attempt();
    if (result) return result;
    await delay(350);
  } while (Date.now() < deadline);
}

async function waitFor(step, attempt, timeout = 30_000) {
  const result = await until(attempt, timeout);
  if (!result) throw new Error(`Timed out ${step}.`);
  return result;
}

async function trustQaCertificate(ca) {
  const profile = await waitFor('finding the fresh Firefox certificate database', async () => {
    const { stdout } = await adb('shell', 'find', `${firefoxData}/files`, '-name', 'cert9.db')
      .catch(() => ({ stdout: '' }));
    const files = stdout.trim().split(/\r?\n/).filter(path => path.startsWith(`${firefoxData}/files/`));
    if (files.length > 1) throw new Error('Android QA requires one fresh Firefox profile.');
    return files[0] && dirname(files[0]);
  });
  await adb('shell', 'am', 'force-stop', firefox);
  const local = await mkdtemp(join(tmpdir(), 'bron-fenix-'));
  const remote = `/data/local/tmp/${basename(local)}`;
  const files = ['cert9.db', 'key4.db'];
  try {
    for (const file of files) {
      await adb('pull', join(profile, file), join(local, file));
    }
    await exec('certutil', ['-A', '-d', `sql:${local}`, '-n', 'Bron local QA root', '-t', 'C,,', '-i', ca], { timeout: 10_000 });
    for (const file of files) {
      await adb('push', join(local, file), `${remote}-${file}`);
      // NSS updates both databases. Preserve Firefox's file ownership and SELinux labels.
      await adb('shell', `cat ${shellQuote(`${remote}-${file}`)} > ${shellQuote(join(profile, file))}`);
    }
  } finally {
    await Promise.allSettled([
      rm(local, { recursive: true, force: true }),
      adb('shell', 'rm', '-f', ...files.map(file => `${remote}-${file}`)),
    ]);
  }
}

async function openFirefox(endpoint) {
  const { stdout } = await adb('shell', `am start -W -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d ${shellQuote(endpoint.href)} -p ${firefox}`);
  if (/\bError(?::| type)/.test(stdout)) throw new Error(`Firefox could not open the test URL: ${stdout.trim()}`);
}

async function installFromFirefox(session) {
  await waitFor('loading the QA login page in Firefox', async () => {
    if (await firstElement(session, translations)) {
      const skip = await firstElement(session, skipTranslation);
      if (skip) await skip.click();
      else await adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
      return;
    }
    return firstElement(session, loginPage);
  }, 45_000);
  const openMenu = await waitFor('finding the Firefox menu', () => firstElement(session, ...menu));
  await openMenu.click();
  const action = await waitFor('finding the Firefox web app action or More menu',
    async () => {
      const install = await firstElement(session, installMenu);
      if (install) return { install };
      const more = await firstElement(session, moreMenu);
      if (more) return { more };
    });
  let { install } = action;
  if (action.more) {
    await action.more.click();
    install = await waitFor('finding Firefox’s Add app to Home screen action', () => firstElement(session, installMenu));
  }
  await install.click();
  const confirm = await waitFor('finding the Android Home screen pin confirmation', () => firstElement(session, confirmPin));
  await confirm.click();
  console.log('Android: Firefox web app pinned to the launcher.');
}

async function openFromLauncher(session) {
  await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  const findIcon = () => firstElement(session, launcherIcon);
  let icon = await until(findIcon, 5_000);
  if (!icon) {
    const { stdout } = await adb('shell', 'wm', 'size');
    const display = [...stdout.matchAll(/(?:Physical|Override) size: (\d+)x(\d+)/g)].at(-1);
    if (!display) throw new Error('Could not determine Android display size for the launcher.');
    const [, width, height] = display.map(Number);
    const x = portion => String(Math.round(width * portion));
    const y = String(Math.round(height * 0.55));
    for (const nextPage of [true, true, true, false, false, false, false]) {
      await adb('shell', 'input', 'swipe', x(nextPage ? 0.83 : 0.17), y, x(nextPage ? 0.17 : 0.83), y, '350');
      icon = await until(findIcon, 1_800);
      if (icon) break;
    }
  }
  if (!icon) throw new Error(`Could not find «${appName}» on the Android Home screen.`);
  await icon.click();
}

export async function installAndLaunch(url, backendUrl = url) {
  const endpoint = localEndpoint(url, ['https:']);
  const backend = localEndpoint(backendUrl, ['http:', 'https:']);
  const ca = process.env.BRON_ANDROID_TLS_CA;
  if (!ca) throw new Error('Set BRON_ANDROID_TLS_CA to the ephemeral QA CA certificate.');
  const { stdout: serial } = await adb('get-serialno');
  if (!/^emulator-\d+$/.test(serial.trim())) throw new Error('Use an Android Emulator for this test.');
  const ports = new Set([endpoint, backend].map(value => `tcp:${value.port}`));
  const reverses = [];
  let session;
  let cleaned = false;
  async function cleanup() {
    if (cleaned) return;
    cleaned = true;
    const results = await Promise.allSettled([
      session?.close(),
      ...reverses.map(port => adb('reverse', '--remove', port)),
    ]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  try {
    const packagePath = await adb('shell', 'pm', 'path', firefox).catch(error => {
      throw new Error('Install the pinned Mozilla Firefox APK on the Android emulator.', { cause: error });
    });
    if (!packagePath.stdout.includes('package:')) throw new Error('Firefox is missing from the Android emulator.');
    await adb('root');
    await adb('wait-for-device');
    const { stdout: uid } = await adb('shell', 'id', '-u');
    if (uid.trim() !== '0') throw new Error('Use a root-capable Google APIs emulator image to trust the test CA.');
    for (const port of ports) {
      await adb('reverse', '--no-rebind', port, port);
      reverses.push(port);
    }
    await adb('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP');
    await adb('shell', 'wm', 'dismiss-keyguard');
    session = await newSession({
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:deviceName': 'Android Emulator',
      'appium:noReset': true,
      'appium:autoLaunch': false,
      'appium:newCommandTimeout': 300,
      'appium:udid': serial.trim(),
    });

    // The initial request initializes Firefox's NSS profile. Certificate exceptions do not make a page installable.
    await openFirefox(endpoint);
    await waitFor('opening Firefox after its first-run prompts', async () => {
      const button = await firstElement(session, startup);
      if (button) {
        await button.click();
        return;
      }
      return firstElement(session, ...menu);
    }, 60_000);
    await openFirefox(endpoint);
    await trustQaCertificate(ca);
    await openFirefox(endpoint);
    await installFromFirefox(session);
    await openFromLauncher(session);
    return { close: cleanup, source: () => session.source() };
  } catch (cause) {
    const nativeScreen = await session?.source().catch(() => '');
    if (nativeScreen) await writeFile('local/device-qa/android-view.xml', nativeScreen).catch(() => undefined);
    const screenLabels = [...new Set([...String(nativeScreen).matchAll(/\b(?:text|content-desc)="([^"]+)"/g)]
      .map(([, value]) => value))].slice(0, 22).join(' | ');
    const reported = await adb('logcat', '-d', '-t', '1200', '-v', 'brief').catch(() => ({ stdout: '' }));
    const messages = reported.stdout.split(/\r?\n/).filter(line => /WebAppLauncher|ShortcutService|NSS.*(?:error|fail)|SEC_ERROR/i.test(line)).slice(-20);
    if (messages.length) console.error(messages.join('\n'));
    await cleanup().catch(error => console.error(`Android QA cleanup: ${error.message}`));
    throw new Error(`${cause.message}${screenLabels ? ` Native screen: ${screenLabels}` : ''}`, { cause });
  }
}
