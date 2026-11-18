import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { newSession } from './webdriver.mjs';

const exec = promisify(execFile);
const chrome = 'com.android.chrome';
const appName = 'Бронь Сервис';

const adb = (...args) => exec('adb', args, { timeout: 40_000 });
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

function testEndpoint(value) {
  const endpoint = new URL(value);
  if (endpoint.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(endpoint.hostname)
      || !endpoint.port || endpoint.username || endpoint.password) {
    throw new Error(`Android QA requires a loopback HTTP endpoint with an explicit port: ${endpoint.origin}`);
  }
  return endpoint;
}

function labels(names, qualifier = '') {
  const lower = value => `translate(${value}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
  const matches = names.flatMap(name => ['@text', '@content-desc'].map(attribute =>
    `${lower(attribute)} = ${JSON.stringify(name.toLowerCase())}`));
  return ['xpath', `//*[(${matches.join(' or ')})${qualifier}]`];
}

const browserMenu = [
  ['id', `${chrome}:id/menu_button`],
  ['accessibility id', 'More options'],
];
const startupButtons = [
  labels(['Continue without an account', 'Use without an account', 'No thanks', 'Skip for now', "Don't allow"]),
  labels(['Accept & continue', 'Accept and continue', 'I agree']),
];
const menuInstall = [
  ['id', `${chrome}:id/universal_install`],
  ['id', `${chrome}:id/add_to_homescreen_id`],
  ['id', `${chrome}:id/install_app_id`],
  labels(['Add to Home screen', 'Install app', 'Install']),
];
const chooseInstall = ['xpath', `//*[@enabled = 'true' and (
  @resource-id = '${chrome}:id/option_install' or @resource-id = '${chrome}:id/option_text_install')]`];
const confirmChromeInstall = labels(['Install'], ` and @package = '${chrome}' and @enabled = 'true' and (
  @resource-id = '${chrome}:id/button_install' or @resource-id = '${chrome}:id/positive_button'
  or @class = 'android.widget.Button')`);
const confirmAndroidInstall = labels(['Install'], ` and @package != '${chrome}' and @enabled = 'true' and (
  @resource-id = 'android:id/button1' or contains(@resource-id, 'packageinstaller:id/ok_button'))`);
const launcherIcon = ['xpath', `//*[contains(@package, 'launcher') and (starts-with(@text, '${appName}') or starts-with(@content-desc, '${appName}'))]`];

async function firstElement(session, selectors) {
  for (const [using, value] of selectors) {
    const [element] = await session.all(using, value);
    if (element) return element;
  }
}

async function until(attempt, timeout, interval = 350) {
  const deadline = Date.now() + timeout;
  do {
    const result = await attempt();
    if (result) return result;
    await delay(interval);
  } while (Date.now() < deadline);
}

async function waitFor(step, attempt, timeout = 30_000) {
  const result = await until(attempt, timeout);
  if (!result) throw new Error(`Timed out ${step}.`);
  return result;
}

async function webAppPackages() {
  const { stdout } = await adb('shell', 'pm', 'list', 'packages', '-3');
  return stdout.split(/\r?\n/).filter(line => /^package:[\w.]+\.(?:webapk|twa)\./i.test(line));
}

async function installInChrome(session) {
  const initialPackages = new Set(await webAppPackages());
  const prompt = await waitFor('finding the Chrome installation action', async () => {
    const choice = await firstElement(session, [chooseInstall]);
    if (choice) return { choice };
    const confirmation = await firstElement(session, [confirmChromeInstall]);
    if (confirmation) return { confirmation };
  });

  // Universal Install presents a choice first and then the actual installation dialog.
  let { confirmation } = prompt;
  if (prompt.choice) {
    await prompt.choice.click();
    confirmation = await waitFor('finding the final Install button in Chrome',
      () => firstElement(session, [confirmChromeInstall]));
  }
  // Chrome's modal ignores taps for the first 600 ms even when its button is enabled.
  await delay(600);
  await confirmation.click();
  console.log('Android: confirmed Install in Chrome.');

  const installed = await until(async () => {
    const pending = await firstElement(session, [confirmAndroidInstall]);
    if (pending) await pending.click();
    return (await webAppPackages()).find(name => !initialPackages.has(name));
  }, 55_000, 1_250);
  console.log(installed ? `Android: installed ${installed}.` : 'Android: awaiting the web app from the launcher.');
}

