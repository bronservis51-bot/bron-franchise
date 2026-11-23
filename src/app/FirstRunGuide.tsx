import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, type Location } from 'react-router';
import { ArrowLeft, ArrowRight, BookOpen, ClipboardCheck, Clock3, GraduationCap, Inbox, ShoppingCart, Store, User, Users, Wallet } from 'lucide-react';
import { Button } from '../ui';
import { useSession } from '../platform/session';
import { useOwnPartnerLifecycle } from '../modules/revenue/partnerLifecycle';
import { workspaceAccess, workspaceTitle, type WorkspaceRole } from './nav';
import './FirstRunGuide.css';

type FirstRunRole = Exclude<WorkspaceRole, 'pending'>;
export type FirstRunPreview = { firstRunPreview: true; firstRunOrigin: Location };

type Step = {
  id: string;
  title: string;
  text: string;
  icon: typeof Store;
  target: string;
  fallback?: string;
  fallbackText?: string;
  route?: string;
};

const knowledge: Step = {
  id: 'knowledge', title: 'Найдите инструкцию', text: 'В «Знаниях» можно найти инструкции по работе на точке и ответы на частые вопросы.',
  icon: BookOpen, target: 'nav-kb', route: '/kb',
};
const profile: Step = {
  id: 'profile', title: 'Откройте свой профиль', text: 'Здесь указаны ваша роль и область доступа. Из профиля можно снова открыть «Первые шаги».',
  icon: User, target: 'profile',
};
const shift: Step = {
  id: 'shift', title: 'Закройте смену', text: 'Кнопка открывает форму смены. В ней указывают точку, дату, наличные и оплату картой.',
  fallbackText: 'На главной появится кнопка «Закрыть смену», когда смену можно будет оформить.',
  icon: ClipboardCheck, target: 'shift-close', fallback: 'nav-home', route: '/',
};
const earnings: Step = {
  id: 'earnings', title: 'Сверьте заработок', text: 'Выберите месяц, чтобы увидеть начисления за каждую половину месяца и даты выплат.',
  icon: Clock3, target: 'payroll-history', fallback: 'nav-home', route: '/',
};
const lessons: Step = {
  id: 'lessons', title: 'Пройдите урок', text: 'Откройте текущий урок, изучите материал и ответьте на вопросы.',
  fallbackText: 'В «Обучении» появятся уроки и программа стажировки, когда их вам назначат.',
  icon: GraduationCap, target: 'first-lesson', fallback: 'nav-learning', route: '/learning',
};
const directory: Step = {
  id: 'directory', title: 'Найдите сотрудников', text: 'Здесь доступна работа с командой в пределах выданных вам прав.',
  icon: Users, target: 'nav-staff', route: '/staff',
};
const order: Step = {
  id: 'order', title: 'Закажите материалы', text: 'Кнопка в шапке ведёт в раздел заказа и предзаказа материалов.',
  icon: ShoppingCart, target: 'order',
};

