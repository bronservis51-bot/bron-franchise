// Synthetic knowledge data for visual QA. These routes never reach a live backend.
import type { Card, Section } from '../../src/modules/knowledge/api';

type FixtureSection = Section & { count: number };
const definitions: [string, string, string | null, string, string][] = [
  ['nachalo', 'Начало работы', null, 'rocket', 'Первый вход и ориентиры в кабинете'],
  ['zapusk-i-obuchenie', 'Открытие и обучение', null, 'graduation', 'От подготовки к открытию до первых клиентов'],
  ['zapusk-podgotovka', 'Подготовка к открытию', 'zapusk-i-obuchenie', 'rocket', 'Помещение, оборудование и подготовка команды'],
  ['kurs-osnovy', 'Курс: основы и оборудование', 'zapusk-i-obuchenie', 'graduation', 'Знакомство с материалами и рабочим местом'],
  ['kurs-ekran', 'Курс: оклейка экрана', 'zapusk-i-obuchenie', 'smartphone', 'Последовательность работы и проверка качества'],
  ['attestatsiya', 'Проверка навыков и допуск', 'zapusk-i-obuchenie', 'graduation', 'Оценка готовности к самостоятельной работе'],
  ['komanda', 'Команда', null, 'users', 'Найм, обучение и ежедневная работа сотрудников'],
  ['naym', 'Найм сотрудников', 'komanda', 'users', 'Анкета кандидата и проведение собеседования'],
  ['adaptatsiya', 'Адаптация и обучение', 'komanda', 'graduation', 'От первого дня до самостоятельной смены'],
  ['grafik-oplata', 'График и оплата труда', 'komanda', 'wallet', 'Организация смен и работа с начислениями'],
  ['dokumenty-sotrudnichestvo', 'Документы и сотрудничество', null, 'clipboard', 'Договор, бренд и изменения сотрудничества'],
  ['dogovor-territoriya', 'Договор и территория', 'dokumenty-sotrudnichestvo', 'clipboard', 'Где найти условия и задать вопрос'],
  ['brend-makety', 'Брендбук и макеты', 'dokumenty-sotrudnichestvo', 'star', 'Фирменные материалы для торговой точки'],
  ['izmeneniya-partnerstva', 'Изменения и завершение сотрудничества', 'dokumenty-sotrudnichestvo', 'clipboard', 'Переезд и изменения в работе точки'],
  ['pomoshch', 'Помощь и нештатные ситуации', null, 'wrench', 'Разобраться в проблеме и обратиться за помощью'],
  ['kontakty-podderzhki', 'Контакты и обращения', 'pomoshch', 'users', 'Как сформулировать вопрос и приложить сведения'],
  ['intsidenty', 'Нештатные ситуации', 'pomoshch', 'shield', 'Проблемы на точке и порядок действий'],
  ['kabinet-dostupy', 'Кабинет и доступы', 'pomoshch', 'wrench', 'Вход, сотрудники и доступ к разделам'],
  ['zakupki', 'Закупки и логистика', null, 'wallet', 'От заказа материалов до приёмки поставки'],
  ['zakaz-oplata', 'Заказ и оплата', 'zakupki', 'wallet', 'Выбор товаров и согласование заказа'],
  ['dostavka-priemka', 'Доставка и приёмка', 'zakupki', 'clipboard', 'Проверка количества и состояния товара'],
  ['brak-vozvrat', 'Брак и возврат поставки', 'zakupki', 'shield', 'Что делать при расхождениях в поставке'],
  ['finansy-royalti', 'Финансы и роялти', null, 'wallet', 'Выручка, расходы и взаиморасчёты'],
  ['upravlenie-tochkoy', 'Управление точкой', null, 'clipboard', 'Открытие смены и контроль работы'],
  ['smena', 'Открытие и закрытие смены', 'upravlenie-tochkoy', 'clipboard', 'Ежедневная работа в кабинете'],
  ['kontrol', 'Контроль работы точки', 'upravlenie-tochkoy', 'clipboard', 'Чек-листы и работа с отклонениями'],
  ['garantii', 'Гарантии и жалобы', null, 'shield', 'Что делать, если клиент недоволен'],
  ['okleyka', 'Оклейка', null, 'smartphone', 'Материалы, технология и проверка качества'],
  ['oborudovanie', 'Оборудование и лекала', null, 'wrench', 'Плоттер, программы и расходники'],
  ['prodazhi', 'Клиенты и продажи', null, 'users', 'Консультация и ответы на вопросы клиентов'],
  ['marketing-prodvizhenie', 'Маркетинг / продвижение', null, 'megaphone', 'Контент и продвижение торговой точки'],
];
const sectionId = (slug: string) => slug === 'garantii' ? 'qa-section' : `qa-${slug}`;
export const knowledgeSections: FixtureSection[] = definitions.map(([slug, title, parent, icon, description], i) => ({
  id: sectionId(slug), slug, title, description, parent_id: parent ? sectionId(parent) : null, icon, sort: i * 10, count: 0,
}));
const articleDefinitions: [string, string, string, string, boolean][] = [
  ['qa-article', 'Гарантия: как принимать обращение', 'garantii', 'regulation', false],
  ['qa-hiring', 'Найм: от вакансии до первого выхода сотрудника', 'naym', 'instruction', false],
  ['qa-form', 'Анкета кандидата: как создать свою копию Google Forms', 'naym', 'instruction', false],
  ['qa-interview', 'Как провести собеседование и сравнить кандидатов', 'naym', 'checklist', false],
  ['qa-adaptation', 'Адаптация сотрудника: первый день и проверка навыков', 'adaptatsiya', 'checklist', false],
  ['qa-long', 'Очень длинное название статьи о работе с нестандартным обращением и дополнительными вопросами франчайзи', 'garantii', 'faq', false],
  ['qa-start', 'С чего начать подготовку торговой точки', 'zapusk-podgotovka', 'instruction', false],
  ['qa-login', 'Как войти в кабинет и выдать доступ сотруднику', 'kabinet-dostupy', 'instruction', false],
  ['qa-course', 'Начать корпоративный курс по оклейке', 'kurs-osnovy', 'instruction', true],
  ['qa-order', 'Как оформить заявку на материалы', 'zakaz-oplata', 'instruction', false],
  ['qa-receive', 'Что проверить при получении поставки', 'dostavka-priemka', 'checklist', false],
  ['qa-finance', 'Как внести выручку и проверить начисления', 'finansy-royalti', 'instruction', false],
  ['qa-shift', 'Открытие и закрытие смены в кабинете', 'smena', 'checklist', false],
  ['qa-support', 'Как задать вопрос менеджеру', 'kontakty-podderzhki', 'faq', false],
];
const stamp = '2026-11-08T12:00:00Z';
export const knowledgeArticles: Card[] = articleDefinitions.map(([id, title, slug, type, has_video], i) => ({
  id, title, section_id: sectionId(slug), type, has_video, summary: i === 5 ? 'Синтетическое описание с длинной строкой для проверки мобильного интерфейса и полного отображения важного содержания.' : 'Практические шаги и ответы на вопросы. Вымышленный материал для проверки интерфейса.',
  status: 'published', minutes: i % 4 + 2, views_30: i * 3, required_ack: false, has_draft: false, read: i === 4,
  published_at: stamp, updated_at: stamp,
}));
knowledgeSections.forEach(section => {
  const ids = [section.id, ...knowledgeSections.filter(s => s.parent_id === section.id).map(s => s.id)];
  section.count = knowledgeArticles.filter(a => ids.includes(a.section_id)).length;
});
const findArticle = (id: unknown) => knowledgeArticles.find(a => a.id === id) ?? knowledgeArticles[0];
const body = `## Когда пригодится\n\nЭто вымышленная статья для проверки интерфейса базы знаний. Она показывает, как выглядят инструкции с несколькими сценариями.\n\n## Что подготовить\n\n- Описание ситуации и вопрос.\n- Результат предыдущих действий.\n- Фотографии или документы, если они помогают понять проблему.\n\n## Порядок действий\n\n1. Найдите нужный раздел.\n2. Прочитайте инструкцию и сравните свою ситуацию с примером.\n3. Если ответа нет, задайте вопрос менеджеру.\n\n### Если ситуация отличается\n\nСохраните важные сведения и опишите, на каком шаге возникло затруднение.\n\n## Проверка результата\n\nПроверьте, что исходный вопрос решён. Просмотр этой статьи не означает аттестацию.\n\n## Связанные материалы\n\nВернитесь в раздел, чтобы открыть следующий материал.`;
const revisionOf = (a: Card) => ({ id: `${a.id}-revision`, article_id: a.id, rev_no: 1, title: a.title, summary: a.summary, body,
  status: 'published', author_id: null, published_at: stamp, change_note: null, revision: 1, updated_at: stamp });

