import { chromium, errors, expect, type Page } from '@playwright/test';
import type { QueuedOperation } from '../../src/platform/offline';
import { test } from './fixtures';

const appPath = '/bron-franchise/';
const versionPath = `${appPath}app-version.json`;
const workerPath = `${appPath}sw.js`;
const queuedPoint = 'Волгоград Европа';
const draftPoint = 'Волжский';
const queuedComment = 'Браузерная проверка очереди PWA';
const draftComment = 'Браузерная проверка черновика PWA';
const finalDraftComment = 'Уточнённая выручка после отправки очереди PWA';

function selectPoint(page: Page, point: string) {
  return page.getByRole('group', { name: 'Точка' }).getByRole('button', { name: point }).click();
}

async function openTodayRevenue(page: Page) {
  await page.getByRole('button', { name: /^(Внести выручку за сегодня|Сегодня внесено:)/ }).click();
  return page.getByRole('dialog', { name: /^Выручка —/ });
}

async function readQueue(page: Page): Promise<QueuedOperation[]> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('bron-local');
      request.onupgradeneeded = () => request.transaction?.abort();
      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result);
    });
    try {
      return await new Promise<QueuedOperation[]>((resolve, reject) => {
        const request = db.transaction('queue', 'readonly').objectStore('queue').getAll();
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
      });
    } finally {
      db.close();
    }
  });
}

async function expectDeferredRelease(page: Page, build: string, originalDocument: number) {
  await page.clock.fastForward(31_000);
  const versionCheck = page.waitForResponse(response => new URL(response.url()).pathname === versionPath);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(await (await versionCheck).json()).toEqual({ build });
  await expect(page.getByText('Доступна новая версия приложения.')).toBeVisible();
  await expect(page.waitForEvent('framenavigated', {
    predicate: frame => frame === page.mainFrame(),
    timeout: 1_000,
  })).rejects.toBeInstanceOf(errors.TimeoutError);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(originalDocument);
}

