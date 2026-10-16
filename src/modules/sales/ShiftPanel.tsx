// Смена менеджера продаж в два нажатия: «Начать смену» утром → «Закрыть смену» вечером (выручка, из неё по карте,
// возвраты, число оклеек, фото кассового отчёта). Сразу видно, сколько заработано за смену и за месяц.
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, CheckCircle2, Clock, Play, Plus, Square, Wallet } from 'lucide-react';
import { useSession } from '../../platform/session';
import { posDay } from '../pos/api';
import { intlLocale, useT } from '../../platform/i18n';
import { formatMoneyShort, toBigInt } from '../../platform/money';
import { ActionError, Alert, Button, ConfirmDialog, Field, Input, MoneyInput, Select, Textarea } from '../../ui';
import { useToast } from '../../ui/toast';
import { earnings, myEarnings, pct, salesCommands, type MyEarnings, type OpenShift } from './api';

function since(iso: string) {
  const min = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  return min < 60 ? `${min} мин` : `${Math.floor(min / 60)} ч ${min % 60} мин`;
}
const time = (iso: string, tz: string) => new Date(iso).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit', timeZone: tz });

function CloseShiftDialog({ shift, open, onClose, onDone }: { shift: OpenShift; open: boolean; onClose: () => void; onDone: () => void }) {
  const { t } = useT();
  const toast = useToast();
  const [revenue, setRevenue] = useState('0');
  const [card, setCard] = useState('0');
  const [returns, setReturns] = useState('0');
  const [services, setServices] = useState('');
  const [comment, setComment] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Продажи, записанные за смену, подставляются сами — остаётся сверить с кассой
  const { me } = useSession();
  const day = useQuery({ queryKey: ['pos', 'day', shift.location_id, null], enabled: open, queryFn: () => posDay(shift.location_id, null) });
  const mine = (day.data?.sales ?? []).filter((x) => x.employee_id === me?.user.id && x.status === 'done');
  useEffect(() => {
    if (!open) return;
    setReturns('0'); setComment(''); setPhoto(null);
    setRevenue(String(mine.reduce((a, x) => a + Number(x.total_minor), 0)));
    setCard(String(mine.reduce((a, x) => a + Number(x.card_minor), 0)));
    setServices(mine.length ? String(mine.reduce((a, x) => a + x.lines.length, 0)) : '');
  }, [open, day.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const cur = shift.currency;
  const net = toBigInt(revenue) - toBigInt(returns);
  const cardOver = toBigInt(card) > toBigInt(revenue);
  const close = useMutation({
    mutationFn: () => salesCommands.closeShift({ shift: shift.id, revenue, card: card === '0' ? null : card, returns, services: Number(services || 0), comment: comment || null, photo }),
    onSuccess: () => { toast(`Смена закрыта. Ваш заработок за смену: ${formatMoneyShort(net > 0n ? earnings(net, shift.rate_bp) : 0n, cur, intlLocale())}`); onDone(); onClose(); },
  });
  const invalid = toBigInt(revenue) <= 0n || net < 0n || cardOver || !services;
  return (
    <ConfirmDialog open={open} title="Закрыть смену" confirmLabel="Закрыть смену" busy={close.isPending} error={close.error}
      onClose={() => { close.reset(); onClose(); }} onConfirm={() => close.mutate()} disabled={invalid}>
      <div className="faint" style={{ marginBottom: 12 }}>{shift.location_name} · {t('с')} {time(shift.opened_at, shift.timezone)}</div>
      {mine.length > 0 && <div className="client-chip on" style={{ marginBottom: 12 }}>{t('Подставлено из продаж за смену')}: {mine.length} · {t('проверьте по кассе')}</div>}
      <Field label={`Выручка за смену, ${cur}`} required hint="Вся сумма: наличные + карта">{(id) => <MoneyInput id={id} value={revenue} currency={cur} onChange={setRevenue} />}</Field>
      <div className="grid grid-2">
        <Field label={`Из неё по карте, ${cur}`} hint="По отчёту терминала" error={cardOver ? t('Больше выручки') : null}>{(id) => <MoneyInput id={id} value={card} currency={cur} onChange={setCard} invalid={cardOver} />}</Field>
        <Field label="Сколько оклеек" required>{(id) => <Input id={id} inputMode="numeric" value={services} onChange={(e) => setServices(e.target.value.replace(/\D/g, ''))} />}</Field>
        <Field label={`Возвраты, ${cur}`} hint="Если были">{(id) => <MoneyInput id={id} value={returns} currency={cur} onChange={setReturns} invalid={net < 0n} />}</Field>
        <Field label="Комментарий">{(id) => <Textarea id={id} rows={1} value={comment} onChange={(e) => setComment(e.target.value)} />}</Field>
      </div>
      <div className="photo-pick">
        <input ref={fileRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
        <Button size="sm" onClick={() => fileRef.current?.click()}><Camera size={16} aria-hidden />{photo ? t('Заменить фото') : t('Фото кассового отчёта')}</Button>
        <span className="faint">{photo ? photo.name : t('Фото Z-отчёта или чека терминала подтверждает выручку')}</span>
      </div>
      <div className="earn-preview" style={{ marginTop: 12 }}>
        <span className="icon-tile" style={{ width: 36, height: 36 }}><Wallet size={18} /></span>
        <div>
          <div className="faint">{t('Ваш процент')} {pct(shift.rate_bp)}</div>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{t('За эту смену')}: {formatMoneyShort(net > 0n ? earnings(net, shift.rate_bp) : 0n, cur, intlLocale())}</div>
        </div>
      </div>
      {invalid && toBigInt(revenue) > 0n && !services && <div className="faint" style={{ marginTop: 8 }}>{t('Укажите, сколько оклеек сделано за смену')}</div>}
    </ConfirmDialog>
  );
}

/** Панель смены: кнопка «Начать смену», идущая смена с таймером или итог закрытой. */
export function ShiftPanel({ data, onChanged, compact }: { data: MyEarnings; onChanged: () => void; compact?: boolean }) {
  const { t } = useT();
  const { can } = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [loc, setLoc] = useState(data.locations[0]?.id ?? '');
  const [closing, setClosing] = useState(false);
  const [, tick] = useState(0);
  useEffect(() => { const h = setInterval(() => tick((x) => x + 1), 60000); return () => clearInterval(h); }, []);
  const refresh = () => { onChanged(); void qc.invalidateQueries({ queryKey: ['today'] }); void qc.invalidateQueries({ queryKey: ['sales'] }); };
  const openM = useMutation({ mutationFn: () => salesCommands.openShift(loc), onSuccess: () => { toast('Смена начата. Хорошей работы!'); refresh(); } });
  const cancelM = useMutation({ mutationFn: (id: string) => salesCommands.cancelShift(id), onSuccess: () => { toast('Смена отменена'); refresh(); } });
  const shift = data.open_shift;
  const tot = data.totals[0];
  // Игровая цель: заработать больше, чем за весь прошлый месяц; рекорд смены этого месяца
  const prevMonth = (() => { const d = new Date(`${data.month}T12:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1, 1); return d.toISOString().slice(0, 10); })();
  const prev = useQuery({ queryKey: ['sales', 'my', prevMonth], queryFn: () => myEarnings(prevMonth), staleTime: 10 * 60_000 });
  const prevEarn = Number(prev.data?.totals.find((x) => x.currency === (tot?.currency ?? data.locations[0]?.currency))?.earnings_minor ?? 0);
  const nowEarn = Number(tot?.earnings_minor ?? 0);
  const best = data.days.reduce((m, x) => Math.max(m, Number(x.revenue_minor)), 0);
  const goal = prevEarn > 0 ? { pctDone: Math.round((nowEarn * 100) / prevEarn), left: prevEarn - nowEarn, best: best || null } : null;
  const cur = tot?.currency ?? data.locations[0]?.currency ?? 'RUB';
  const l = data.locations.find((x) => x.id === loc) ?? data.locations[0];
  if (!l && !shift) return null;
  const todayDay = data.days.find((d) => d.location_id === l?.id && d.day === l?.today);
  const stale = shift && l && shift.day < (data.locations.find((x) => x.id === shift.location_id)?.today ?? shift.day);

  return (
    <section className={`shift-panel${shift ? ' on' : ''}`} aria-label={t('Моя смена')}>
      <div className="shift-top">
        <div>
          <div className="shift-label">{shift ? (stale ? t('Смена не закрыта') : t('Вы на смене')) : todayDay ? t('Смена за сегодня закрыта') : t('Моя смена')}</div>
          {shift ? (
            <div className="shift-main"><Clock size={20} aria-hidden /> {t('с')} {time(shift.opened_at, shift.timezone)} · {stale ? new Date(`${shift.day}T12:00:00Z`).toLocaleDateString(intlLocale(), { day: 'numeric', month: 'long', timeZone: 'UTC' }) : since(shift.opened_at)}</div>
          ) : todayDay ? (
            <div className="shift-main"><CheckCircle2 size={20} aria-hidden /> {formatMoneyShort(todayDay.revenue_minor, todayDay.currency, intlLocale())} · {t('заработок')} {formatMoneyShort(todayDay.earnings_minor, todayDay.currency, intlLocale())}</div>
          ) : (
            <div className="shift-main">{t('Начните смену, когда откроете точку')}</div>
          )}
          <div className="shift-sub">{shift ? shift.location_name : l?.name} · {t('ваш процент')} {pct(shift ? shift.rate_bp : l?.rate_bp ?? 0)}</div>
        </div>
        <Link to="/sales" className="shift-earn" aria-label={t('Мой заработок за месяц')}>
          <span className="l">{t('Заработано за месяц')}</span>
          <span className="v">{formatMoneyShort(tot?.earnings_minor ?? 0, cur, intlLocale())}</span>
          <span className="s">{t('смен')}: {tot?.shifts ?? 0}</span>
        </Link>
      </div>
      {goal && (
        <div className="goal" title={t('Заработок этого месяца против всего прошлого месяца')}>
          <div className="goal-head">
            <span>{goal.pctDone >= 100 ? `🏆 ${t('Прошлый месяц побит!')}` : `🎯 ${t('Цель: побить прошлый месяц')}`}</span>
            <strong>{Math.min(goal.pctDone, 999)}%</strong>
          </div>
          <div className="goal-bar"><span style={{ width: `${Math.min(100, goal.pctDone)}%` }} className={goal.pctDone >= 100 ? 'won' : ''} /></div>
          <div className="goal-foot">
            {goal.pctDone < 100 ? <>{t('Осталось')} {formatMoneyShort(goal.left, cur, intlLocale())}</> : <>{t('Сверх прошлого месяца')} +{formatMoneyShort(-goal.left, cur, intlLocale())}</>}
            {goal.best && <span>⭐ {t('Рекорд смены')}: {formatMoneyShort(goal.best, cur, intlLocale())}</span>}
          </div>
        </div>
      )}
      <div className="shift-actions">
        {shift ? (
          <>
            {can('pos.sell') && <Link to={`/pos?location=${shift.location_id}&new=1`} className="btn btn-silver"><Plus size={16} aria-hidden />{t('Продажа')}</Link>}
            <Button variant="ghost" className="shift-close-btn" onClick={() => setClosing(true)}><Square size={16} aria-hidden />{t('Закрыть смену')}</Button>
            {!compact && <button type="button" className="link-btn" onClick={() => cancelM.mutate(shift.id)} disabled={cancelM.isPending}>{t('Открыл по ошибке')}</button>}
          </>
        ) : !todayDay && l ? (
          <>
            {data.locations.length > 1 && (
              <Select aria-label={t('Точка')} value={l.id} onChange={(e) => setLoc(e.target.value)} className="shift-select">
                {data.locations.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
              </Select>
            )}
            <Button variant="silver" loading={openM.isPending} onClick={() => openM.mutate()}><Play size={16} aria-hidden />{t('Начать смену')}</Button>
          </>
        ) : (
          <Link to="/sales" className="link-btn">{t('Исправить сумму')}</Link>
        )}
      </div>
      {stale && <div style={{ marginTop: 10 }}><Alert tone="warning">{t('Закройте вчерашнюю смену: внесите выручку, чтобы заработок и отчёт точки были полными.')}</Alert></div>}
      <ActionError error={openM.error ?? cancelM.error} />
      {shift && <CloseShiftDialog shift={shift} open={closing} onClose={() => setClosing(false)} onDone={refresh} />}
    </section>
  );
}
