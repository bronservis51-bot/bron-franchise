import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate, type Location } from 'react-router';
import { ArrowLeft, ArrowRight, BookOpen, ClipboardCheck, Clock3, GraduationCap, Inbox, ShoppingCart, Store, User, Users, Wallet } from 'lucide-react';
import { Button } from '../ui';
import { useLocale } from '../platform/locale';
import { useSession } from '../platform/session';
import { useOwnPartnerLifecycle } from '../modules/revenue/partnerLifecycle';
import { workspaceAccess, workspaceTitleFor, type WorkspaceRole } from './nav';
import './FirstRunGuide.css';

type FirstRunRole = Exclude<WorkspaceRole, 'pending'>;
export type FirstRunPreview = { firstRunPreview: true; firstRunOrigin: Location };

type GuideCopy = [russian: string, turkish: string];

type Step = {
  id: string;
  title: GuideCopy;
  text: GuideCopy;
  icon: typeof Store;
  target: string;
  fallback?: string;
  fallbackText?: GuideCopy;
  route?: string;
};

const knowledge: Step = {
  id: 'knowledge', title: ['Найдите инструкцию', 'Kılavuzu bulun'], text: ['Введите вопрос или тему в поиск.', 'Arama kutusuna bir soru veya konu yazın.'],
  icon: BookOpen, target: 'nav-kb', route: '/kb',
};
const profile: Step = {
  id: 'profile', title: ['Откройте профиль', 'Profili açın'], text: ['Здесь можно сменить пароль.', 'Buradan parolanızı değiştirebilirsiniz.'],
  icon: User, target: 'profile',
};
const shift: Step = {
  id: 'shift', title: ['Закройте смену', 'Vardiyayı kapatın'], text: ['Укажите выручку наличными и картой.', 'Nakit ve kart cirosunu girin.'],
  fallbackText: ['Кнопка появится на главной, когда смену можно закрыть.', 'Vardiyayı kapatabileceğiniz zaman düğme ana sayfada görünür.'],
  icon: ClipboardCheck, target: 'shift-close', fallback: 'nav-home', route: '/',
};
const earnings: Step = {
  id: 'earnings', title: ['Посмотрите начисления', 'Kazancınızı görün'], text: ['Выберите месяц и проверьте заработок.', 'Bir ay seçip kazancınızı kontrol edin.'],
  icon: Clock3, target: 'payroll-history', fallback: 'nav-home', route: '/',
};
const lessons: Step = {
  id: 'lessons', title: ['Пройдите урок', 'Dersi tamamlayın'], text: ['Откройте назначенный урок.', 'Size atanan dersi açın.'],
  fallbackText: ['Назначенные уроки находятся в разделе «Обучение».', 'Atanan dersleri “Eğitim” bölümünde bulabilirsiniz.'],
  icon: GraduationCap, target: 'first-lesson', fallback: 'nav-learning', route: '/learning',
};
const directory: Step = {
  id: 'directory', title: ['Откройте сотрудников', 'Çalışanlar bölümünü açın'], text: ['Найдите сотрудника по имени.', 'Çalışanı adıyla arayın.'],
  icon: Users, target: 'nav-staff', route: '/staff',
};
const order: Step = {
  id: 'order', title: ['Закажите материалы', 'Malzeme sipariş edin'], text: ['Здесь можно открыть заказ или предзаказ.', 'Buradan sipariş verebilir veya ön sipariş talebi oluşturabilirsiniz.'],
  icon: ShoppingCart, target: 'order', route: '/order',
};

