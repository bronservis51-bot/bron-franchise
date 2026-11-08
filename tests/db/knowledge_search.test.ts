import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

const MANAGER = 'fm@demo.example.com';
const PARTNER = 'alpha.owner@demo.example.com';
interface Hit { article_id: string; title: string; snippet: string; status: string; rank: number }
let t: TestDb;
const ids: Record<string, string> = {};

const search = (query: string, editor = false, drafts = false, limit = 20) =>
  t.as<Hit>(editor ? MANAGER : PARTNER, 'select * from public.kb_search($1, $2, $3)', [query, drafts, limit]);

beforeAll(async () => {
  t = await createTestDb();
  const section = (await t.admin<{ id: string }>("insert into public.kb_section(slug,title) values ('search-fixture','Проверка поиска') returning id"))[0].id;
  const fixtures = [
    ['hire', 'Найм: от вакансии до первого выхода', 'Поиск и отбор кандидатов', 'Проведите собеседование, обсудите задачи сотрудника.', [], 'published'],
    ['adaptation', 'Адаптация сотрудника', 'Первый день и обучение', 'После найма познакомьте сотрудника с работой.', [], 'published'],
    ['login', 'Вход в кабинет: пароль и доступ сотрудника', 'Что делать при забытом пароле', 'Если забыли пароль, попросите владельца сменить пароль.', [], 'published'],
    ['stock', 'Нет товара в наличии', 'Запрос поставки', 'Уточните возможность предзаказа.', [], 'published'],
    ['products', 'Обзор товара', 'Ассортимент магазина', 'Описание товара, характеристик и упаковки.', [], 'published'],
    ['interview', 'Собеседование с кандидатом', 'Вопросы для отбора', 'Попросите кандидата рассказать о своём опыте. Проверьте ответы.', [], 'published'],
    ['form', 'Своя анкета для отбора кандидатов', 'Копия формы и ответы', 'Откройте анкету в своём аккаунте. Затем скопируйте форму.', ['Google Forms'], 'published'],
    ['bubbles', 'Пузыри после оклейки', 'Проверка качества', 'При осмотре плёнки обратите внимание на пузыри и загрязнения.', [], 'published'],
    ['warranty', 'Гарантия на плёнку', 'Порядок работы с обращением', 'Проверьте материал и обстоятельства обращения клиента.', [], 'published'],
    ['tagged', 'Порядок действий при обращении', 'Что зафиксировать', 'Сохраните документы и фотографии.', ['недостача', 'брак'], 'published'],
    ['body', 'Длинный учебный материал', 'Начало урока', `${'Обычная вводная информация. '.repeat(100)}Маркировка микрометеорит помогает найти нужный фрагмент.`, [], 'published'],
    ['draft', 'Секретный черновик квазаркандидат', '', 'Не показывать читателям.', [], 'draft'],
    ['archived', 'Старый документ мегазебра', '', 'Снят с публикации.', [], 'archived'],
    ['revisions', 'Действующая инструкция о кибернайме', '', 'Текущая опубликованная версия.', [], 'published'],
  ] as const;
  for (const [key, title, summary, body, tags, status] of fixtures) {
    const article = (await t.admin<{ id: string }>(
      'insert into public.article(slug,section_id,tags,status) values ($1,$2,$3,$4) returning id',
      [`search-${key}`, section, tags, status],
    ))[0].id;
    const rev = (await t.admin<{ id: string }>(
      'insert into public.article_revision(article_id,rev_no,title,summary,body,status,published_at) values ($1,1,$2,$3,$4,$5,now()) returning id',
      [article, title, summary, body, status === 'draft' ? 'draft' : 'published'],
    ))[0].id;
    if (status !== 'draft') await t.admin('update public.article set published_revision_id=$2 where id=$1', [article, rev]);
    ids[key] = article;
  }
  await t.admin("insert into public.article_revision(article_id,rev_no,title,body,status) values ($1,2,'Новая инструкция о кибернайме','Неопубликованное изменение.','draft')", [ids.revisions]);
}, 180_000);

afterAll(async () => { await t?.db.close(); });

