// Общие справочники для экранов (только чтение; видимость определяется RLS).
import { useQuery } from '@tanstack/react-query';
import { from, rows } from '../../platform/backend';
import { useSession } from '../../platform/session';

export interface UserName { id: string; full_name: string }
export interface Location { id: string; code: string; name: string; kind: 'own' | 'franchise'; partner_id: string | null; city: string; address: string | null; timezone: string; currency: string; status: string; country: string; opened_on: string | null }
export interface Partner { id: string; code: string; name: string; country: string; locale: string; status: string; contact_name: string | null; contact_phone: string | null; contact_email: string | null; is_demo: boolean }
export interface Role { code: string; name: string; kind: string }

export function useUserNames() {
  const { me } = useSession();
  const q = useQuery({
    queryKey: ['lookup', 'users'],
    enabled: Boolean(me),
    staleTime: 5 * 60_000,
    queryFn: () => rows<UserName>(from('app_user').select('id, full_name')),
  });
  const map = new Map((q.data ?? []).map((u) => [u.id, u.full_name]));
  return (id: string | null | undefined) => (id ? map.get(id) ?? 'Сотрудник' : null);
}

export function useLocations() {
  return useQuery({
    queryKey: ['lookup', 'locations'],
    staleTime: 5 * 60_000,
    queryFn: () => rows<Location>(from('location').select('*').order('name')),
  });
}

export function usePartners() {
  return useQuery({
    queryKey: ['lookup', 'partners'],
    staleTime: 5 * 60_000,
    queryFn: () => rows<Partner>(from('partner').select('*').order('name')),
  });
}

export function useRoles() {
  const q = useQuery({
    queryKey: ['lookup', 'roles'],
    staleTime: 30 * 60_000,
    queryFn: () => rows<Role>(from('role').select('code, name, kind')),
  });
  const map = new Map((q.data ?? []).map((r) => [r.code, r.name]));
  return { list: q.data ?? [], name: (code: string | null | undefined) => (code ? map.get(code) ?? code : '—') };
}

/** Точки, для которых у пользователя есть разрешение (подсказка интерфейсу; сервер проверяет сам). */
export function useLocationsWith(perm: string) {
  const { me } = useSession();
  const locs = useLocations();
  const list = (locs.data ?? []).filter((l) =>
    me?.assignments.some((a) => a.permissions.includes(perm) && (
      a.scope_type === 'company' ||
      (a.scope_type === 'partner' && a.scope_id === l.partner_id) ||
      (a.scope_type === 'location' && a.scope_id === l.id) ||
      a.scope_type === 'direction')));
  return { ...locs, data: list };
}
