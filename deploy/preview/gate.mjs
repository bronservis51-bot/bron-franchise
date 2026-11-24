import { createServer, request } from 'node:http';
import { isIP } from 'node:net';
import { pathToFileURL } from 'node:url';

const API_PATH = /^\/(?:auth\/v1\/(?:health|token|user|logout)|rest\/v1\/[a-zA-Z0-9_/]+|storage\/v1\/object\/[a-zA-Z0-9_./~%\-]+)$/;
const SIGNED_FILE = '/storage/v1/object/sign/private-files/';
const ATTEMPT_WINDOW = 15 * 60 * 1000;
const ATTEMPT_LIMIT = 12;
const MAX_TRACKED_ADDRESSES = 2048;

function reject(res, status, code, message, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ code, message }));
}

function clientAddress(req) {
  const forwarded = req.headers['x-forwarded-for']?.split(',').at(-1)?.trim();
  return isIP(forwarded ?? '') ? forwarded : req.socket.remoteAddress;
}

export function createPreviewGate({ origin, apiPort, now = Date.now }) {
  if (new URL(origin).origin !== origin || !origin.startsWith('https://') ||
      !Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error('Preview API proxy configuration is invalid');
  }
  const failedLogins = new Map();
  let active = 0;

  return createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const sender = req.headers.origin;
    if ((sender && sender !== 'null' && sender !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
      return reject(res, 403, 'origin_not_allowed', 'Origin not allowed');
    }
    const [path, query = ''] = (req.url ?? '').split('?');
    if (!API_PATH.test(path) || /%2e|%2f|%5c|\.\./i.test(path)) {
      return reject(res, 404, 'not_found', 'Route not found');
    }
    const grant = new URLSearchParams(query).get('grant_type');
    const tokenRequest = path === '/auth/v1/token' && req.method === 'POST' && ['password', 'refresh_token'].includes(grant);
    const signedFile = req.method === 'GET' && path.startsWith(SIGNED_FILE);
    const publicRequest = tokenRequest || signedFile ||
      (path === '/auth/v1/health' && req.method === 'GET') ||
      (path === '/rest/v1/rpc/ping' && req.method === 'POST');
    const bearer = /^Bearer [a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/i.test(req.headers.authorization ?? '');
    if (!publicRequest && !bearer) return reject(res, 401, 'login_required', 'Sign in to the preview');

    const tracksLogin = tokenRequest && grant === 'password';
    const address = tracksLogin ? clientAddress(req) : null;
    let failures = address ? failedLogins.get(address) : null;
    if (failures && failures.until <= now()) {
      failedLogins.delete(address);
      failures = null;
    }
    if (failures && failures.count >= ATTEMPT_LIMIT) {
      return reject(res, 429, 'over_request_rate_limit', 'Too many login attempts', {
        'Retry-After': Math.ceil((failures.until - now()) / 1000),
      });
    }
    if (active >= 24) return reject(res, 503, 'preview_busy', 'Preview is busy');

    active++;
    const { cookie, connection, host, ...headers } = req.headers;
    const proxy = request({ hostname: '127.0.0.1', port: apiPort, method: req.method, path: req.url, headers }, upstream => {
      if (address && (upstream.statusCode === 400 || upstream.statusCode === 401)) {
        const prior = failedLogins.get(address);
        const bucket = prior?.until > now() ? prior : { until: now() + ATTEMPT_WINDOW, count: 0 };
        if (!prior && failedLogins.size >= MAX_TRACKED_ADDRESSES) failedLogins.delete(failedLogins.keys().next().value);
        bucket.count++;
        failedLogins.set(address, bucket);
      } else if (address && upstream.statusCode === 200) failedLogins.delete(address);
      res.writeHead(upstream.statusCode ?? 502, { ...upstream.headers, 'cache-control': 'no-store' });
      upstream.pipe(res);
    });
    proxy.on('error', () => { if (!res.headersSent) reject(res, 502, 'api_unavailable', 'Preview API unavailable'); else res.destroy(); });
    res.on('close', () => { active--; proxy.destroy(); });
    req.pipe(proxy);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gate = createPreviewGate({ origin: process.env.BRON_PREVIEW_ORIGIN, apiPort: Number(process.env.BRON_PREVIEW_API_PORT) });
  gate.headersTimeout = 15_000;
  gate.requestTimeout = 40_000;
  gate.listen(Number(process.env.BRON_PREVIEW_GATE_PORT), process.env.BRON_PREVIEW_GATE_HOST);
}
