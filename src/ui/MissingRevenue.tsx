import { ChevronDown } from 'lucide-react';
import { Link } from 'react-router';
import { useLocale } from '../platform/locale';
import './missing-revenue.css';

type DateAction = { label: string } & (
  | { to: string; onSelect?: never; disabled?: never }
  | { to?: never; onSelect: () => void; disabled?: boolean }
  | { to?: never; onSelect?: never; disabled?: never }
);

type MissingRevenuePoint = { id: string; name?: string; count?: number; dates: DateAction[] };

export function MissingRevenue({ points, hint, title, urgent = false }: {
  points: MissingRevenuePoint[]; hint?: string; title?: string; urgent?: boolean;
}) {
  const { t } = useLocale();
  const missing = points.filter(point => point.dates.length > 0);
  if (!missing.length) return null;
  const count = missing.length === 1 ? missing[0].count : undefined;
  return <details className={`home-disclosure home-missing${urgent ? " home-missing-danger" : ""}`}>
    <summary>
      <span className="home-missing-label">
        <strong>{title ?? t('Не внесена выручка', 'Gelir kaydı eksik')}</strong>
        {count ? <span>{t(`${count} дн.`, `${count} gün`)}</span> : null}
      </span>
      <ChevronDown size={18} aria-hidden />
    </summary>
    <div className="home-disclosure-body home-missing-body">
      {hint && <p className="faint">{hint}</p>}
      {missing.map(point => <div className="home-missing-point" key={point.id}>
        {point.name && <strong>{point.name}</strong>}
        <ul className="home-missing-dates">
          {point.dates.map(({ label, to, onSelect, disabled }) => <li key={label}>
            {to ? <Link to={to}>{label}</Link> : onSelect
              ? <button type="button" disabled={disabled} onClick={onSelect}>{label}</button>
              : <span>{label}</span>}
          </li>)}
        </ul>
      </div>)}
    </div>
  </details>;
}