function guideSteps(role: FirstRunRole, can: (permission: string) => boolean, readOnly: boolean): Step[] {
  const access = workspaceAccess(role, can);
  const steps: Step[] = [];
  if (role === 'manager') {
    if (access.network) steps.push(
      { id: 'network', title: ['Найдите франчайзи', 'Franchise işletmecisini bulun'], text: ['Откройте его карточку из списка.', 'Listeden işletmecinin kartını açın.'], icon: Store, target: 'nav-home', route: '/' },
      { id: 'leads', title: ['Откройте заявки', 'Başvuruları açın'], text: ['Здесь появляются обращения с сайта.', 'Siteden gelen başvurular burada görünür.'], icon: Inbox, target: 'nav-leads', route: '/leads' },
    );
    if (access.finance) steps.push({
      id: 'finance', title: access.network ? ['Откройте экономику', 'Finans bölümünü açın'] : ['Откройте роялти', 'Royalti bölümünü açın'],
      text: access.network ? ['Выберите месяц для просмотра сводки.', 'Özeti görmek için bir ay seçin.'] : ['Выберите период для сверки оплат.', 'Ödemeleri kontrol etmek için dönem seçin.'],
      icon: Wallet, target: 'nav-finance', route: '/finance',
    });
  } else if (role === 'franchisee') {
    if (can('revenue.read')) {
      const mayEnterRevenue = !readOnly && can('revenue.enter');
      steps.push({
        id: 'revenue', title: mayEnterRevenue ? ['Найдите ввод выручки', 'Ciro girişini bulun'] : ['Посмотрите историю выручки', 'Ciro geçmişini açın'],
        text: mayEnterRevenue ? ['Откройте форму выручки за сегодня.', 'Bugünkü ciro giriş formunu açın.'] : ['Выберите точку и месяц.', 'Mağaza ve ay seçin.'],
        fallbackText: ['На главной можно выбрать точку и день.', 'Ana sayfadan mağaza ve gün seçebilirsiniz.'],
        icon: Store, target: mayEnterRevenue ? 'revenue-entry' : 'nav-home', fallback: 'nav-home', route: '/',
      });
    }
    if (access.finance) steps.push({
      id: 'finance', title: ['Проверьте финансы', 'Finans raporunu kontrol edin'], text: ['Выберите месяц для просмотра отчёта.', 'Raporu görmek için bir ay seçin.'],
      icon: Wallet, target: 'nav-finance', route: '/finance',
    });
    if (access.staffDirectory) steps.push(directory);
    else if (access.order && !readOnly) steps.push(order);
  } else if (access.learning) {
    if (can('shift.work') && !readOnly) steps.push(shift);
    else if (role === 'staff' || can('shift.work')) steps.push(earnings);
    else steps.push({
      id: 'team-revenue', title: ['Проверьте выручку точек', 'Mağaza cirolarını kontrol edin'], text: ['Выберите месяц на главной.', 'Ana sayfadan ay seçin.'],
      icon: Store, target: 'nav-home', route: '/',
    });
    steps.push(lessons);
    if (access.staffDirectory) steps.push(directory);
  } else if (role === 'support') {
    if (can('kb.edit')) steps.push({
      id: 'questions', title: ['Откройте вопросы', 'Soruları açın'], text: ['На главной видны вопросы для поддержки.', 'Destek soruları ana sayfada görünür.'],
      icon: Inbox, target: 'nav-home', route: '/',
    });
    if (can('kb.read') || can('kb.edit')) steps.push(knowledge);
  }
  return steps.length ? steps : [can('kb.read') ? knowledge : profile];
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
type Placement = { viewport: Rect; target?: FocusedRect };

function locateTarget(step: Step, viewport: Rect, card: DOMRect, needsRoute: boolean): FocusedRect | undefined {
  const header = document.querySelector('.topbar')?.getBoundingClientRect();
  const navigation = document.querySelector('.bottom-nav')?.getBoundingClientRect();
  for (const name of [step.target, step.fallback]) {
    if (!name) continue;
    for (const element of document.querySelectorAll<HTMLElement>('[data-tour-target="' + name + '"]')) {
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height || element.matches(':disabled, [aria-disabled=true]') || getComputedStyle(element).visibility !== 'visible') continue;
      const content = element.closest('.content')?.getBoundingClientRect();
      if (content && needsRoute) continue;
      const nav = element.closest('.bottom-nav, .sidebar')?.getBoundingClientRect();
      const left = Math.max(rect.left, viewport.left, content?.left ?? -Infinity, nav?.left ?? -Infinity);
      const top = Math.max(rect.top, viewport.top, content?.top ?? -Infinity, content && header?.height ? header.bottom : -Infinity);
      const right = Math.min(rect.right, viewport.left + viewport.width, content?.right ?? Infinity, nav?.right ?? Infinity);
      const bottom = Math.min(rect.bottom, viewport.top + viewport.height, content?.bottom ?? Infinity, content && navigation?.height ? navigation.top : Infinity);
      if (right - left < rect.width / 2 || bottom - top < rect.height / 2) continue;
      if (right > card.left && left < card.right && bottom > card.top && top < card.bottom) continue;
      const x = Math.max(0, left - viewport.left - 4);
      const y = Math.max(0, top - viewport.top - 4);
      return { name, left: x, top: y, width: Math.min(viewport.width, right - viewport.left + 4) - x,
        height: Math.min(viewport.height, bottom - viewport.top + 4) - y };
    }
  }
}

type FirstRunGuideProps = { role: FirstRunRole; replay: boolean; onClose: (navigating?: boolean) => void };

export function FirstRunGuide(props: FirstRunGuideProps) {
  const { query, readOnly } = useOwnPartnerLifecycle();
  return query.isLoading ? null : <Guide {...props} readOnly={readOnly} />;
}