function guideSteps(role: FirstRunRole, can: (permission: string) => boolean, readOnly: boolean): Step[] {
  const access = workspaceAccess(role, can);
  const steps: Step[] = [];
  if (role === 'manager') {
    if (access.network) {
      steps.push(
        { id: 'network', title: 'Найдите франчайзи', text: 'На главной найдите франчайзи. В его карточке можно открыть нужную точку и проверить доступ в кабинет.', icon: Store, target: 'nav-home', route: '/' },
        { id: 'leads', title: 'Откройте заявки', text: 'Здесь появляются обращения с сайта. Меняйте этап заявки по мере переговоров.', icon: Inbox, target: 'nav-leads', route: '/leads' },
      );
    }
    if (access.finance) steps.push({
      id: 'finance', title: access.network ? 'Сверьте экономику сети' : 'Сверьте роялти',
      text: access.network ? 'Выберите месяц, чтобы сверить поставки и расходы сети.' : 'Выберите период, чтобы сверить начисления и оплаты.',
      icon: Wallet, target: 'nav-finance', route: '/finance',
    });
  }
  if (role === 'franchisee' && can('revenue.read')) {
    const mayEnterRevenue = !readOnly && can('revenue.enter');
    steps.push({
      id: 'revenue', title: mayEnterRevenue ? 'Найдите ввод выручки' : 'Откройте историю точки',
      text: mayEnterRevenue ? 'Кнопка открывает форму выручки за сегодня. В календаре можно открыть другой день.'
        : 'На главной выберите точку и месяц, чтобы сверить выручку. При подготовке к открытию здесь будет список задач.',
      fallbackText: 'На главной выберите точку и месяц. Если точка готовится к открытию, здесь появится список задач.',
      icon: Store, target: mayEnterRevenue ? 'revenue-entry' : 'nav-home', fallback: 'nav-home', route: '/',
    });
    if (access.finance) steps.push({
      id: 'finance', title: 'Сверьте финансы', text: 'Выберите месяц, чтобы посмотреть начисления и расходы или скачать отчёт.',
      icon: Wallet, target: 'nav-finance', route: '/finance',
    });
  }
  if (access.learning) {
    if (can('shift.work') && !readOnly) steps.push(shift);
    if (role === 'staff' || can('shift.work')) steps.push(earnings);
    else steps.push({
      id: 'team-revenue', title: 'Проверьте выручку точек', text: 'На главной выберите месяц, чтобы сверить выручку назначенных точек.',
      icon: Store, target: 'nav-home', route: '/',
    });
    steps.push(lessons);
  }
  if (role === 'support' && can('kb.edit')) steps.push({
    id: 'questions', title: 'Откройте вопросы команды', text: 'Вопросы, переданные в техническую поддержку, появляются на главной.',
    icon: Inbox, target: 'nav-home', route: '/',
  });
  if (access.staffDirectory) steps.push(directory);
  if (access.order && !readOnly) steps.push(order);
  if (can('kb.read') || can('kb.edit')) steps.push(knowledge);
  steps.push(profile);
  return steps;
}

const guideKey = (userId: string, role: FirstRunRole) => 'bron.first-run-v2:' + userId + ':' + role;

export function hasSeenFirstRunGuide(userId: string, role: FirstRunRole) {
  try { return localStorage.getItem(guideKey(userId, role)) === 'seen'; }
  catch { return false; }
}

export function markFirstRunGuideSeen(userId: string, role: FirstRunRole) {
  try { localStorage.setItem(guideKey(userId, role), 'seen'); }
  catch { /* The guide can still be dismissed for the current session. */ }
}

type Rect = { left: number; top: number; width: number; height: number };
type FocusedRect = Rect & { name: string };
type Placement = { viewport: Rect; panel: CSSProperties; target?: FocusedRect; arrow?: CSSProperties };
type Side = 'right' | 'left' | 'above' | 'below';

const inset = 12;
const gap = 23;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

function locateTarget(step: Step, viewport: Rect, scrolled: Set<Element>): FocusedRect | undefined {
  const header = document.querySelector('.topbar')?.getBoundingClientRect();
  const navigation = document.querySelector('.bottom-nav')?.getBoundingClientRect();
  for (const name of [step.target, step.fallback]) {
    if (!name) continue;
    for (const element of document.querySelectorAll<HTMLElement>('[data-tour-target="' + name + '"]')) {
      if (element.matches(':disabled, [aria-disabled=true]') || getComputedStyle(element).visibility === 'hidden') continue;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      const content = element.closest('.content')?.getBoundingClientRect();
      const left = Math.max(rect.left, viewport.left, content?.left ?? -Infinity);
      const top = Math.max(rect.top, viewport.top, content?.top ?? -Infinity, content && header?.height ? header.bottom : -Infinity);
      const right = Math.min(rect.right, viewport.left + viewport.width, content?.right ?? Infinity);
      const bottom = Math.min(rect.bottom, viewport.top + viewport.height, content?.bottom ?? Infinity, content && navigation?.height ? navigation.top : Infinity);
      if (right - left < rect.width / 2 || bottom - top < rect.height / 2) {
        if (content && !scrolled.has(element)) {
          scrolled.add(element);
          element.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
        }
        continue;
      }
      const x = Math.max(0, left - viewport.left - 4);
      const y = Math.max(0, top - viewport.top - 4);
      return { name, left: x, top: y, width: Math.min(viewport.width, right - viewport.left + 4) - x,
        height: Math.min(viewport.height, bottom - viewport.top + 4) - y };
    }
  }
}

