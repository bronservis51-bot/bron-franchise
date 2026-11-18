import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { tmpdir } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { build } from 'vite';
import { createDeviceHarness } from '../device/harness.mjs';

const host = '127.0.0.1';
const appPath = '/bron-franchise/';
const landingDir = resolve(process.env.BRON_LANDING_PATH ?? 'local/e2e-landing');
const testPwa = process.env.BRON_E2E_PWA === '1';
const testDevice = process.env.BRON_DEVICE_QA === '1';
const publishableKey = 'local-dev-publishable-key-0000';

const temp = await mkdtemp(resolve(tmpdir(), 'bron-e2e-'));
const first = resolve(temp, 'first');
const next = resolve(temp, 'next');
const backend = spawn(process.execPath, ['scripts/local-backend.mjs'], {
  env: {
    ...process.env, PORT: '0', BRON_LOCAL_HOST: host, BRON_LOCAL_DATA_DIR: resolve(temp, 'backend'),
    VITE_DEMO_QUICK_PASSWORD: 'Browser-QA-2026!',
  },
  stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
});
const backendExited = new Promise((done) => backend.once('close', done));
const backendReady = new Promise((done, fail) => {
  backend.on('message', (message) => {
    if (message?.type === 'bron-local-backend-ready') done(`http://${host}:${message.port}`);
  });
  backend.once('error', fail);
  backend.once('exit', (code, signal) => fail(new Error(`Изолированный бэкенд завершился: ${code ?? signal}`)));
});
let stopping = false;
async function stop(code) {
  if (stopping) return;
  stopping = true;
  backend.kill();
  await backendExited;
  await rm(temp, { recursive: true, force: true });
  process.exit(code);
}
process.once('SIGTERM', () => void stop(0));
process.once('SIGINT', () => void stop(0));
process.once('disconnect', () => void stop(0));

const mime = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2',
}));
let release = first;
let backendUrl;
let landingForTest;
let deviceHarness;
async function readRevenueProof(comment) {
  const reply = once(backend, 'message', { signal: AbortSignal.timeout(5_000) });
  backend.send({ type: 'device-revenue-proof', comment });
  const [proof] = await reply;
  if (proof.type !== 'device-revenue-proof' || proof.error) {
    throw new Error(proof.error ?? 'Unexpected QA backend response');
  }
  return proof.rows;
}
async function publish() {
  release = next;
  return JSON.parse(await readFile(resolve(next, 'app-version.json'), 'utf8'));
}
async function serve(req, res) {
  try {
    const url = new URL(req.url, `http://${host}`);
    const path = decodeURIComponent(url.pathname);
    res.setHeader('cache-control', 'no-store');
    if (deviceHarness && await deviceHarness(req, res, url, publish)) return;
    if (testPwa && req.method === 'POST' && path === '/__qa/publish') {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(await publish()));
    }
    if (req.method !== 'GET') return res.writeHead(405).end();
    if (path.startsWith('/landing/')) {
      if (testPwa) return res.writeHead(404).end();
      res.setHeader('content-security-policy', `connect-src ${backendUrl}; form-action 'none'; base-uri 'none'`);
    }
    if (path === '/landing/' || path === '/landing/index.html') {
      return res.writeHead(200, { 'content-type': mime.get('.html') }).end(landingForTest);
    }
    const app = path.startsWith(appPath);
    const prefix = app ? appPath : '/landing/';
    if (!path.startsWith(prefix)) return res.writeHead(404).end();
    const base = app ? release : landingDir;
    const file = resolve(base, path.slice(prefix.length) || 'index.html');
    const extension = extname(file);
    if (!file.startsWith(base + sep) || (!app && (extension === '.html' || !mime.has(extension)))) {
      return res.writeHead(404).end();
    }
    let data = await readFile(file);
    if (testDevice && app && file === resolve(base, 'index.html')) {
      const { build: version } = JSON.parse(await readFile(resolve(base, 'app-version.json'), 'utf8'));
      data = data.toString('utf8').replace('</head>',
        `<script defer src="/__qa/device-client.js" data-build="${version}"></script></head>`);
    }
    return res.writeHead(200, { 'content-type': mime.get(extension) ?? 'application/octet-stream' }).end(data);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
  }
}

try {
  const certificatePath = process.env.BRON_DEVICE_QA_TLS_CERT;
  const useTls = testDevice && Boolean(certificatePath);
  const server = useTls ? createSecureServer({
    cert: await readFile(certificatePath),
    key: await readFile(process.env.BRON_DEVICE_QA_TLS_KEY),
  }, serve) : createServer(serve);
  const origin = () => `${useTls ? 'https' : 'http'}://${host}:${server.address().port}`;
  backendUrl = await backendReady;
  if (testDevice) {
    if (!testPwa) throw new Error('Device QA requires two PWA builds.');
    deviceHarness = createDeviceHarness(backendUrl, readRevenueProof);
    server.listen(0, host);
    await once(server, 'listening');
  }
  if (!testPwa) {
    const landing = await readFile(resolve(landingDir, 'index.html'), 'utf8').catch((error) => {
      throw new Error(`Укажите каталог лендинга через BRON_LANDING_PATH: ${landingDir}`, { cause: error });
    });
    landingForTest = landing.replace(
      /(\bvar\s+API\s*=\s*)'https?:\/\/[^/'\s]+(\/[^']*)'(\s*,\s*KEY\s*=\s*)'[^']*'/,
      (_, api, path, key) => `${api}'${backendUrl}${path}'${key}'${publishableKey}'`,
    );
    if (landingForTest === landing) throw new Error('В анкете не найдено объявление API и KEY для локальной подмены.');
  }
  process.env.VITE_BASE_PATH = appPath;
  process.env.VITE_SUPABASE_URL = testDevice ? origin() : backendUrl;
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY = publishableKey;
  for (const outDir of testPwa ? [first, next] : [first]) await build({ build: { outDir, emptyOutDir: true } });
  server.on('error', (error) => { console.error(error); void stop(1); });
  const ready = () => {
    if (process.connected) process.send({ baseURL: origin(), backendUrl });
  };
  if (testDevice) ready();
  else server.listen(0, host, ready);
} catch (error) {
  console.error(error);
  await stop(1);
}
