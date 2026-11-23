import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, request } from 'node:http';
import { pathToFileURL } from 'node:url';

const ACCESS = '/_preview/access';
const CHECK = '/_preview/check';
const COOKIE = '__Host-bron-preview';
const FORM_COOKIE = '__Host-bron-preview-form';
const AGE = 30 * 24 * 60 * 60;
const ATTEMPT_WINDOW = 15 * 60 * 1000;
const API_PATH = /^\/(?:auth\/v1\/(?:health|token|user|logout)|rest\/v1\/[a-zA-Z0-9_/]+|storage\/v1\/object\/[a-zA-Z0-9_./~%\-]+)$/;

function equal(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function loginPage(token, error = '') {
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Бронь Сервис — тестовый кабинет</title>
  <style>*,*::before,*::after{box-sizing:border-box}body{margin:0;background:#10131a;color:#f3f5fa;font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100dvh;padding:16px}main{width:min(100%,400px);background:#171b24;border:1px solid #323b4f;border-radius:18px;padding:24px}h1{font-size:25px;line-height:1.2;margin:0 0 12px}p{color:#b4bed0;margin:0 0 20px}label{display:block;font-weight:600}input,button{width:100%;margin-top:8px;font:inherit;border-radius:9px;min-height:44px;padding:10px 12px}input{color:inherit;background:#10131a;border:1px solid #525f76}button{background:#3359ea;color:#fff;font-weight:650;border:0;margin-top:16px}input:focus-visible,button:focus-visible{outline:3px solid #a6b9fe;outline-offset:3px}[role=alert]{color:#ffb5b5;margin-top:12px}</style></head>
  <body><main><h1>Тестовый кабинет</h1><p>Бронь Сервис · учебные профили и данные</p><form method="post" action="${ACCESS}"><input type="hidden" name="form_token" value="${token}"><label for="access">Код доступа к стенду</label><input id="access" name="access" type="password" autocomplete="current-password" required maxlength="96"><button type="submit">Открыть кабинет</button>${error ? '<p role="alert">' + error + '</p>' : ''}</form></main></body></html>`;
}

function cookieValue(req, name) {
  return (req.headers.cookie ?? '').split(';').map(value => value.trim())
    .find(value => value.startsWith(name + '='))?.slice(name.length + 1) ?? '';
}

export function createPreviewGate({ origin, code, secret, apiPort, now = Date.now }) {
  if (new URL(origin).origin !== origin || !origin.startsWith('https://') ||
      typeof code !== 'string' || code.length < 20 || typeof secret !== 'string' || secret.length < 32 ||
      !Number.isInteger(apiPort) || apiPort < 1 || apiPort > 65535) {
    throw new Error('Preview gate configuration is invalid');
  }
  const sign = value => createHmac('sha256', secret).update(value).digest('base64url');
  let failures = 0;
  let attemptWindowStart = now();

  function issue(purpose, age) {
    const ticket = Math.floor(now() / 1000 + age) + '.' + randomBytes(16).toString('base64url');
    return ticket + '.' + sign(purpose + '.' + ticket);
  }

  function valid(token, purpose) {
    const parts = token.match(/^(\d{1,12})\.([a-zA-Z0-9_-]{22})\.([a-zA-Z0-9_-]{43})$/);
    if (!parts) return false;
    const [, expiry, nonce, signature] = parts;
    return Number(expiry) * 1000 > now() && equal(signature, sign(purpose + '.' + expiry + '.' + nonce));
  }

  function renderAccess(res, status, error) {
    const age = ATTEMPT_WINDOW / 1000;
    const token = issue('form', age);
    res.writeHead(status, { 'Set-Cookie': FORM_COOKIE + '=' + token + '; Path=/; Max-Age=' + age + '; Secure; HttpOnly; SameSite=Strict' });
    res.end(loginPage(token, error));
  }

  async function access(req, res) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    if (req.method === 'GET') { renderAccess(res, 200); return; }
    const sender = req.headers.origin;
    if (req.method !== 'POST' || (sender && sender !== 'null' && sender !== origin) || req.headers['sec-fetch-site'] === 'cross-site') {
      res.writeHead(403).end();
      return;
    }
    let body = '';
    for await (const chunk of req) {
      body += chunk.toString('utf8');
      if (body.length > 1024) { res.writeHead(413).end(); return; }
    }
    const form = new URLSearchParams(body);
    const token = cookieValue(req, FORM_COOKIE);
    if (!valid(token, 'form') || !equal(token, form.get('form_token') ?? '')) {
      renderAccess(res, 403, 'Форма открыта заново. Введите код ещё раз.');
      return;
    }
    if (now() - attemptWindowStart >= ATTEMPT_WINDOW) {
      attemptWindowStart = now();
      failures = 0;
    }
    if (failures >= 12) {
      res.setHeader('Retry-After', Math.max(1, Math.ceil((attemptWindowStart + ATTEMPT_WINDOW - now()) / 1000)));
      renderAccess(res, 429, 'Слишком много попыток. Попробуйте через несколько минут.');
      return;
    }
    if (!equal(form.get('access') ?? '', code)) {
      failures++;
      renderAccess(res, 401, 'Код доступа не подошёл.');
      return;
    }
    failures = 0;
    res.writeHead(303, {
      Location: '/',
      'Set-Cookie': COOKIE + '=' + issue('access', AGE) + '; Path=/; Max-Age=' + AGE + '; Secure; HttpOnly; SameSite=Lax',
    }).end();
  }

  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const path = req.url?.split('?')[0] ?? '';
    if (path === ACCESS) {
      try { await access(req, res); }
      catch { if (!res.headersSent) res.writeHead(400).end(); }
      return;
    }
    if (!valid(cookieValue(req, COOKIE), 'access')) {
      if (path === CHECK && (req.headers['x-forwarded-uri']?.split('?')[0] === '/' || req.headers.accept?.includes('text/html'))) {
        res.writeHead(303, { Location: ACCESS }).end();
      } else res.writeHead(401).end();
      return;
    }
    if (path === CHECK) { res.writeHead(204).end(); return; }
    if (!API_PATH.test(path) || /%2e|%2f|%5c|\.\./i.test(path)) {
      res.writeHead(404).end();
      return;
    }
    const { cookie, connection, host, ...headers } = req.headers;
    const proxy = request({ hostname: '127.0.0.1', port: apiPort, method: req.method, path: req.url, headers }, upstream => {
      res.writeHead(upstream.statusCode ?? 502, { ...upstream.headers, 'cache-control': 'no-store' });
      upstream.pipe(res);
    });
    proxy.on('error', () => { if (!res.headersSent) res.writeHead(502).end(); else res.destroy(); });
    res.on('close', () => proxy.destroy());
    req.pipe(proxy);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const gate = createPreviewGate({
    origin: process.env.BRON_PREVIEW_ORIGIN,
    code: process.env.BRON_PREVIEW_CODE,
    secret: process.env.BRON_PREVIEW_COOKIE_SECRET,
    apiPort: Number(process.env.BRON_PREVIEW_API_PORT),
  });
  gate.headersTimeout = 15_000;
  gate.requestTimeout = 40_000;
  gate.listen(Number(process.env.BRON_PREVIEW_GATE_PORT), process.env.BRON_PREVIEW_GATE_HOST);
}
