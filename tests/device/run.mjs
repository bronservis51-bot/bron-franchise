import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { deviceQaTotal } from './harness.mjs';

const platform = process.argv[2];
if (!['android', 'ios'].includes(platform)) throw new Error('Usage: npm run test:pwa:device -- android|ios');
const { installAndLaunch } = await import(`./${platform}.mjs`);
const logs = 'local/device-qa';
await mkdir(logs, { recursive: true });

async function wait(check, label, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(750);
  }
  throw new Error(`Timed out: ${label}`);
}

const qa = fork(new URL('../e2e/server.mjs', import.meta.url), {
  env: { ...process.env, BRON_E2E_PWA: '1', BRON_DEVICE_QA: '1' },
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
let appium;
let cleanup;
try {
  const stopped = once(qa, 'exit').then(([code]) => { throw new Error(`QA server stopped (${code})`); });
  const [{ baseURL, backendUrl }] = await Promise.race([once(qa, 'message', { signal: AbortSignal.timeout(120_000) }), stopped]);
  appium = spawn('appium', ['--address', '127.0.0.1', '--port', '4723', '--log', `${logs}/appium.log`], { stdio: 'ignore' });
  await Promise.race([
    once(appium, 'exit').then(([code]) => { throw new Error(`Appium stopped (${code})`); }),
    wait(async () => {
      const response = await fetch('http://127.0.0.1:4723/status', { signal: AbortSignal.timeout(2_000) }).catch(() => null);
      return response?.ok && (await response.json()).value?.ready;
    }, 'Appium readiness', 30_000),
  ]);
  cleanup = await installAndLaunch(`${baseURL}/bron-franchise/`, backendUrl);

  let lastStage;
  const state = await Promise.race([stopped, wait(async () => {
    const response = await fetch(`${baseURL}/__qa/device-status`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) throw new Error(`QA status returned ${response.status}`);
    const current = await response.json();
    if (current.stage !== lastStage) {
      lastStage = current.stage;
      console.log(`${platform}: ${lastStage}${current.detail ? ` — ${current.detail}` : ''}`);
    }
    if (lastStage === 'failed') throw new Error(current.detail);
    return lastStage === 'passed' ? current : null;
  }, 'installed web app updated with its saved revenue', 150_000)]);
  assert.equal(state.revenue.length, 1, 'Exactly one revenue record must be stored');
  assert.equal(state.revenue[0].writes, 1, 'Exactly one revenue write must be recorded in the audit log');
  assert.equal(state.revenue[0].total, deviceQaTotal);
  console.log(`${platform}: installed PWA updated and revenue was saved exactly once.`);
} finally {
  try { await cleanup?.(); } finally {
    appium?.kill();
    qa.kill();
  }
}
