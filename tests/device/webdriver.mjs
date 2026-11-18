import { request as httpRequest } from 'node:http';

const appium = 'http://127.0.0.1:4723';
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';

async function request(method, path, body, timeout = 45_000) {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  // A cold iOS run can take longer than fetch's default response-header timeout.
  const { status, data } = await new Promise((resolve, reject) => {
    const req = httpRequest(appium + path, {
      method,
      headers: payload === undefined ? undefined : {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(payload),
      },
      signal: AbortSignal.timeout(timeout),
    }, res => {
      res.setEncoding('utf8');
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.once('error', reject);
      res.once('end', () => resolve({ status: res.statusCode, data }));
    });
    req.once('error', reject);
    req.end(payload);
  });
  const { value } = JSON.parse(data);
  if (status < 200 || status >= 300 || value?.error) {
    const error = new Error(`${method} ${path}: ${value?.message ?? status}`);
    error.code = value?.error;
    throw error;
  }
  return value;
}

export async function newSession(capabilities, timeout = 240_000) {
  const { sessionId } = await request('POST', '/session', { capabilities: { alwaysMatch: capabilities } }, timeout);
  if (!sessionId) throw new Error('Appium did not return a session ID.');
  const command = (method, path, body) => request(method, `/session/${sessionId}${path}`, body);
  function element(ref) {
    const id = ref[elementKey];
    if (!id) throw new Error('Appium returned an invalid element reference.');
    const at = `/element/${encodeURIComponent(id)}`;
    return {
      click: () => command('POST', `${at}/click`, {}),
      text: () => command('GET', `${at}/text`),
      attribute: name => command('GET', `${at}/attribute/${encodeURIComponent(name)}`),
    };
  }
  return {
    command,
    find: async (using, value) => element(await command('POST', '/element', { using, value })),
    all: async (using, value) => (await command('POST', '/elements', { using, value })).map(element),
    execute: (script, args = []) => command('POST', '/execute/sync', { script, args }),
    source: () => command('GET', '/source'),
    close: () => command('DELETE', ''),
  };
}
