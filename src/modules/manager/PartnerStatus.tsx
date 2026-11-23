import { Badge, type Tone } from '../../ui';
import { PARTNER_PREPARATION, PARTNER_STATUS, st } from '../../ui/status';
import type { ManagerPartnerStatus, Partner } from './api';

export function PartnerStatus({ partner, current }: { partner?: Partner; current?: ManagerPartnerStatus }) {
  if (!partner) return null;
  let status: [string, Tone];
  if (partner.status !== 'active') status = st(PARTNER_STATUS, partner.status);
  else {
    if (!current) return null;
    if (current.working) status = ['Работает', 'success'];
    else if (partner.preparation_stage) status = st(PARTNER_PREPARATION, partner.preparation_stage);
    else status = ['Нет открытой точки', 'neutral'];
  }
  const [label, tone] = status;
  return <Badge tone={tone}><span style={{ whiteSpace: 'normal', overflowWrap: 'anywhere', lineHeight: 1.25 }}>{label}</span></Badge>;
}

export const OWNER_ACCESS_LABEL: Record<ManagerPartnerStatus['owner_access'], string> = {
  granted: 'Доступ франчайзи выдан',
  pending: 'Ожидается первый вход франчайзи',
  none: 'У франчайзи нет доступа',
};
