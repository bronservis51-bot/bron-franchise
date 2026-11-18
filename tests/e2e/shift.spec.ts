import { expect, type Page } from '@playwright/test';
import { test } from './fixtures';

const app = '/bron-franchise/';
const password = 'Browser-QA-2026!';

async function signIn(page: Page, login: string) {
  await page.goto(app);
  await page.getByLabel('Логин').fill(login);
  await page.getByLabel(/^Пароль/).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).tap();
}

test('ответ о закрытии смены потерян: повтор доставляет выручку один раз', async ({ page, browser, qa }) => {
  await signIn(page, '79000000011');
  await page.getByRole('button', { name: 'Закрыть смену и внести выручку' }).click();
  const dialog = page.getByRole('dialog', { name: 'Закрыть смену' });
  await dialog.getByLabel('Наличные').fill('8321');
  await dialog.getByLabel('Картой').fill('4024');
  const path = `${qa.backendUrl}/rest/v1/rpc/shift_close_versioned`;
  let committedRequest: unknown;
  const requests: unknown[] = [];
  await page.route(path, async (route) => {
    if (route.request().method() !== 'POST') {
      await route.continue();
      return;
    }
    requests.push(route.request().postDataJSON());
    if (requests.length === 1) {
      const committed = await route.fetch({ maxRetries: 0 });
      expect(committed.ok()).toBe(true);
      committedRequest = await committed.json();
      await route.abort('connectionreset');
      return;
    }
    await route.continue();
  });
  await dialog.getByRole('button', { name: 'Закрыть смену', exact: true }).tap();
  await expect(page.getByText(/Итог сохранён на телефоне/)).toBeVisible();
  const retry = page.waitForResponse(response => response.url() === path &&
    response.request().method() === 'POST' && response.ok());
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect(await (await retry).json()).toEqual(committedRequest);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  await expect(page.getByRole('button', { name: /смена закрыта, заработано/ })).toBeVisible();

  const owner = await browser.newContext();
  try {
    const ownerPage = await owner.newPage();
    await signIn(ownerPage, 'alpha.owner@demo.example.com');
    await ownerPage.getByRole('group', { name: 'Точка' })
      .getByRole('button', { name: /Волгоград Ворошиловский/ }).click();
    await expect(ownerPage.getByRole('button', { name: /Сегодня внесено/ })).toContainText(/12\s?345/);
  } finally {
    await owner.close();
  }
});