function placeCard(viewport: Rect, target: FocusedRect | undefined, contentHeight: number): Placement {
  const width = Math.min(386, viewport.width - inset * 2);
  const height = Math.min(viewport.height - inset * 2, contentHeight);
  if (!target) return { viewport, panel: { left: (viewport.width - width) / 2, top: (viewport.height - height) / 2, width, maxHeight: height } };

  const right = target.left + target.width;
  const bottom = target.top + target.height;
  const middleX = target.left + target.width / 2;
  const middleY = target.top + target.height / 2;
  const roomAbove = target.top - inset - gap;
  const roomBelow = viewport.height - bottom - inset - gap;
  const side: Side = viewport.width - right >= width + gap + inset ? 'right'
    : target.left >= width + gap + inset ? 'left' : roomBelow >= height || roomBelow >= roomAbove ? 'below' : 'above';
  const horizontal = side === 'left' || side === 'right';

  const maxHeight = horizontal ? height : clamp(side === 'above' ? roomAbove : roomBelow, 70, height);
  const left = horizontal ? (side === 'right' ? right + gap : target.left - width - gap)
    : clamp(middleX - width / 2, inset, viewport.width - width - inset);
  const top = horizontal ? clamp(middleY - maxHeight / 2, inset, viewport.height - maxHeight - inset)
    : clamp(side === 'above' ? target.top - maxHeight - gap : bottom + gap, inset, viewport.height - maxHeight - inset);
  const fromX = horizontal ? (side === 'right' ? left : left + width) : clamp(middleX, left + 22, left + width - 22);
  const fromY = horizontal ? clamp(middleY, top + 14, top + maxHeight - 14) : side === 'above' ? top + maxHeight : top;
  const toX = horizontal ? (side === 'right' ? right + 5 : target.left - 5) : middleX;
  const toY = horizontal ? middleY : side === 'above' ? target.top - 5 : bottom + 5;
  const distance = Math.hypot(toX - fromX, toY - fromY);
  const arrow = distance > 8 ? { left: fromX, top: fromY, width: distance, rotate: Math.atan2(toY - fromY, toX - fromX) + 'rad' } : undefined;
  return { viewport, target, arrow, panel: { left, top, width, maxHeight } };
}