function Guide({ role, replay, onClose, readOnly }: FirstRunGuideProps & { readOnly: boolean }) {
  const { t, language } = useLocale();
  const { can } = useSession();
  const location = useLocation();
  const navigate = useNavigate();
  const preview = location.state as FirstRunPreview | null;
  const origin = useRef(preview?.firstRunOrigin ?? location);
  const returning = useRef(false);
  const [stepId, setStepId] = useState<string>();
  const [placement, setPlacement] = useState<Placement>();
  const dialog = useRef<HTMLDialogElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
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
  const needsRoute = Boolean(active.route && location.pathname !== active.route);

  useLayoutEffect(() => {
    const element = dialog.current;
    element?.showModal();
    return () => element?.close();
  }, []);

  useLayoutEffect(() => {
    if (panel.current) panel.current.scrollTop = 0;
    if (content.current) content.current.scrollTop = 0;
    heading.current?.focus({ preventScroll: true });
  }, [active.id, location.pathname]);

  useLayoutEffect(() => {
    const card = panel.current;
    const app = document.getElementById('root');
    if (!card) return;
    const view = window.visualViewport;
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
      const target = locateTarget(active, viewport, card.getBoundingClientRect(), needsRoute);
      const next = { viewport, target };
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
  }, [active.target, active.fallback, needsRoute, location.pathname]);

  const isPreview = preview?.firstRunPreview === true;
  useEffect(() => {
    if (isPreview) return;
    if (returning.current) {
      dialog.current?.close();
      onClose(true);
      requestAnimationFrame(() => document.getElementById('main')?.focus({ preventScroll: true }));
    } else if (location.key !== origin.current.key) onClose(true);
  }, [isPreview, location.key, onClose]);

  function finish() {
    if (!dialog.current?.open || returning.current) return;
    if (isPreview) {
      const { pathname, search, hash, state } = origin.current;
      returning.current = true;
      void navigate({ pathname, search, hash }, { replace: true, state });
      return;
    }
    dialog.current.close();
    onClose();
    if (!replay) requestAnimationFrame(() => document.getElementById('main')?.focus({ preventScroll: true }));
  }

  function go(next: Step) {
    if (returning.current) return;
    setStepId(next.id);
  }

  function previewRoute(path?: string) {
    if (!returning.current && !onEditor && path && path !== location.pathname) {
      const state: FirstRunPreview = { firstRunPreview: true, firstRunOrigin: origin.current };
      void navigate(path, { replace: true, state });
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
  const targetStyle = target && { left: target.left, top: target.top, width: target.width, height: target.height };
  const canOpenRoute = !onEditor && needsRoute;
  const canOpenTarget = canOpenRoute && target && (target.name.startsWith('nav-') || target.name === 'order');
  return createPortal(
    <dialog className="first-run-dialog" ref={dialog} style={placement?.viewport}
      data-targeted={Boolean(target)} data-short={Boolean(placement && placement.viewport.height <= 460)}
      aria-labelledby={titleId} aria-describedby={progressId + ' ' + textId}
      onCancel={event => { event.preventDefault(); finish(); }} onKeyDown={keyboard}>
      {target && (canOpenTarget ? <button type="button" className="guide-spotlight guide-spotlight-action"
        data-target={target.name} style={targetStyle} aria-label={t(...active.title)} onClick={() => previewRoute(active.route)}
        /> : <div className="guide-spotlight" data-target={target.name} style={targetStyle} aria-hidden />)}
      <div ref={panel} className="guide-card">
        <div className="guide-meta"><span>{workspaceTitleFor(role, language)}</span><span id={progressId}>{t(`Шаг ${index + 1} из ${steps.length}`, `Adım ${index + 1}/${steps.length}`)}</span></div>
        <div className="guide-progress" aria-hidden>
          {steps.map((step, i) => <span key={step.id} data-current={i <= index} />)}
        </div>
        <div ref={content} className="guide-body">
          <div className="guide-content">
            <span className="guide-icon"><active.icon size={23} aria-hidden /></span>
            <h2 id={titleId} ref={heading} tabIndex={-1}>{t(...active.title)}</h2>
            <p id={textId}>{t(...(target?.name === active.target ? active.text : active.fallbackText ?? active.text))}</p>
          </div>
          {canOpenRoute && !canOpenTarget && <Button variant="secondary" size="sm" onClick={() => previewRoute(active.route)}>
            {t('Открыть раздел', 'Bölümü aç')}
          </Button>}
        </div>
        <div className="guide-actions">
          <Button variant="ghost" onClick={finish}>{replay ? t('Закрыть', 'Kapat') : t('Пропустить', 'Atla')}</Button>
          {index > 0 && <Button variant="ghost" aria-label={t('Назад', 'Geri')} onClick={() => go(steps[index - 1])}><ArrowLeft size={16} aria-hidden />{t('Назад', 'Geri')}</Button>}
          <Button variant="primary" onClick={last ? finish : () => go(steps[index + 1])}>
            {last ? t('Готово', 'Bitti') : t('Далее', 'İleri')}{!last && <ArrowRight size={16} aria-hidden />}
          </Button>
        </div>
      </div>
    </dialog>, document.body,
  );
}