test('standalone PWA откладывает обновление до сохранения черновика и отправки очереди', async ({
  request, qa, headless, launchOptions, timezoneId, viewport,
}) => {
  const appUrl = new URL(appPath, qa.baseURL).href;
  const revenueRpc = `${qa.backendUrl}/rest/v1/rpc/revenue_total_set`;
  const originalVersion = await request.get(versionPath);
  const originalWorker = await request.get(workerPath);
  expect(originalVersion.ok()).toBe(true);
  expect(originalWorker.ok()).toBe(true);
  const { build: originalBuild } = await originalVersion.json();

  // Chromium's app window gives a real standalone display mode in headless CI.
  const context = await chromium.launchPersistentContext('', {
    ...launchOptions,
    channel: 'chromium',
    headless,
    timezoneId,
    viewport,
    args: [...(launchOptions?.args ?? []), `--app=${appUrl}`],
  });
  try {
    const [page] = context.pages();
    await page.waitForURL(url => url.origin + url.pathname === appUrl);
    expect(await page.evaluate(() => matchMedia('(display-mode: standalone)').matches)).toBe(true);
    const manifest = await request.get(`${appPath}manifest.webmanifest`);
    expect(await manifest.json()).toMatchObject({ display: 'standalone', scope: appPath, start_url: appPath });

    await expect.poll(() => page.evaluate(async () =>
      (await navigator.serviceWorker.getRegistration())?.active?.state)).toBe('activated');
    await page.clock.install();
    await page.reload();
    const mainAsset = page.locator('script[type="module"][src]');
    const oldAsset = (await mainAsset.getAttribute('src'))!;
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(new URL(workerPath, appUrl).href);
    expect(await page.evaluate(async asset => (await caches.match(asset))?.ok, oldAsset)).toBe(true);
    const oldDocument = await page.evaluate(() => performance.timeOrigin);

    await page.getByLabel(/^Логин/).fill('alpha.owner@demo.example.com');
    await page.getByLabel(/^Пароль/).fill('Browser-QA-2026!');
    await page.getByRole('button', { name: 'Войти', exact: true }).click();

    let breakQueueTransport = true;
    await page.route(revenueRpc, async route => {
      const req = route.request();
      if (breakQueueTransport && req.method() === 'POST' && req.postDataJSON().p_comment === queuedComment) {
        await route.abort('connectionreset');
      } else {
        await route.continue();
      }
    });
    await selectPoint(page, queuedPoint);
    const queuedDialog = await openTodayRevenue(page);
    await queuedDialog.getByLabel(/^Вся выручка точки за день/).fill('14321,05');
    await queuedDialog.getByLabel('Комментарий').fill(queuedComment);
    await queuedDialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const queueNotice = page.getByText('Сохранено на устройстве и ждёт отправки: 1.');
    await expect(queueNotice).toBeVisible();
    const queued = await readQueue(page);
    expect(queued).toEqual([expect.objectContaining({
      kind: 'revenue_total_set',
      payload: expect.objectContaining({ total: '1432105', comment: queuedComment }),
    })]);

    await selectPoint(page, draftPoint);
    const draftDialog = await openTodayRevenue(page);
    const draftAmount = draftDialog.getByLabel(/^Вся выручка точки за день/);
    const draftNote = draftDialog.getByLabel('Комментарий');
    await draftAmount.fill('15234,56');
    await draftNote.fill(draftComment);

    const release = await request.post('/__qa/publish');
    expect(release.ok()).toBe(true);
    const { build: newBuild } = await release.json();
    expect(newBuild).not.toBe(originalBuild);
    const nextWorker = await request.get(workerPath);
    expect(nextWorker.ok()).toBe(true);
    const nextWorkerSource = await nextWorker.text();
    expect(nextWorkerSource).not.toBe(await originalWorker.text());

    await expectDeferredRelease(page, newBuild, oldDocument);
    await expect(draftAmount).toHaveValue('15234,56');
    await expect(draftNote).toHaveValue(draftComment);
    expect(await readQueue(page)).toEqual(queued);

    await draftDialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(draftDialog).toBeHidden();
    await expect(page.getByText(draftComment, { exact: true })).toBeVisible();
    await expectDeferredRelease(page, newBuild, oldDocument);
    const update = page.getByRole('button', { name: 'Обновить', exact: true });
    await update.click();
    await expect(page.getByText('Завершите ввод и отправку записей перед обновлением.')).toBeVisible();
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(oldDocument);
    await expect(queueNotice).toBeVisible();

    await openTodayRevenue(page);
    await draftAmount.fill('15234,79');
    await draftNote.fill(finalDraftComment);
    breakQueueTransport = false;
    const replay = page.waitForResponse(response => response.url() === revenueRpc &&
      response.request().method() === 'POST' && response.request().postDataJSON().p_comment === queuedComment);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const replayed = await replay;
    expect(replayed.ok()).toBe(true);
    expect(replayed.request().postDataJSON().p_operation).toBe(queued[0].clientOpId);
    expect(await replayed.json()).toMatchObject({ total_minor: 1432105 });
    await expect(queueNotice).toBeHidden();
    expect(await readQueue(page)).toEqual([]);
    await expectDeferredRelease(page, newBuild, oldDocument);
    await expect(draftAmount).toHaveValue('15234,79');
    await expect(draftNote).toHaveValue(finalDraftComment);
    await draftDialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(draftDialog).toBeHidden();
    await expect(page.getByText(finalDraftComment, { exact: true })).toBeVisible();

    const reload = page.waitForEvent('framenavigated', frame => frame === page.mainFrame());
    await update.click();
    await reload;
    expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(oldDocument);
    const newAsset = (await mainAsset.getAttribute('src'))!;
    expect(newAsset).not.toBe(oldAsset);
    expect(nextWorkerSource).toContain(newAsset.slice(appPath.length));
    expect(await page.evaluate(async asset => (await caches.match(asset))?.ok, newAsset)).toBe(true);
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.state)).toBe('activated');
    await expect(page.getByRole('button', { name: 'Профиль' })).toBeVisible();
    await expect(update).toBeHidden();
    await expect(page.getByText(finalDraftComment, { exact: true })).toBeVisible();
    await selectPoint(page, queuedPoint);
    await expect(page.getByText(queuedComment, { exact: true })).toBeVisible();
    expect(await readQueue(page)).toEqual([]);
  } finally {
    await context.close();
  }
});
