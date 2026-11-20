// Меню по роли. Франчайзи: главная, сотрудники, финансы (вкл. роялти), база знаний. Рейтинг — только менеджеру сети.
// Менеджер: франчайзи, заявки с сайта, экономика (вкл. роялти), рейтинг, база знаний.
import { BookOpen, GraduationCap, Home, Inbox, Trophy, Users, Wallet } from 'lucide-react';
import type { ComponentType } from 'react';

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  /** Счётчик на пункте меню (например, вопросы без ответа). */
  badge?: 'kb' | 'leads' | 'learning';
}

const training: NavItem = {to:'/learning',label:'Обучение',icon:GraduationCap,badge:'learning'};
const home: NavItem = { to: '/', label: 'Главная', icon: Home };
const staff: NavItem = { to: '/staff', label: 'Сотрудники', icon: Users };

export type PermissionCheck = (permission: string) => boolean;
export const canOpenStaffDirectory = (can: PermissionCheck) => can('staff.manage') || can('staff.view') || can('staff.create');
export const canOrderMaterials = (can: PermissionCheck) => can('procurement.order');

export function navFor(role: 'manager' | 'franchisee' | 'staff' | 'team' | 'support', staffDirectory = false): NavItem[] {
  if (role === 'manager') return [
    home,
    { to: '/leads', label: 'Заявки', icon: Inbox, badge: 'leads' },
    { to: '/finance', label: 'Экономика', icon: Wallet },
    { to: '/rating', label: 'Рейтинг', icon: Trophy },
    { to: '/kb', label: 'Знания', icon: BookOpen, badge: 'kb' },
  ];
  if (role === 'support') return [{ ...home, badge: 'kb' }, { to: '/kb', label: 'Знания', icon: BookOpen }];
  if (role === 'team' || role === 'staff') return [
    home,
    training,
    ...(staffDirectory ? [staff] : []),
    { to: '/kb', label: role === 'staff' ? 'База знаний' : 'Знания', icon: BookOpen, badge: role === 'team' ? 'kb' : undefined },
  ];
  return [
    home,
    staff,
    { to: '/finance', label: 'Финансы', icon: Wallet },
    { to: '/kb', label: 'Знания', icon: BookOpen, badge: 'kb' },
  ];
}
