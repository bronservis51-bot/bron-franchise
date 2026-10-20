// Меню по роли. Франчайзи: главная, сотрудники, рейтинг, роялти, база знаний. Сотрудник: смена и база знаний.
// Менеджер: франчайзи, роялти, рейтинг, база знаний.
import { BookOpen, Clock, Home, Landmark, Store, Trophy, Users } from 'lucide-react';
import type { ComponentType } from 'react';

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
  /** Счётчик на пункте меню (например, вопросы без ответа). */
  badge?: 'kb';
}

export function navFor(role: 'manager' | 'franchisee' | 'staff'): NavItem[] {
  if (role === 'manager') return [
    { to: '/', label: 'Франчайзи', icon: Store },
    { to: '/royalty', label: 'Роялти', icon: Landmark },
    { to: '/rating', label: 'Рейтинг', icon: Trophy },
    { to: '/kb', label: 'База знаний', icon: BookOpen, badge: 'kb' },
  ];
  if (role === 'staff') return [
    { to: '/', label: 'Смена', icon: Clock },
    { to: '/kb', label: 'База знаний', icon: BookOpen, badge: 'kb' },
  ];
  return [
    { to: '/', label: 'Главная', icon: Home },
    { to: '/staff', label: 'Сотрудники', icon: Users },
    { to: '/rating', label: 'Рейтинг', icon: Trophy },
    { to: '/royalty', label: 'Роялти', icon: Landmark },
    { to: '/kb', label: 'Знания', icon: BookOpen, badge: 'kb' },
  ];
}
