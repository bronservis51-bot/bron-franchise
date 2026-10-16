// Навигация по разрешённым модулям (UX-03): сервер всё равно проверяет доступ, меню лишь не показывает недоступное.
import { Contact, Map as MapIcon, ShoppingBag, TrendingUp, BookOpen, ClipboardList, GraduationCap, Headset, Home, Landmark, Package, Settings, ShieldAlert, ShoppingCart, Store, Rocket, Truck, Wallet } from 'lucide-react';
import type { ComponentType } from 'react';

export interface NavItem {
  to: string;
  label: string;
  /** Короткая подпись для нижней панели телефона (одна строка). */
  short?: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  group: 'work' | 'franchise' | 'knowledge' | 'control';
  visible: (can: (p: string) => boolean, isStaff: boolean) => boolean;
}

export const NAV: NavItem[] = [
  { to: '/', label: 'Сегодня', icon: Home, group: 'work', visible: () => true },
  { to: '/tasks', label: 'Моя работа', short: 'Задачи', icon: ClipboardList, group: 'work', visible: (can) => can('task.work') },
  { to: '/support', label: 'Поддержка', icon: Headset, group: 'work', visible: (can) => can('ticket.read') || can('ticket.create') },
  { to: '/pos', label: 'Продажи', icon: ShoppingBag, group: 'work', visible: (can) => can('pos.sell') },
  { to: '/sales', label: 'Выручка', icon: Wallet, group: 'work', // компания смотрит выручку через «Контроль выручки»
    visible: (can, isStaff) => can('sales.enter') || (!isStaff && can('sales.manage')) },
  { to: '/catalog', label: 'Магазин', icon: ShoppingCart, group: 'work', visible: (can) => can('order.create') && can('catalog.read') },
  { to: '/supply', label: 'Поступления', short: 'Приход', icon: Truck, group: 'work', visible: (can) => can('catalog.manage') },
  { to: '/orders', label: 'Заказы', icon: Package, group: 'work', visible: (can) => can('order.read') || can('order.create') },
  { to: '/crm', label: 'Лиды франшизы', short: 'Лиды', icon: Contact, group: 'franchise', visible: (can) => can('crm.read') },
  { to: '/partners', label: 'Партнёры и точки', short: 'Партнёры', icon: Store, group: 'franchise', visible: (can) => can('org.read') },
  { to: '/openings', label: 'Открытия', icon: Rocket, group: 'franchise', visible: (can) => can('opening.read') },
  { to: '/network-sales', label: 'Выручка сети', short: 'Выручка', icon: TrendingUp, group: 'franchise', visible: (can, isStaff) => isStaff && can('sales.read') },
  { to: '/control', label: 'Контроль выручки', short: 'Контроль', icon: ShieldAlert, group: 'franchise', visible: (can, isStaff) => isStaff && can('sales.read') },
  { to: '/royalties', label: 'Роялти', icon: Landmark, group: 'franchise', visible: (can) => can('royalty.read') },
  { to: '/kb', label: 'База знаний', short: 'Знания', icon: BookOpen, group: 'knowledge', visible: (can) => can('kb.read') },
  { to: '/learning', label: 'Обучение', icon: GraduationCap, group: 'knowledge', visible: (can) => can('kb.read') && !can('metrics.read') },
  { to: '/map', label: 'Карта сети', short: 'Карта', icon: MapIcon, group: 'control', visible: (can, isStaff) => isStaff && can('metrics.read') },
  { to: '/settings', label: 'Настройки', icon: Settings, group: 'control',
    visible: (can) => can('integration.operate') || can('access.manage') || can('audit.read') },
];

export const GROUP_TITLE: Record<NavItem['group'], string> = {
  work: 'Работа', franchise: 'Франшиза', knowledge: 'Знания', control: 'Управление',
};

/** 4 основных пункта мобильной навигации по роли (UX-03), остальное — в «Ещё». */
export function primaryMobile(items: NavItem[], can: (p: string) => boolean): NavItem[] {
  const by = (to: string) => items.find((i) => i.to === to);
  const order = can('access.manage') && can('metrics.read')
    ? ['/', '/network-sales', '/map', '/control']
    : can('crm.manage')
    ? ['/', '/crm', '/map', '/openings']
    : can('royalty.publish')
    ? ['/', '/royalties', '/tasks', '/support']
    : can('royalty.report.submit')
      ? ['/', '/pos', '/sales', '/catalog']
      : can('sales.enter')
        ? ['/', '/pos', '/sales', '/support']
        : can('catalog.manage')
          ? ['/', '/orders', '/supply', '/tasks']
          : can('order.approve')
          ? ['/', '/orders', '/tasks', '/support']
          : ['/', '/tasks', '/support', '/kb'];
  const picked = order.map(by).filter((x): x is NavItem => Boolean(x));
  for (const i of items) if (picked.length < 4 && !picked.includes(i)) picked.push(i);
  return picked.slice(0, 4);
}
