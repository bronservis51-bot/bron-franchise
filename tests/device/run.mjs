import assert from 'node:assert/strict';
import { execFile, fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { promisify } from 'node:util';
import { deviceQaTotal } from './harness.mjs';

const platform = process.argv[2];
if (!['android', 'ios'].includes(platform)) throw new Error('Usage: npm run test:pwa:device -- android|ios');
const { installAndLaunch } = await import(`./${platform}.mjs`);
const logs = 'local/device-qa';
await mkdir(logs, { recursive: true });
const openssl = promisify(execFile);

async function createAndroidCertificate(directory) {
  const ca = join(directory, 'ca.pem');
  const caKey = join(directory, 'ca.key');
  const cert = join(directory, 'loopback.pem');
  const key = join(directory, 'loopback.key');
  const request = join(directory, 'loopback.csr');
  const extensions = join(directory, 'loopback.ext');
  await writeFile(extensions, [
    'basicConstraints=critical,CA:FALSE',
    'keyUsage=critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage=serverAuth',
    'subjectAltName=IP:127.0.0.1',
    '',
  ].join('\n'));
  await openssl('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', '/CN=Bron Device QA', '-addext', 'basicConstraints=critical,CA:TRUE',
    '-addext', 'keyUsage=critical,keyCertSign,cRLSign', '-keyout', caKey, '-out', ca]);
  await openssl('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes',
    '-subj', '/CN=127.0.0.1', '-keyout', key, '-out', request]);
  await openssl('openssl', ['x509', '-req', '-in', request, '-CA', ca, '-CAkey', caKey,
    '-CAcreateserial', '-days', '2', '-extfile', extensions, '-out', cert]);
  setDefaultCACertificates([...getCACertificates('default'), await readFile(ca, 'utf8')]);
  process.env.BRON_ANDROID_TLS_CA = ca;
  return { BRON_DEVICE_QA_TLS_CERT: cert, BRON_DEVICE_QA_TLS_KEY: key };
}

async function wait(check, label, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(750);
  }
  throw new Error(`Timed out: ${label}`);
}

let certDirectory;
let qa;
let appium;
let cleanup;
try {
  let tls;
  if (platform === 'android') {
    certDirectory = await mkdtemp(join(tmpdir(), 'bron-device-ca-'));
    tls = await createAndroidCertificate(certDirectory);
  }
  qa = fork(new URL('../e2e/server.mjs', import.meta.url), {
    env: { ...process.env, BRON_E2E_PWA: '1', BRON_DEVICE_QA: '1', ...tls },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
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
    qa?.kill();
    if (certDirectory) await rm(certDirectory, { recursive: true, force: true });
  }
}
