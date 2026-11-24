import { BookOpen, GraduationCap, Home, Inbox, Users, Wallet } from 'lucide-react';
import type { ComponentType } from 'react';
import type { useSession } from '../platform/session';
import { localized, type Language } from '../platform/locale';

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
export type WorkspaceRole = 'manager' | 'franchisee' | 'staff' | 'team' | 'support' | 'pending';

export const workspaceTitle: Record<WorkspaceRole, string> = {
  manager: 'Менеджер по франшизе',
  franchisee: 'Франчайзи',
  team: 'Управляющий',
  staff: 'Сотрудник',
  support: 'Техническая поддержка',
  pending: 'Ожидает доступа',
};

export function workspaceRole({ me, isManager, isTechnical, isStaff, isTeamManager }: ReturnType<typeof useSession>): WorkspaceRole {
  if (!me?.assignments.length) return 'pending';
  if (isManager) return 'manager';
  if (isTechnical) return 'support';
  if (isStaff) return 'staff';
  return isTeamManager ? 'team' : 'franchisee';
}

export const canOpenStaffDirectory = (can: PermissionCheck) =>
  can('staff.manage') || can('staff.view') || can('staff.create') || can('staff.pay_edit');
export const canOrderMaterials = (can: PermissionCheck) => can('procurement.order');

export function workspaceAccess(role: WorkspaceRole, can: PermissionCheck) {
  const learning = role === 'staff' || role === 'team';
  const network = role === 'manager' && can('org.manage');
  const royalty = role === 'manager' && can('royalty.manage');
  const partner = role === 'franchisee' || learning;
  return {
    network,
    finance: network || royalty || (role === 'franchisee' && can('revenue.read')),
    royalty,
    staffDirectory: partner && canOpenStaffDirectory(can),
    order: partner && canOrderMaterials(can),
    learning,
    learningManage: role !== 'pending' && (can('staff.manage') || can('kb.edit')),
    knowledgeEdit: role !== 'pending' && can('kb.edit'),
  };
}

const turkishWorkspaceTitle: Record<WorkspaceRole, string> = {
  manager: 'Franchise yöneticisi', franchisee: 'Franchise işletmecisi', team: 'Mağaza yöneticisi',
  staff: 'Çalışan', support: 'Teknik destek', pending: 'Erişim bekleniyor',
};

export const workspaceTitleFor = (role: WorkspaceRole, language: Language) =>
  localized(language, workspaceTitle[role], turkishWorkspaceTitle[role]);

const turkishNavLabels: Record<string, string> = {
  'Главная': 'Ana sayfa', 'Сотрудники': 'Çalışanlar', 'Обучение': 'Eğitim', 'Знания': 'Bilgi bankası',
  'База знаний': 'Bilgi bankası', 'Финансы': 'Finans', 'Экономика': 'Finans', 'Роялти': 'Royalti', 'Заявки': 'Başvurular',
};

export function navFor(role: WorkspaceRole, can: PermissionCheck = () => false, language: Language = 'ru'): NavItem[] {
  const items = workspaceNav(role, can);
  return language === 'ru' ? items : items.map(item => ({ ...item, label: turkishNavLabels[item.label] ?? item.label }));
}

function workspaceNav(role: WorkspaceRole, can: PermissionCheck): NavItem[] {
  const { network, finance, staffDirectory } = workspaceAccess(role, can);
  if (role === 'pending') return [];
  if (role === 'manager') return [
    home,
    ...(network ? [{ to: '/leads', label: 'Заявки', icon: Inbox, badge: 'leads' as const }] : []),
    ...(finance ? [{ to: '/finance', label: network ? 'Экономика' : 'Роялти', icon: Wallet }] : []),
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
    ...(staffDirectory ? [staff] : []),
    ...(finance ? [{ to: '/finance', label: 'Финансы', icon: Wallet }] : []),
    { to: '/kb', label: 'Знания', icon: BookOpen, badge: 'kb' },
  ];
}
