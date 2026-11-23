import { useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { ArrowUpRight, BookOpen, ClipboardCheck, Clock3, GraduationCap, Inbox, Store, Users, Wallet } from 'lucide-react';
import { ConfirmDialog } from '../ui';
import { useSession } from '../platform/session';
import { useOwnPartnerLifecycle } from '../modules/revenue/partnerLifecycle';
import { workspaceAccess, workspaceTitle, type WorkspaceRole } from './nav';
import './FirstRunGuide.css';

export type FirstRunRole = Exclude<WorkspaceRole, 'pending'>;

type Step = {
  title: string;
  text: string;
  icon: typeof Store;
  destination: { path: string; label: string };
  requires?: keyof ReturnType<typeof workspaceAccess>;
};

const shift: Step = { title: 'Закройте смену', text: 'На главной выберите точку и день. Нажмите «Закрыть смену» и внесите суммы наличными и картой.', icon: ClipboardCheck, destination: { path: '/', label: 'На главную' } };
const earnings: Step = { title: 'Сверьте заработок', text: 'На главной выберите месяц. Под суммой видны даты выплат и начисления за каждую половину месяца.', icon: Clock3, destination: { path: '/', label: 'На главную' } };
const lessons: Step = { title: 'Пройдите урок', text: 'Откройте назначенный урок и ответьте на вопросы. Здесь же видны задания на сегодня и программа стажировки, если она назначена.', icon: GraduationCap, destination: { path: '/learning', label: 'Открыть обучение' } };
const directory: Step = { title: 'Откройте команду', text: 'В разделе «Сотрудники» доступны выданные вам действия по команде.', icon: Users, destination: { path: '/staff', label: 'Открыть сотрудников' } };
const pastResults: Step = { title: 'Откройте историю точки', text: 'На главной можно выбрать отчётный месяц и посмотреть ранее внесённую выручку.', icon: Store, destination: { path: '/', label: 'На главную' } };
const pastFinances: Step = { title: 'Посмотрите историю финансов', text: 'В «Финансах» выберите месяц, чтобы сверить начисления и расходы или скачать отчёт.', icon: Wallet, destination: { path: '/finance', label: 'Открыть финансы' }, requires: 'finance' };
const availableSections: Step = { title: 'Откройте рабочие разделы', text: 'В меню показаны доступные разделы. Свою роль и область доступа можно посмотреть в профиле.', icon: BookOpen, destination: { path: '/', label: 'На главную' } };

const guides: Record<FirstRunRole, readonly Step[]> = {
  manager: [
    { title: 'Найдите нужную точку', text: 'На главной выберите франчайзи. Его карточка объединяет точки, настройки и доступ в кабинет.', icon: Store, destination: { path: '/', label: 'Открыть франчайзи' }, requires: 'network' },
    { title: 'Возьмите заявку в работу', text: 'Откройте обращение в «Заявках». Отмечайте этап переговоров по мере продвижения.', icon: Inbox, destination: { path: '/leads', label: 'Открыть заявки' }, requires: 'network' },
    { title: 'Сверьте расчёты сети', text: 'В «Экономике» выберите месяц и посмотрите показатели сети.', icon: Wallet, destination: { path: '/finance', label: 'Открыть экономику' }, requires: 'network' },
  ],
  franchisee: [
    { title: 'Начните с вашей точки', text: 'На главной внесите выручку. Если точка готовится к открытию, откройте список задач запуска.', icon: Store, destination: { path: '/', label: 'На главную' } },
    { title: 'Настройте работу команды', text: 'В «Сотрудниках» доступны выданные вам действия по команде и начислениям.', icon: Users, destination: { path: '/staff', label: 'Открыть сотрудников' }, requires: 'staffDirectory' },
    { title: 'Сверьте финансы', text: 'В «Финансах» выберите месяц, внесите расходы и скачайте отчёт.', icon: Wallet, destination: { path: '/finance', label: 'Открыть финансы' }, requires: 'finance' },
  ],
  team: [
    shift,
    { title: 'Проверьте выручку точек', text: 'На главной выберите месяц и точку, чтобы сверить выручку и увидеть дни, за которые ещё нет отчёта.', icon: Store, destination: { path: '/', label: 'На главную' } },
    lessons,
  ],
  staff: [shift, earnings, lessons],
  support: [
    { title: 'Ответьте на вопрос команды', text: 'На главной откройте вопрос. После ответа автор увидит его в базе знаний.', icon: Inbox, destination: { path: '/', label: 'Открыть вопросы' } },
    { title: 'Найдите инструкцию', text: 'В «Знаниях» можно искать статьи, регламенты и ответы на частые вопросы.', icon: BookOpen, destination: { path: '/kb', label: 'Открыть знания' } },
  ],
};

const guideKey = (userId: string, role: FirstRunRole) => `bron.first-run:${userId}:${role}`;

export function hasSeenFirstRunGuide(userId: string, role: FirstRunRole) {
  try { return localStorage.getItem(guideKey(userId, role)) === 'seen'; }
  catch { return false; }
}

export function markFirstRunGuideSeen(userId: string, role: FirstRunRole) {
  try { localStorage.setItem(guideKey(userId, role), 'seen'); }
  catch { /* The guide can still be dismissed for the current session. */ }
}

export function FirstRunGuide({ role, replay, onClose }: { role: FirstRunRole; replay: boolean; onClose: (navigating?: boolean) => void }) {
  const { can } = useSession();
  const { readOnly } = useOwnPartnerLifecycle();
  const { pathname } = useLocation();
  const [step, setStep] = useState(0);
  const body = useRef<HTMLDivElement>(null);
  const access = workspaceAccess(role, can);
  const worker = access.learning;
  const base = worker && (!can('shift.work') || readOnly) ? guides[role].filter(item => item !== shift)
    : role === 'franchisee' && (readOnly || !can('revenue.enter')) ? [pastResults, guides.franchisee[1], pastFinances] : guides[role];
  const available = base.filter(item => !item.requires || access[item.requires]);
  const steps = worker && access.staffDirectory ? [...available, directory] : available.length ? available : [availableSections];
  const index = Math.min(step, steps.length - 1);
  const active = steps[index];
  const last = index === steps.length - 1;

  useLayoutEffect(() => {
    const scroller = body.current?.closest('.dialog-body');
    if (scroller) scroller.scrollTop = 0;
  }, [index]);

  return (
    <ConfirmDialog open className="first-run-dialog" title="Первые шаги"
      cancelLabel={replay ? 'Закрыть' : 'Пропустить'} confirmLabel={last ? 'Готово' : 'Далее'}
      onBack={index > 0 ? () => setStep(index - 1) : undefined} onClose={() => onClose()}
      onConfirm={last ? () => onClose() : () => setStep(index + 1)}>
      <div className="guide-progress" aria-hidden="true">
        {steps.map((item, i) => <span key={item.title} data-current={i <= index} />)}
      </div>
      <div ref={body} className="first-run-guide" aria-live="polite" aria-atomic="true">
        <div className="guide-meta"><span>{workspaceTitle[role]}</span><span>Шаг {index + 1} из {steps.length}</span></div>
        <div className="guide-card">
          <span className="guide-icon"><active.icon size={25} aria-hidden /></span>
          <h3>{active.title}</h3>
          <p>{active.text}</p>
          <Link className="guide-link" to={active.destination.path} onClick={() => {
            onClose(true);
            if (active.destination.path === pathname) requestAnimationFrame(() => document.getElementById('main')?.focus({ preventScroll: true }));
          }}>
            {active.destination.label}<ArrowUpRight size={17} aria-hidden />
          </Link>
        </div>
      </div>
    </ConfirmDialog>
  );
}
