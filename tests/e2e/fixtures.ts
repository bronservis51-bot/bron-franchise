import { fork } from 'node:child_process';
import { once } from 'node:events';
import { test as base } from '@playwright/test';

type QaAddresses = { baseURL: string; backendUrl: string };

export const test = base.extend<{}, { qa: QaAddresses }>({
  qa: [async ({}, use, workerInfo) => {
    // Each project gets its own ports and database, including independent test writes.
    const server = fork(new URL('./server.mjs', import.meta.url), [], {
      env: { ...process.env, BRON_E2E_PWA: workerInfo.project.name === 'pwa-chromium' ? '1' : '0' },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
    });
    const stopped = new Promise<[number | null, NodeJS.Signals | null]>(resolve => {
      server.once('close', (code, signal) => resolve([code, signal]));
    });
    const ready = once(server, 'message', { signal: AbortSignal.timeout(100_000) });
    try {
      const [addresses] = await Promise.race([
        ready,
        stopped.then(([code, signal]) => { throw new Error(`QA-стенд завершился при запуске (${code ?? signal})`); }),
      ]);
      await use(addresses as QaAddresses);
    } finally {
      server.kill();
      await stopped;
    }
  }, { scope: 'worker', timeout: 110_000 }],
  baseURL: async ({ qa }, use) => use(qa.baseURL),
});
