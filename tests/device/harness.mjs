import { readFile } from 'node:fs/promises';

export const deviceQaComment = 'Тест выручки на установленной PWA';
export const deviceQaTotal = 1432105;
const revenuePath = '/rest/v1/rpc/revenue_total_set';

export function createDeviceHarness(backendUrl, readRevenueProof) {
  let state = { stage: 'waiting' };
  let blocked = false;
  const send = (res, value, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(value));

  return async (req, res, url, publish) => {
    if (req.method === 'GET' && url.pathname === '/__qa/device-status') {
      return send(res, state.stage === 'passed'
        ? { ...state, revenue: await readRevenueProof(deviceQaComment) }
        : state);
    }
    if (req.method === 'GET' && url.pathname === '/__qa/device-client.js') {
      const script = await readFile(new URL('./client.js', import.meta.url), 'utf8');
      return res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' }).end(script);
    }
    if (req.method === 'POST' && url.pathname === '/__qa/device-command') {
      const { action, stage, detail } = await new Response(req).json();
      if (action === 'block') blocked = true;
      else if (action === 'unblock') blocked = false;
      else if (action === 'publish') return send(res, await publish());
      else if (action === 'report' && ['installed', 'queued', 'updating', 'synced', 'passed', 'failed'].includes(stage)) {
        state = { stage, detail: String(detail ?? '').slice(0, 400) };
      } else return send(res, { error: 'Unknown device check action' }, 400);
      return send(res, { ok: true });
    }
    if (!/^\/(auth|rest|storage)\/v1\//.test(url.pathname)) return;
    const write = req.method === 'POST' && url.pathname === revenuePath;
    if (write && blocked) return send(res, { message: 'external-unavailable' }, 503);
    const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await new Response(req).arrayBuffer();
    const headers = new Headers();
    for (const name of ['authorization', 'apikey', 'content-type', 'x-client-info', 'x-request-id']) {
      if (typeof req.headers[name] === 'string') headers.set(name, req.headers[name]);
    }
    const upstream = new URL(backendUrl);
    upstream.pathname = url.pathname;
    upstream.search = url.search;
    const response = await fetch(upstream, { method: req.method, headers, body, redirect: 'error' });
    const data = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
    return res.writeHead(response.status, { 'content-type': contentType }).end(data);
  };
}
