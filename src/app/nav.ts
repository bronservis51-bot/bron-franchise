// Меню по роли. Франчайзи: главная, сотрудники, рейтинг (только в России), финансы (вкл. роялти), база знаний. Сотрудник: смена и база знаний.
// Менеджер: франчайзи, заявки с сайта, роялти, рейтинг, база знаний.
import { BookOpen, GraduationCap, Clock, Home, Inbox, Landmark, Store, Trophy, Users, Wallet } from 'lucide-react';
import type { ComponentType } from 'react';

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  /** Счётчик на пункте меню (например, вопросы без ответа). */
  badge?: 'kb' | 'leads' | 'learning';
}

const training: NavItem = {to:'/learning',label:'Обучение',icon:GraduationCap,badge:'learning'};

export function navFor(role: 'manager' | 'franchisee' | 'staff' | 'team' | 'support'): NavItem[] {
  if (role === 'manager') return [
    { to: '/', label: 'Франчайзи', icon: Store },
    { to: '/leads', label: 'Заявки', icon: Inbox, badge: 'leads' },
    { to: '/royalty', label: 'Роялти', icon: Landmark },
    { to: '/finance', label: 'Экономика', icon: Wallet },
    { to: '/rating', label: 'Рейтинг', icon: Trophy },
    { to: '/kb', label: 'Знания', icon: BookOpen, badge: 'kb' },
  ];
  if (role === 'support') return [{to:'/',label:'Вопросы',icon:Inbox,badge:'kb'},{to:'/kb',label:'Знания',icon:BookOpen}];
  if (role === 'team') return [training,{ to: '/', label: 'Главная', icon: Home }, { to: '/staff', label: 'Сотрудники', icon: Users }, { to: '/kb', label: 'Знания', icon: BookOpen, badge: 'kb' }];
  if (role === 'staff') return [
    { to: '/', label: 'Смена', icon: Clock },
    training,
    { to: '/kb', label: 'База знаний', icon: BookOpen, badge: 'kb' },
  ];
  return [
    { to: '/', label: 'Главная', icon: Home },
    { to: '/staff', label: 'Сотрудники', icon: Users },
    { to: '/rating', label: 'Рейтинг', icon: Trophy },
    { to: '/finance', label: 'Финансы', icon: Wallet },
    { to: '/kb', label: 'Знания', icon: BookOpen, badge: 'kb' },
  ];
}
