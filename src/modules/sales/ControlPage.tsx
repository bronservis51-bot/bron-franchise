// «Контроль выручки» для компании: признаки занижения выручки по каждой точке за месяц.
// Сигналы — повод проверить, а не обвинение: франчайзи видит те же данные в своей выручке и отчётах.
import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ShieldAlert } from 'lucide-react';
import { formatPeriod } from '../../platform/dates';
import { intlLocale, useT } from '../../platform/i18n';
import { formatMoneyShort } from '../../platform/money';
import { Badge, Card, DataState, EmptyState, PageHeader } from '../../ui';
import { salesControl, type ControlRow } from './api';

const monthOf = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
function shiftMonth(month: string, n: number) {
  const d = new Date(`${month}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n, 1);
  return d.toISOString().slice(0, 10);
}

function signals(r: ControlRow): { tone: 'danger' | 'warning'; text: string }[] {
  const s: { tone: 'danger' | 'warning'; text: string }[] = [];
  if (r.report_diff_minor < 0) s.push({ tone: 'danger', text: `Отчёт роялти меньше смен на ${formatMoneyShort(-r.report_diff_minor, r.currency, intlLocale())}` });
  if (r.film_phones_60d > 0 && r.services_est_60d < r.film_phones_60d * 0.6)
    s.push({ tone: 'warning', text: `Плёнки куплено на ${r.film_phones_60d} оклеек, показано ~${r.services_est_60d} (${Math.round((r.services_est_60d * 100) / r.film_phones_60d)}%)` });
  if (r.reductions > 0) s.push({ tone: 'warning', text: `Франчайзи уменьшал смены менеджеров: ${r.reductions}` });
  if (r.missing_days > 2) s.push({ tone: 'warning', text: `Дней без выручки: ${r.missing_days}` });
  if (r.card_share !== null && r.card_share < 0.35) s.push({ tone: 'warning', text: `Мало оплат картой: ${Math.round(r.card_share * 100)}% (наличные проверить труднее)` });
  return s;
}

export function ControlPage() {
  const { t } = useT();
  const max = monthOf();
  const [month, setMonth] = useState(max);
  const q = useQuery({ queryKey: ['sales-control', month], queryFn: () => salesControl(month) });
  const label = formatPeriod(month, intlLocale());
  return (
    <>
      <PageHeader title={t('Контроль выручки')} sub="Признаки занижения выручки франчайзи: сверка со сменами, закупленной плёнкой и оплатами картой"
        actions={<div className="row" role="group" aria-label={t('Месяц')}>
          <button type="button" className="icon-btn" aria-label={t('Предыдущий месяц')} onClick={() => setMonth(shiftMonth(month, -1))}><ChevronLeft size={18} /></button>
          <strong style={{ minWidth: 130, textAlign: 'center' }}>{label.charAt(0).toUpperCase() + label.slice(1)}</strong>
          <button type="button" className="icon-btn" aria-label={t('Следующий месяц')} disabled={month >= max} onClick={() => setMonth(shiftMonth(month, 1))}><ChevronRight size={18} /></button>
        </div>} />
      <Card className="control-explain">
        <div className="row" style={{ alignItems: 'flex-start', gap: 12 }}>
          <span className="icon-tile dark"><ShieldAlert size={18} /></span>
          <div>
            <strong>{t('Как это работает')}</strong>
            <ul className="faint" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li>{t('Выручку вносят менеджеры продаж при закрытии смены — им выгодно вносить всё: от выручки зависит их процент.')}</li>
              <li>{t('Месячный отчёт роялти собирается из смен; если франчайзи отправит меньше — расхождение фиксируется и приходит финансам.')}</li>
              <li>{t('Плёнку франчайзи покупает у компании: если оклеек показано намного меньше, чем можно сделать из купленной плёнки, — это повод проверить.')}</li>
              <li>{t('Оплаты картой проверяются выпиской эквайринга; уменьшения смен франчайзи делаются только с причиной и видны здесь.')}</li>
            </ul>
          </div>
        </div>
      </Card>
      <DataState query={q}>
        {(d) => !d.locations.length ? <Card><EmptyState title="Нет данных" text="Нет активных точек с доступом к выручке." /></Card> : (
          <Card bodyless>
            <div className="table-wrap"><table className="table control-table">
              <thead><tr>
                <th>{t('Точка')}</th><th className="r">{t('Выручка')}</th><th className="r">{t('Оклеек')}</th><th className="r">{t('Средний чек')}</th>
                <th className="r">{t('По карте')}</th><th>{t('Плёнка → оклейки, 60 дн.')}</th><th>{t('Сигналы')}</th><th>{t('Риск')}</th>
              </tr></thead>
              <tbody>{d.locations.map((r) => {
                const sig = signals(r);
                const use = r.film_phones_60d > 0 ? Math.min(100, Math.round((r.services_est_60d * 100) / r.film_phones_60d)) : null;
                return (
                  <tr key={r.location_id}>
                    <td><Link to={`/sales?tab=location&location=${r.location_id}&month=${d.month}`}><strong>{r.location_name}</strong></Link><div className="faint">{r.partner_name}</div></td>
                    <td className="r">{formatMoneyShort(r.revenue_minor, r.currency, intlLocale())}<div className="faint">{r.days_with_data}/{d.days_in_period} {t('дн.')}</div></td>
                    <td className="r">{r.services}</td>
                    <td className="r">{r.avg_check_minor ? formatMoneyShort(r.avg_check_minor, r.currency, intlLocale()) : '—'}</td>
                    <td className="r">{r.card_share !== null ? `${Math.round(r.card_share * 100)}%` : '—'}</td>
                    <td style={{ minWidth: 170 }}>{use === null ? <span className="faint">{t('нет закупок')}</span> : <>
                      <div className="use-bar"><span style={{ width: `${use}%` }} className={use < 60 ? 'low' : ''} /></div>
                      <div className="faint">~{r.services_est_60d} {t('из')} {r.film_phones_60d} ({use}%)</div></>}</td>
                    <td>{sig.length ? <ul className="signal-list">{sig.map((x, i) => <li key={i} className={x.tone}>{t(x.text)}</li>)}</ul> : <span className="faint">{t('нет')}</span>}</td>
                    <td>{r.risk >= 3 ? <Badge tone="danger">{t('высокий')}</Badge> : r.risk >= 1 ? <Badge tone="warning">{t('проверить')}</Badge> : <Badge tone="success">{t('норма')}</Badge>}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          </Card>
        )}
      </DataState>
    </>
  );
}
