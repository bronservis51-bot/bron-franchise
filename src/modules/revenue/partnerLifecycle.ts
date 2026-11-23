import { useQuery } from '@tanstack/react-query';
import { from, single } from '../../platform/backend';
import { useSession, type Me } from '../../platform/session';

type CommercialStatus = 'active' | 'suspended' | 'terminated';

export function franchiseePartnerCards(me: Me | null) {
  return [...new Set(me?.assignments.flatMap(assignment =>
    assignment.role === 'franchisee' && assignment.scope_type === 'partner' && assignment.scope_id ? [assignment.scope_id] : []))];
}

export const FRANCHISEE_CARD_AMBIGUITY = 'За этой учётной записью сохранены прежние доступы к нескольким карточкам. Уточните карточку у менеджера по франшизе.';

export function usePartnerLifecycle(partnerId?: string | null) {
  return useQuery({
    queryKey: ['partner-lifecycle', partnerId],
    enabled: Boolean(partnerId),
    staleTime: 0,
    queryFn: () => single<{ status: CommercialStatus }>(from('partner').select('status').eq('id', partnerId!)),
  });
}

export function useOwnPartnerLifecycle() {
  const { me } = useSession();
  const ownedCards = franchiseePartnerCards(me);
  const delegatedCards = new Set(me?.assignments.filter(a => a.scope_type === 'partner' && a.scope_id).map(a => a.scope_id));
  const partnerId = ownedCards.length
    ? (ownedCards.length === 1 ? ownedCards[0] : undefined)
    : (delegatedCards.size === 1 ? delegatedCards.values().next().value : undefined);
  const query = usePartnerLifecycle(partnerId);
  return { partnerId, query, readOnly: isPartnerReadOnly(query.data?.status) };
}

export const isPartnerReadOnly = (status?: CommercialStatus | null) => status === 'suspended' || status === 'terminated';