async function logInstallFailure() {
  const [packages, log] = await Promise.allSettled([
    webAppPackages(),
    adb('logcat', '-d', '-t', '2000', '-v', 'brief', 'chromium:V', 'cr_WebApkInstaller:V',
      'cr_WebApkInstallService:V', 'cr_TwaInstaller:V', 'PackageInstaller:V', 'Finsky:W', '*:S'),
  ]);
  if (packages.status === 'fulfilled') {
    console.error(`Android web app packages: ${packages.value.join(', ') || 'none'}`);
  }
  if (log.status === 'fulfilled') {
    const messages = log.value.stdout.split(/\r?\n/).filter(line => /webapk|TwaInstaller|PackageInstaller|AutoMint/i.test(line)).slice(-30);
    if (messages.length) console.error(`Android web app installation log:\n${messages.join('\n')}`);
  }
}

async function openFromLauncher(session) {
  await adb('shell', 'input', 'keyevent', 'KEYCODE_HOME');
  const findIcon = () => firstElement(session, [launcherIcon]);
  const onHomeScreen = await until(findIcon, 4_000);
  if (onHomeScreen) {
    await onHomeScreen.click();
    return;
  }

  const { stdout } = await adb('shell', 'wm', 'size');
  const display = [...stdout.matchAll(/(?:Physical|Override) size: (\d+)x(\d+)/g)].at(-1);
  if (!display) throw new Error('Could not determine the Android display size for the app drawer.');
  const [, width, height] = display.map(Number);
  const swipe = (from, to) => adb('shell', 'input', 'swipe', String(Math.round(width / 2)),
    String(Math.round(height * from)), String(Math.round(width / 2)), String(Math.round(height * to)), '350');
  await swipe(0.87, 0.23);

  // Installed WebAPKs are listed in the drawer even when the launcher did not pin one on the first page.
  let attempts = 0;
  const icon = await waitFor(`finding «${appName}» in the Android launcher`, async () => {
    const element = await findIcon();
    if (element) return element;
    attempts += 1;
    if (attempts % 5 === 0) await swipe(0.3, 0.78);
    else await swipe(0.78, 0.3);
  }, 80_000);
  await icon.click();
}

export async function installAndLaunch(url, backendUrl = url) {
  const { stdout: serial } = await adb('get-serialno');
  if (!/^emulator-\d+$/.test(serial.trim())) throw new Error('Use an Android Emulator for this test.');
  const endpoint = testEndpoint(url);
  const ports = new Set([endpoint, testEndpoint(backendUrl)].map(value => `tcp:${value.port}`));
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
    const packagePath = await adb('shell', 'pm', 'path', chrome).catch(error => {
      throw new Error('Chrome is required on the Android emulator. Use a Google Play system image.', { cause: error });
    });
    if (!packagePath.stdout.includes('package:')) throw new Error('Chrome is missing from the Android emulator.');
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

    const opened = await adb('shell', `am start -W -a android.intent.action.VIEW -c android.intent.category.BROWSABLE -d ${shellQuote(endpoint.href)} -p ${chrome}`);
    if (/\bError(?::| type)/.test(opened.stdout)) throw new Error(`Chrome could not open the test URL: ${opened.stdout.trim()}`);

    const menu = await waitFor('opening Chrome after its first-run prompts', async () => {
      const startup = await firstElement(session, startupButtons);
      if (startup) {
        await startup.click();
        return;
      }
      return firstElement(session, browserMenu);
    }, 45_000);
    await menu.click();
    const entry = await waitFor('finding Add to Home screen in Chrome', () => firstElement(session, menuInstall));
    await entry.click();
    await installInChrome(session);
    await openFromLauncher(session);
    return cleanup;
  } catch (cause) {
    const nativeScreen = await session?.source().catch(() => '');
    const screenLabels = [...new Set([...String(nativeScreen).matchAll(/\b(?:text|content-desc)="([^"]+)"/g)]
      .map(([, value]) => value))].slice(0, 20).join(' | ');
    if (session) await logInstallFailure();
    await cleanup().catch(error => console.error(`Android QA cleanup: ${error.message}`));
    throw new Error(`${cause.message}${screenLabels ? ` Native screen: ${screenLabels}` : ''}`, { cause });
  }
}
