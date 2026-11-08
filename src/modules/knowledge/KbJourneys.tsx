import { useQuery } from '@tanstack/react-query';
import { ChevronRight, ClipboardList, LifeBuoy, Rocket, Users } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { DataState } from '../../ui';
import { sections, type SectionNode } from './api';

// Navigation labels only. The sources and operational rules live in protected articles.
const journeys = [
  { id: 'start', title: 'Открываю точку', icon: Rocket, description: 'От условий сотрудничества до первого рабочего дня.', steps: [
    { title: 'Договор и условия', detail: 'Обязанности сторон и территория', section: 'dogovor-territoriya' },
    { title: 'Подготовка к открытию', detail: 'Помещение, оснащение и план запуска', section: 'zapusk-podgotovka' },
    { title: 'Команда и обучение', detail: 'Найти людей и подготовить к работе', section: 'komanda' },
    { title: 'Материалы и первая закупка', detail: 'Заказ, доставка и приёмка', section: 'zakupki' },
    { title: 'Доступ в кабинет', detail: 'Вход и учётные записи', section: 'kabinet-dostupy' },
    { title: 'Первый рабочий день', detail: 'Открытие смены и контроль точки', section: 'upravlenie-tochkoy' },
  ] },
  { id: 'team', title: 'Нанимаю и обучаю', icon: Users, description: 'Каждый этап найма — отдельная задача и свой материал.', steps: [
    { title: 'Подготовить вакансию', detail: 'Фото и тексты вакансий добавим позже', pending: true },
    { title: 'Анкета кандидата', detail: 'Своя Google Форма и ответы у каждого партнёра', query: 'анкета кандидата' },
    { title: 'Провести собеседование', detail: 'Вопросы, оценка и следующий шаг', query: 'собеседование' },
    { title: 'Адаптировать сотрудника', detail: 'Обучение и проверка навыков', section: 'adaptatsiya' },
    { title: 'Проверить готовность к работе', detail: 'Навыки и допуск к самостоятельной смене', section: 'attestatsiya' },
    { title: 'Организовать работу команды', detail: 'График и оплата труда', section: 'grafik-oplata' },
  ] },
  { id: 'work', title: 'Управляю точкой', icon: ClipboardList, description: 'Ежедневная работа, деньги, клиенты и развитие.', steps: [
    { title: 'Открыть и закрыть смену', detail: 'Подготовка и порядок работы', section: 'smena' },
    { title: 'Помочь клиенту выбрать', detail: 'Консультация и продажи', section: 'prodazhi' },
    { title: 'Проверить качество', detail: 'Оклейка, материалы и оборудование', section: 'okleyka' },
    { title: 'Пополнить запас', detail: 'Заказ и получение материалов', section: 'zakupki' },
    { title: 'Разобраться в цифрах', detail: 'Выручка, расходы и роялти', section: 'finansy-royalti' },
    { title: 'Привлечь клиентов', detail: 'Продвижение и бренд-материалы', section: 'marketing-prodvizhenie' },
  ] },
  { id: 'help', title: 'Решаю проблему', icon: LifeBuoy, description: 'Найдите свою ситуацию. Если ответа ещё нет — задайте вопрос.', steps: [
    { title: 'Клиент недоволен', detail: 'Гарантия и работа с обращением', section: 'garantii' },
    { title: 'Проблема с поставкой', detail: 'Брак, недостача или возврат', section: 'brak-vozvrat' },
    { title: 'Не работает оборудование', detail: 'Плоттер, лекала и программы', section: 'oborudovanie' },
    { title: 'Не получается войти', detail: 'Пароль и доступ в приложение', section: 'kabinet-dostupy' },
    { title: 'Нештатная ситуация', detail: 'Помощь и порядок обращения', section: 'intsidenty' },
    { title: 'Меняю формат работы', detail: 'Изменения и завершение сотрудничества', section: 'izmeneniya-partnerstva' },
  ] },
] as const;

export function KbJourneys({ nodes, onAsk }: { nodes: SectionNode[]; onAsk: (question: string) => void }) {
  const [params, setParams] = useSearchParams();
  const selected = journeys.find(j => j.id === params.get('path')) ?? journeys[0];
  const secs = useQuery({ queryKey: ['kb', 'sections'], queryFn: sections, staleTime: 60_000 });
  return <section className="kb-journeys" aria-labelledby="kb-journeys-title">
    <div className="kb-section-label"><h2 id="kb-journeys-title">Что нужно сделать?</h2><span>Маршруты по задачам</span></div>
    <div className="kb-journey-tabs" role="group" aria-label="Рабочая задача">
      {journeys.map(j => <button key={j.id} type="button" aria-pressed={selected.id === j.id} onClick={() => {
        const next = new URLSearchParams(params); next.set('path', j.id); setParams(next, { replace: true });
      }}><j.icon size={20} aria-hidden /><span>{j.title}</span></button>)}
    </div>
    <div className="kb-journey-body">
      <p className="kb-journey-description">{selected.description}</p>
      <DataState query={secs} skeleton={3}>{(list) => <ol className="kb-journey-steps">
        {selected.steps.map((step, index) => {
          const section = 'section' in step ? list.find(s => s.slug === step.section) : undefined;
          const count = section ? nodes.find(s => s.id === section.id)?.count : undefined;
          const pending = 'pending' in step;
          const query = 'query' in step ? step.query : undefined;
          const content = <><span className="kb-step-number">{String(index + 1).padStart(2, '0')}</span><span className="kb-step-copy"><strong>{step.title}</strong><span>{step.detail}</span>{!pending && count === 0 && <small>Материал готовится · можно задать вопрос</small>}</span>{!pending && <ChevronRight size={16} aria-hidden />}</>;
          return <li key={step.title}>{pending ? <div className="kb-step kb-step-pending">{content}</div> : section && count !== 0 ? <Link className="kb-step" to={`/kb/s/${section.id}`}>{content}</Link> : query ? <Link className="kb-step" to={`/kb?q=${encodeURIComponent(query)}&path=${selected.id}`}>{content}</Link> : <button className="kb-step" type="button" onClick={() => onAsk(`${step.title}: `)}>{content}</button>}</li>;
        })}
      </ol>}</DataState>
    </div>
  </section>;
}
