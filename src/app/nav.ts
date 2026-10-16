// Меню по роли: у франчайзи — главная и база знаний, у менеджера — франчайзи, роялти и база знаний.
import { BookOpen, Home, Landmark, Store } from 'lucide-react';
import type { ComponentType } from 'react';

export interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ size?: number; 'aria-hidden'?: boolean }>;
}

export function navFor(isManager: boolean): NavItem[] {
  return isManager
    ? [
        { to: '/', label: 'Франчайзи', icon: Store },
        { to: '/royalty', label: 'Роялти', icon: Landmark },
        { to: '/kb', label: 'База знаний', icon: BookOpen },
      ]
    : [
        { to: '/', label: 'Главная', icon: Home },
        { to: '/kb', label: 'База знаний', icon: BookOpen },
      ];
}