export function knowledgeFixture(url: URL, args: Record<string, unknown>, params: URLSearchParams): Response | undefined {
  if (params.get('knowledge') !== '1') return;
  const name = url.pathname.split('/').pop();
  const editor = params.get('role') !== 'franchisee';
  if (url.pathname.includes('/rpc/')) {
    if (name === 'kb_home') return Response.json({ sections: knowledgeSections, recent: knowledgeArticles.slice(1, 5), popular: knowledgeArticles.slice(6, 9), continue: knowledgeArticles.slice(3, 5), drafts: editor ? 4 : null, total: knowledgeArticles.length });
    if (name === 'kb_section_page') {
      const section = knowledgeSections.find(s => s.id === args.p_section) ?? knowledgeSections[0];
      const children = knowledgeSections.filter(s => s.parent_id === section.id);
      return Response.json({ section, children, parent: knowledgeSections.find(s => s.id === section.parent_id) ?? null,
        articles: knowledgeArticles.filter(a => a.section_id === section.id || children.some(s => s.id === a.section_id)) });
    }
    if (name === 'kb_search') {
      const query = String(args.p_query ?? '').trim().toLowerCase();
      if (query === 'error') return Response.json({ message: 'external-unavailable', details: 'Тестовый сбой поиска. Повторите запрос.' }, { status: 503 });
      if (!query || query.includes('нет') || query === 'zzzz') return Response.json([]);
      const draft = { ...knowledgeArticles[1], id: 'qa-draft', title: 'Черновик инструкции по найму', status: 'draft' };
      const list = args.p_include_drafts && editor ? [...knowledgeArticles, draft] : knowledgeArticles;
      return Response.json(list.map((a, i) => ({ article_id: a.id, title: a.title, snippet: `Фрагмент статьи: «${query}». ${a.summary}`, type: a.type, section_title: knowledgeSections.find(s => s.id === a.section_id)?.title ?? '', status: a.status, published_at: stamp, rank: 100 - i })));
    }
    if (name === 'kb_article_open') {
      const a = findArticle(args.p_article), section = knowledgeSections.find(s => s.id === a.section_id)!;
      return Response.json({ section, parent: knowledgeSections.find(s => s.id === section.parent_id) ?? null, related: knowledgeArticles.filter(x => x.id !== a.id && x.section_id === a.section_id), my_rating: null,
        stats: editor ? { views_30: 12, helpful: 5, not_helpful: 1, comments: [] } : null });
    }
    if (name === 'kb_manage') return Response.json(knowledgeArticles.map(a => ({ ...a, section_title: knowledgeSections.find(s => s.id === a.section_id)?.title, parent_title: null, helpful: 4, not_helpful: 0, ack_done: null, ack_total: null })));
    if (name === 'kb_search_misses') return Response.json([{ query: 'как обучить новичка', times: 3, last_at: stamp }]);
    if (name === 'kb_inbox') return Response.json({ unanswered: editor ? 2 : 0, new_answers: editor ? 0 : 1 });
    if (name === 'kb_to_read' || name === 'kb_questions') return Response.json([]);
    if (name === 'kb_ask' || name === 'kb_ask_categorized') return Response.json('qa-question-created');
  } else {
    if (name === 'kb_section') return Response.json(knowledgeSections);
    if (name === 'article') {
      const id = url.searchParams.get('id')?.replace(/^eq\./, '');
      const a = findArticle(id);
      return Response.json([{ ...a, slug: a.id, published_revision_id: `${a.id}-revision`, published: { title: a.title, summary: a.summary, rev_no: 1, published_at: stamp }, revision: 1, tags: [] }]);
    }
    if (name === 'article_revision') {
      const id = url.searchParams.get('article_id')?.replace(/^eq\./, '') ?? url.searchParams.get('id')?.replace(/^eq\./, '').replace(/-revision$/, '');
      return Response.json([revisionOf(findArticle(id))]);
    }
    if (name === 'acknowledgement') return Response.json([]);
  }
}
