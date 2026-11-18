import { expect, type BrowserContext } from '@playwright/test';
import { test } from './fixtures';

test.use({ serviceWorkers: 'block' });

async function restrictToLocalServices(context: BrowserContext, origins: string[]) {
  await context.route('**/*', async route => {
    const { origin } = new URL(route.request().url());
    if (origins.includes(origin)) {
      await route.continue();
      return;
    }
    await route.abort();
  });
}

test('анкета с лендинга появляется один раз в кабинете менеджера', async ({ browser, page, qa }) => {
  const leadSubmitUrl = `${qa.backendUrl}/rest/v1/rpc/lead_submit`;
  const origins = [qa.baseURL, qa.backendUrl];
  const lead = {
    name: 'Тестовая Заявка',
    city: 'Тестовый город',
    phone: '+1 202 555 0142',
    comment: 'Проверка передачи анкеты с лендинга',
  };

  await restrictToLocalServices(page.context(), origins);
  await page.goto('/bron-franchise/');
  await page.getByLabel('Логин').fill('fm@demo.example.com');
  await page.getByLabel(/^Пароль/).fill('Browser-QA-2026!');
  await page.getByRole('button', { name: 'Войти', exact: true }).tap();
  await page.getByRole('link', { name: /^Заявки(?:\s|$)/ }).click();

  const board = page.getByRole('region', { name: 'Канбан заявок. Прокручивается горизонтально' });
  await expect(board).toBeVisible();
  await page.getByRole('textbox', { name: 'Поиск заявок' }).fill(lead.phone);
  const phoneLink = board.getByRole('link', { name: lead.phone, exact: true });
  await expect(phoneLink).toHaveCount(0);

  const visitor = await browser.newContext();
  try {
    await restrictToLocalServices(visitor, origins);
    const landing = await visitor.newPage();
    await landing.goto('/landing/?utm_source=browser-e2e');
    await landing.getByRole('banner').getByRole('button', { name: 'Купить франшизу' }).tap();
    const quiz = landing.getByRole('dialog', { name: 'Анкета на франшизу «Бронь Сервис»' });

    await quiz.getByLabel('Город', { exact: true }).fill(lead.city);
    await quiz.getByText('В ближайший месяц', { exact: true }).click();
    await quiz.getByRole('button', { name: 'Дальше' }).click();
    await quiz.getByText('Есть вся сумма ≈ 1 млн ₽', { exact: true }).click();
    await quiz.getByText('Сам(а), буду на точке', { exact: true }).click();
    await quiz.getByText('Это первый бизнес', { exact: true }).click();
    await quiz.getByRole('button', { name: 'Дальше' }).click();
    await quiz.getByText('Есть место с потоком людей', { exact: true }).click();
    await quiz.getByLabel('Имя', { exact: true }).fill(lead.name);
    await quiz.getByLabel('Телефон', { exact: true }).fill(lead.phone);
    await quiz.getByText('Звонок', { exact: true }).click();
    await quiz.getByLabel('Комментарий').fill(lead.comment);
    await expect(quiz.getByRole('checkbox', { name: /на обработку моих данных/ })).toBeChecked();

    const [response] = await Promise.all([
      landing.waitForResponse(res => res.url() === leadSubmitUrl && res.request().method() === 'POST'),
      quiz.getByRole('button', { name: 'Отправить анкету' }).tap(),
    ]);
    const submission = response.request();
    const apiKey = await submission.headerValue('apikey');
    expect(apiKey).toBeTruthy();
    expect(await submission.headerValue('authorization')).toBe(`Bearer ${apiKey}`);
    expect(submission.postDataJSON()).toEqual({ p_lead: {
      ...lead,
      timing: 'month',
      budget: 'full',
      manage: 'self',
      experience: 'none',
      place: 'has',
      contact_via: 'call',
      website: '',
      source: 'utm_source=browser-e2e',
    } });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    await expect(quiz.getByRole('heading', { name: 'Спасибо, Тестовая!' })).toBeVisible();
  } finally {
    await visitor.close();
  }

  await page.getByRole('button', { name: 'Обновить заявки' }).click();
  await expect(phoneLink).toHaveCount(1);
  await expect(phoneLink).toHaveAttribute('href', 'tel:+12025550142');

  const ready = board.getByRole('region', { name: 'Готовы к открытию' });
  const card = ready.getByRole('article').filter({ hasText: lead.phone });
  await expect(card.getByText(lead.city, { exact: true })).toBeVisible();
  await card.getByRole('button', { name: lead.name, exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Заявка', exact: true });
  await editor.getByText('Дополнительно', { exact: true }).click();
  await expect(editor.getByLabel('Телефон')).toHaveValue(lead.phone);
  await expect(editor.getByLabel('Город')).toHaveValue(lead.city);
  await expect(editor.getByText(lead.comment, { exact: true })).toBeVisible();
});