export function FirstRunGuide({ role, replay, onClose }: { role: FirstRunRole; replay: boolean; onClose: (navigating?: boolean) => void }) {
  const { can } = useSession();
  const { readOnly } = useOwnPartnerLifecycle();
  const location = useLocation();
  const navigate = useNavigate();
  const preview = location.state as FirstRunPreview | null;
  const origin = useRef(preview?.firstRunOrigin ?? location);
  const [stepId, setStepId] = useState<string>();
  const [placement, setPlacement] = useState<Placement>();
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const progressId = useId();
  const textId = useId();
  const steps = guideSteps(role, can, readOnly);
  const index = Math.max(0, steps.findIndex(step => step.id === stepId));
  const active = steps[index];
  const last = index === steps.length - 1;
  const startPath = origin.current.pathname;
  const onEditor = startPath.endsWith('/edit') || startPath === '/learning/manage';

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useLayoutEffect(() => {
    if (panel.current) panel.current.scrollTop = 0;
    heading.current?.focus({ preventScroll: true });
  }, [active.id]);

  useLayoutEffect(() => {
    const card = panel.current;
    const app = document.getElementById('root');
    if (!card) return;
    const view = window.visualViewport;
    const scrolled = new Set<Element>();
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const measure = () => {
      const viewport = {
        left: view?.offsetLeft ?? 0, top: view?.offsetTop ?? 0,
        width: view?.width ?? window.innerWidth, height: view?.height ?? window.innerHeight,
      };
      const target = locateTarget(active, viewport, scrolled);
      const next = placeCard(viewport, target, card.scrollHeight + 2);
      setPlacement(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    measure();
    const resize = new ResizeObserver(schedule);
    resize.observe(card);
    if (app) resize.observe(app);
    const mutation = new MutationObserver(schedule);
    if (app) mutation.observe(app, {
      childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'disabled', 'hidden', 'aria-disabled'],
    });
    view?.addEventListener('resize', schedule);
    view?.addEventListener('scroll', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      view?.removeEventListener('resize', schedule);
      view?.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [active.target, active.fallback, location.pathname]);

  const isPreview = preview?.firstRunPreview === true;
  useEffect(() => {
    if (!isPreview && location.key !== origin.current.key) onClose(true);
  }, [isPreview, location.key, onClose]);

  function finish() {
    if (!dialog.current?.open) return;
    dialog.current.close();
    onClose(isPreview && origin.current.pathname !== location.pathname);
    if (!replay) requestAnimationFrame(() => document.getElementById('main')?.focus({ preventScroll: true }));
  }

  function go(next: Step) {
    setStepId(next.id);
    if (!onEditor && next.route && next.route !== location.pathname) {
      const state: FirstRunPreview = { firstRunPreview: true, firstRunOrigin: origin.current };
      void navigate(next.route, { replace: true, state });
    }
  }

  function keyboard(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key === 'Escape') {
      event.preventDefault();
      finish();
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key === 'ArrowLeft' && index > 0) {
      event.preventDefault();
      go(steps[index - 1]);
    }
    if (event.key === 'ArrowRight' && !last) {
      event.preventDefault();
      go(steps[index + 1]);
    }
  }

  const target = placement?.target;
  return createPortal(
    <dialog className="first-run-dialog" ref={dialog} style={placement?.viewport}
      data-targeted={Boolean(target)} aria-labelledby={titleId} aria-describedby={progressId + ' ' + textId}
      onCancel={event => { event.preventDefault(); finish(); }} onKeyDown={keyboard}>
      {target && <div className="guide-spotlight" data-target={target.name} aria-hidden
        style={{ left: target.left, top: target.top, width: target.width, height: target.height }} />}
      {placement?.arrow && <span className="guide-arrow" style={placement.arrow} aria-hidden />}
      <div ref={panel} className="guide-card" style={placement?.panel}>
        <div className="guide-meta"><span>{workspaceTitle[role]}</span><span id={progressId}>Шаг {index + 1} из {steps.length}</span></div>
        <div className="guide-progress" aria-hidden>
          {steps.map((step, i) => <span key={step.id} data-current={i <= index} />)}
        </div>
        <div className="guide-content">
          <span className="guide-icon"><active.icon size={23} aria-hidden /></span>
          <h2 id={titleId} ref={heading} tabIndex={-1}>{active.title}</h2>
          <p id={textId}>{target?.name === active.target ? active.text : active.fallbackText ?? active.text}</p>
        </div>
        <div className="guide-actions">
          <Button variant="ghost" onClick={finish}>{replay ? 'Закрыть' : 'Пропустить'}</Button>
          {index > 0 && <Button variant="ghost" aria-label="Назад" onClick={() => go(steps[index - 1])}><ArrowLeft size={16} aria-hidden />Назад</Button>}
          <Button variant="primary" onClick={last ? finish : () => go(steps[index + 1])}>
            {last ? 'Готово' : 'Далее'}{!last && <ArrowRight size={16} aria-hidden />}
          </Button>
        </div>
      </div>
    </dialog>, document.body,
  );
}