describe('поиск по задачам франчайзи', () => {
  it('ставит точное название первым и учитывает все значимые слова вопроса', async () => {
    expect((await search('как нанять сотрудника'))[0].article_id).toBe(ids.hire);
    expect((await search('Найм: от вакансии до первого выхода'))[0].article_id).toBe(ids.hire);
    expect(await search('нанять микрометеорит')).toHaveLength(0);
    expect(await search('договор лунного единорога')).toHaveLength(0);
  });

  it('понимает словоформы, ё/е, опечатки и незавершённое слово', async () => {
    expect((await search('собеседовании кандидатов'))[0].article_id).toBe(ids.interview);
    expect((await search('гарантия на пленку'))[0].article_id).toBe(ids.warranty);
    expect((await search('собесидование'))[0].article_id).toBe(ids.interview);
    expect((await search('собесе')).some(x => x.article_id === ids.interview)).toBe(true);
    expect((await search('пузыри оклеки'))[0].article_id).toBe(ids.bubbles);
  });

  it('ищет русскую раскладку, сохраняя поиск латинских названий', async () => {
    expect((await search('ufhfynbz'))[0].article_id).toBe(ids.warranty);
    expect((await search('Google Forms'))[0].article_id).toBe(ids.form);
  });

  it('учитывает теги и показывает фрагмент из глубины статьи', async () => {
    expect((await search('недостача'))[0].article_id).toBe(ids.tagged);
    const body = (await search('микрометеорит'))[0];
    expect(body.article_id).toBe(ids.body);
    expect(body.snippet).toContain('«микрометеорит»');
    expect(body.snippet.length).toBeLessThan(1000);
  });

  it('использует синоним внутри запроса, не подменяя остальные условия', async () => {
    expect((await search('найм сотрудника'))[0].article_id).toBe(ids.hire);
    expect((await search('как восстановить пароль'))[0].article_id).toBe(ids.login);
    expect(await search('найм микрометеорит')).toHaveLength(0);
    const stock = await search('нет товара');
    expect(stock[0].article_id).toBe(ids.stock);
    expect(stock.some(x => x.article_id === ids.products)).toBe(false);
  });

  it('пустой, служебный и очень длинный ввод безопасны; limit ограничен', async () => {
    for (const query of ['', ' ', 'а', '&&&&', '%_[]()']) expect(await search(query)).toEqual([]);
    expect((await search('собеседование', false, false, 1)).length).toBe(1);
    expect((await search('x'.repeat(2000))).length).toBe(0);
  });

  it('фиксирует неудачный поиск читателя, а запрос менеджера не загрязняет отчёт', async () => {
    await search('неизвестныйкосмолист');
    await search('редакторскийкосмолист', true);
    const logs = await t.admin<{ query: string; results: number }>("select query,results from public.kb_search_log where query like '%космолист'");
    expect(logs).toEqual([{ query: 'неизвестныйкосмолист', results: 0 }]);
  });
});

describe('видимость поиска и совместимость', () => {
  it('не раскрывает черновики читателю даже с include_drafts, архив исключён всем', async () => {
    expect(await search('квазаркандидат', false, true)).toEqual([]);
    expect(await search('квазаркандидат', true, false)).toEqual([]);
    expect((await search('квазаркандидат', true, true))[0].status).toBe('draft');
    expect(await search('мегазебра', true, true)).toEqual([]);
  });

  it('возвращает одну разрешённую редакцию на статью', async () => {
    const reader = await search('кибернайм', false, true);
    const editor = await search('кибернайм', true, true);
    expect(reader).toHaveLength(1);
    expect(reader[0].title).toContain('Действующая');
    expect(reader[0].status).toBe('published');
    expect(editor).toHaveLength(1);
    expect(editor[0].title).toContain('Новая');
    expect(editor[0].status).toBe('draft');
    const publishedMatch = await search('действующая кибернайм', true, true);
    expect(publishedMatch).toHaveLength(1);
    expect(publishedMatch[0].status).toBe('published');
  });

  it('аноним и отозванная сессия не могут искать', async () => {
    await expect(t.as(null, "select * from public.kb_search('гарантия')")).rejects.toThrow(/permission denied/);
    const user = await t.userId(PARTNER);
    await expect(t.db.transaction(async tx => {
      await tx.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user, role: 'authenticated', session_id: 'a0000000-0000-0000-0000-000000000099' })]);
      await tx.exec('set local role authenticated');
      await tx.query("select * from public.kb_search('гарантия')");
    })).rejects.toThrow('unauthenticated');
  });
});
