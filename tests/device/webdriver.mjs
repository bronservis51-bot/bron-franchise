const appium = 'http://127.0.0.1:4723';
const elementKey = 'element-6066-11e4-a52e-4f735466cecf';

async function request(method, path, body, timeout = 45_000) {
  const response = await fetch(appium + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const { value } = await response.json();
  if (!response.ok || value?.error) {
    const error = new Error(`${method} ${path}: ${value?.message ?? response.status}`);
    error.code = value?.error;
    throw error;
  }
  return value;
}

export async function newSession(capabilities) {
  const { sessionId } = await request('POST', '/session', { capabilities: { alwaysMatch: capabilities } }, 240_000);
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
