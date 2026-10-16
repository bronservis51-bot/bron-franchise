// Навигация по разрешённым модулям (UX-03): сервер всё равно проверяет доступ, меню лишь не показывает недоступное.
// Приложение франчайзи: две функции — база знаний и отчётность (продажи, выручка, заработок сотрудника, роялти).
import { ShoppingBag, TrendingUp, BookOpen, ClipboardList, GraduationCap, Home, Landmark, Settings, ShieldAlert, Store, Wallet } from 'lucide-react';
import type { ComponentType } from 'react';

export interface NavItem {
  to: string;
  label: string;
  /** Короткая подпись для нижней панели телефона (одна строка). */
  short?: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  group: 'work' | 'knowledge' | 'reports' | 'control';
  visible: (can: (p: string) => boolean, isStaff: boolean) => boolean;
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Сегодня', icon: Home, group: 'work', visible: () => true },
  // Задачи приходят из базы знаний (пересмотр статьи, замечание) и отчётности («Сдать отчёт о выручке»)
  { to: '/tasks', label: 'Мои задачи', short: 'Задачи', icon: ClipboardList, group: 'work', visible: (can) => can('task.work') },
  { to: '/kb', label: 'База знаний', short: 'Знания', icon: BookOpen, group: 'knowledge', visible: (can) => can('kb.read') },
  { to: '/learning', label: 'Обучение', icon: GraduationCap, group: 'knowledge', visible: (can) => can('kb.read') && !can('metrics.read') },
  { to: '/pos', label: 'Продажи', icon: ShoppingBag, group: 'reports', visible: (can) => can('pos.sell') },
  { to: '/sales', label: 'Выручка', icon: Wallet, group: 'reports', // компания смотрит выручку через «Контроль выручки»
    visible: (can, isStaff) => can('sales.enter') || (!isStaff && can('sales.manage')) },
  { to: '/royalties', label: 'Отчёты и роялти', short: 'Роялти', icon: Landmark, group: 'reports', visible: (can) => can('royalty.read') },
  { to: '/network-sales', label: 'Выручка сети', short: 'Выручка', icon: TrendingUp, group: 'reports', visible: (can, isStaff) => isStaff && can('sales.read') },
  { to: '/control', label: 'Контроль выручки', short: 'Контроль', icon: ShieldAlert, group: 'reports', visible: (can, isStaff) => isStaff && can('sales.read') },
  { to: '/partners', label: 'Франчайзи и точки', short: 'Точки', icon: Store, group: 'reports', visible: (can) => can('org.read') },
  { to: '/settings', label: 'Настройки', icon: Settings, group: 'control',
    visible: (can) => can('integration.operate') || can('access.manage') || can('audit.read') },
];

export const GROUP_ORDER: NavItem['group'][] = ['work', 'knowledge', 'reports', 'control'];

export const GROUP_TITLE: Record<NavItem['group'], string> = {
  work: 'Работа', knowledge: 'База знаний', reports: 'Отчётность', control: 'Управление',
};

/** 4 основных пункта мобильной навигации по роли (UX-03), остальное — в «Ещё». */
export function primaryMobile(items: NavItem[], can: (p: string) => boolean): NavItem[] {
  const by = (to: string) => items.find((i) => i.to === to);
  const order = can('access.manage') && can('metrics.read')
    ? ['/', '/network-sales', '/control', '/kb']
    : can('royalty.publish')
    ? ['/', '/royalties', '/control', '/kb']
    : can('royalty.report.submit')
      ? ['/', '/sales', '/royalties', '/kb']
      : can('sales.enter')
        ? ['/', '/pos', '/sales', '/kb']
        : ['/', '/kb', '/learning', '/tasks'];
  const picked = order.map(by).filter((x): x is NavItem => Boolean(x));
  for (const i of items) if (picked.length < 4 && !picked.includes(i)) picked.push(i);
  return picked.slice(0, 4);
}
