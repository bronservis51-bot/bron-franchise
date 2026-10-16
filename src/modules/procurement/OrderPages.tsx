// Заказ (BUY-05…08): раздельные статусы согласования, оплаты, передачи; количества по строкам; отгрузки; приёмка.
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useScopeFilter, useSession } from '../../platform/session';
import { formatDate, formatDateTime } from '../../platform/dates';
import { intlLocale, useT } from '../../platform/i18n';
import { ActionError, Alert, Badge, Button, Card, Checkbox, Chips, ConfirmDialog, DataState, EmptyState, Field, Input, KV, Money, PageHeader,
  Textarea, Timeline } from '../../ui';
import { APPROVAL_STATUS, ORDER_STATUS, PAYMENT_STATUS_ORDER, st, TRANSFER_STATUS, UNIT } from '../../ui/status';
import { useToast } from '../../ui/toast';
import { useLocations, useUserNames } from '../shared/lookups';
import { cartLines, getOrder, listOrders, ORDER_EVENT, orderCommands, orderEvents, orderShipments, type Order, type OrderFilter } from './api';

const fmtQty = (n: string | number) => Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 3 });

function OrderBadges({ o }: { o: Order }) {
  const s = st(ORDER_STATUS, o.status);
  const tr = st(TRANSFER_STATUS, o.transfer_status);
  return (
    <span className="row">
      <Badge tone={s[1]}>{s[0]}</Badge>
      {o.approval_status === 'pending' && <Badge tone="warning">ждёт согласования</Badge>}
      {['required', 'reported'].includes(o.payment_status) && o.status !== 'cancelled' && <Badge tone="warning">{st(PAYMENT_STATUS_ORDER, o.payment_status)[0]}</Badge>}
      {o.transfer_status !== 'sent' && o.transfer_status !== 'not_sent' && o.status !== 'cancelled' && <Badge tone={tr[1]}>{tr[0]}</Badge>}
    </span>
  );
}

export function OrdersPage() {
  const [params] = useSearchParams();
  const { partnerId, locationId } = useScopeFilter();
  const { can } = useSession();
  const { t } = useT();
  const [filter, setFilter] = useState<OrderFilter>(params.get('transfer') ? 'problem' : 'active');
  const locs = useLocations();
  const q = useQuery({ queryKey: ['orders', filter, partnerId, locationId], queryFn: () => listOrders(filter, partnerId, locationId) });
  return (
    <>
      <PageHeader title={t('Заказы')} sub="Заказы партнёров и заявки собственных точек" />
      <Chips label="Фильтр заказов" value={filter} onChange={setFilter} options={[
        { id: 'active', label: 'В работе' },
        ...(can('order.approve') || can('order.payment.confirm') ? [{ id: 'approval' as const, label: 'Ждут решения' }] : []),
        ...(can('order.manage') || can('integration.operate') ? [{ id: 'problem' as const, label: 'Проблемы передачи' }] : []),
        { id: 'done', label: 'Завершённые' }, { id: 'all', label: 'Все' },
      ]} />
      <Card bodyless>
        <DataState query={q} empty={(d) => (d.length ? null : <EmptyState title="Заказов нет" text={can('order.create') ? 'Оформите заказ в каталоге.' : undefined} />)}>
          {(d) => (
            <ul className="list">
              {d.map((o) => (
                <li key={o.id}>
                  <Link className="list-item" to={`/orders/${o.id}`}>
                    <div className="main-col">
                      <div className="title mono">{o.number}</div>
                      <div className="meta"><span>{locs.data?.find((l) => l.id === o.location_id)?.name}</span><span>{formatDate(o.submitted_at, intlLocale())}</span><span>{o.kind === 'supply_request' ? 'заявка точки' : 'заказ партнёра'}</span></div>
                    </div>
                    <div className="side"><Money minor={o.total_minor} currency={o.currency} /><OrderBadges o={o} /></div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </DataState>
      </Card>
    </>
  );
}

export function OrderPage() {
  const { id = '' } = useParams();
  const { me, can } = useSession();
  const { t } = useT();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const names = useUserNames();
  const locs = useLocations();
  const order = useQuery({ queryKey: ['order', id], queryFn: () => getOrder(id) });
  const lines = useQuery({ queryKey: ['order', id, 'lines'], queryFn: () => cartLines(id) });
  const ships = useQuery({ queryKey: ['order', id, 'ships'], queryFn: () => orderShipments(id) });
  const ev = useQuery({ queryKey: ['order', id, 'events'], queryFn: () => orderEvents(id) });
  const [dialog, setDialog] = useState<null | 'reject' | 'cancel' | 'payment' | 'receive'>(null);
  const [text, setText] = useState('');
  const [recv, setRecv] = useState<Record<string, string>>({});
  const [final, setFinal] = useState(false);

  const refresh = () => { void qc.invalidateQueries({ queryKey: ['order', id] }); void qc.invalidateQueries({ queryKey: ['orders'] }); void qc.invalidateQueries({ queryKey: ['today'] }); };
  const act = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => { refresh(); setDialog(null); setText(''); },
  });
  const demo = useMutation({
    mutationFn: ({ type, mode, eventId }: { type: string; mode: string; eventId: string | null }) => orderCommands.demoEvent(id, type, mode, eventId),
    onSuccess: () => { toast('Статус заказа обновлён'); refresh(); },
  });

  return (
    <DataState query={order} empty={(o) => (o ? null : <EmptyState title="Заказ не найден" />)}>
      {(o) => {
        if (!o) return null;
        const mine = o.created_by === me?.user.id;
        const loc = locs.data?.find((l) => l.id === o.location_id);
        const canReceive = ['partially_shipped', 'shipped', 'delivered'].includes(o.status) && can('order.create');
        return (
          <>
            <PageHeader back={{ to: '/orders', label: t('Заказы') }} title={`${t('Заказ')} ${o.number}`} sub={<OrderBadges o={o} />}
              actions={
                <>
                  {o.approval_status === 'pending' && can('order.approve') && !mine && <>
                    <Button variant="primary" loading={act.isPending} onClick={() => act.mutate(() => orderCommands.approve(o.id, null))}>Согласовать</Button>
                    <Button onClick={() => setDialog('reject')}>Отклонить</Button>
                  </>}
                  {['required', 'reported'].includes(o.payment_status) && o.status !== 'cancelled' && can('order.payment.confirm') && !mine && <Button variant="primary" onClick={() => setDialog('payment')}>Подтвердить оплату</Button>}
                  {canReceive && <Button variant="primary" onClick={() => { setRecv({}); setDialog('receive'); }}>{t('Принять поставку')}</Button>}
                  {can('order.create') && <Button onClick={() => act.mutate(async () => { const c = await orderCommands.repeat(o.id); toast('Создана новая корзина с текущими ценами'); navigate(`/catalog?order=${c.id}`); })}><RotateCcw size={15} aria-hidden />{t('Повторить заказ')}</Button>}
                  {['submitted', 'confirmed'].includes(o.status) && (mine || can('order.manage')) && <Button variant="danger" onClick={() => setDialog('cancel')}>{t('Отменить')}</Button>}
                </>
              } />
            <ActionError error={act.error} />
            {o.transfer_status === 'failed' && <div style={{ marginBottom: 16 }}><Alert tone="danger" title="Склад сейчас недоступен">Заказ сохранён и будет передан автоматически. Оператор видит проблему и может повторить передачу.</Alert></div>}
            {o.transfer_status === 'needs_reconciliation' && <div style={{ marginBottom: 16 }}><Alert tone="warning" title="Проверяем, получил ли склад заказ">Ответ склада потерян. Перед повтором система сверит документ, чтобы не создать дубль.</Alert></div>}
            {o.payment_status === 'required' && mine && <div style={{ marginBottom: 16 }}><Alert tone="info" title="Ожидается оплата">Заказ уйдёт на склад после того, как снабжение подтвердит зачисление.</Alert></div>}
            <div className="grid grid-main">
              <div className="stack">
                <Card title="Позиции" bodyless>
                  <div className="table-wrap">
                    <table className="table">
                      <thead><tr><th>Товар</th><th className="r">Заказано</th><th className="r">Подтверждено</th><th className="r">Отгружено</th><th className="r">Получено</th><th className="r">Отменено</th><th className="r">Сумма</th></tr></thead>
                      <tbody>
                        {(lines.data ?? []).map((l) => (
                          <tr key={l.id}>
                            <td><div style={{ fontWeight: 600 }}>{l.name}</div><div className="faint mono">{l.sku} · {t(UNIT[l.unit] ?? l.unit)}</div></td>
                            <td className="r num">{fmtQty(l.qty_ordered)}</td>
                            <td className="r num">{fmtQty(l.qty_confirmed)}</td>
                            <td className="r num">{fmtQty(l.qty_shipped)}</td>
                            <td className="r num">{fmtQty(l.qty_received)}</td>
                            <td className="r num">{Number(l.qty_cancelled) ? fmtQty(l.qty_cancelled) : '—'}</td>
                            <td className="r"><Money minor={l.line_total_minor} currency={o.currency} /></td>
                          </tr>
                        ))}
                      </tbody>
                      <tfoot><tr><td colSpan={6}>Итого (снимок цен при отправке)</td><td className="r"><Money minor={o.total_minor} currency={o.currency} /></td></tr></tfoot>
                    </table>
                  </div>
                </Card>
                <Card title="Доставка">
                  {ships.data?.length ? ships.data.map((s) => (
                    <div key={s.id} style={{ padding: '8px 0', borderTop: '1px solid var(--border)' }}>
                      <div className="row between">
                        <strong className="mono">{s.external_ref}</strong>
                        <Badge tone={s.status === 'delivered' ? 'success' : s.status === 'delayed' ? 'warning' : 'info'}>{{ in_transit: 'в пути', delayed: 'перенос', delivered: 'доставлено', lost: 'утеряно' }[s.status]}</Badge>
                      </div>
                      <div className="muted">{s.carrier} · трек {s.tracking}</div>
                      <div className="muted">Прогноз: {formatDate(s.eta_from, intlLocale())}–{formatDate(s.eta_to, intlLocale())}{s.promised_on ? ` · обещано ${formatDate(s.promised_on, intlLocale())}` : ' · прогноз не является обещанием'}</div>
                      <div className="faint">{s.shipment_line.map((sl) => { const l = lines.data?.find((x) => x.id === sl.line_id); return `${l?.name ?? ''}: ${fmtQty(sl.qty)}`; }).join('; ')}</div>
                    </div>
                  )) : <span className="muted">Отгрузок пока нет</span>}
                </Card>
                {can('integration.operate') && o.transfer_status === 'sent' && !['completed', 'cancelled'].includes(o.status) && (
                  <Card title="Статус на складе">
                    <p className="muted">Отметьте, что произошло с заказом на складе.</p>
                    <div className="row">
                      <Button size="sm" onClick={() => demo.mutate({ type: 'order.accepted', mode: 'full', eventId: null })}>Склад подтвердил</Button>
                      <Button size="sm" onClick={() => demo.mutate({ type: 'order.accepted', mode: 'partial', eventId: null })}>Подтвердил с дефицитом</Button>
                      <Button size="sm" onClick={() => demo.mutate({ type: 'shipment.created', mode: 'partial', eventId: null })}>Частичная отгрузка</Button>
                      <Button size="sm" onClick={() => demo.mutate({ type: 'shipment.created', mode: 'full', eventId: null })}>Отгрузить остаток</Button>
                      <Button size="sm" onClick={() => demo.mutate({ type: 'shipment.delayed', mode: 'full', eventId: null })}>Отмена рейса</Button>
                      <Button size="sm" onClick={() => demo.mutate({ type: 'shipment.delivered', mode: 'full', eventId: null })}>Доставлено</Button>
                    </div>
                    <ActionError error={demo.error} />
                  </Card>
                )}
              </div>
              <div className="stack">
                <Card title="Заказ">
                  <KV items={[
                    ['Точка', loc?.name], ['Вид', o.kind === 'supply_request' ? 'Заявка собственной точки' : 'Коммерческий заказ партнёра'],
                    ['Отправлен', formatDateTime(o.submitted_at, intlLocale())], ['Автор', names(o.created_by)],
                    ['Согласование', st(APPROVAL_STATUS, o.approval_status)[0]], ['Оплата', st(PAYMENT_STATUS_ORDER, o.payment_status)[0]],
                    ['Передача на склад', st(TRANSFER_STATUS, o.transfer_status)[0]],
                    [t('Адрес доставки'), o.delivery_address], [t('Контакт получателя'), o.contact], [t('Комментарий'), o.comment],
                    ...(o.repeated_from ? [['Повтор заказа', <Link key="r" to={`/orders/${o.repeated_from}`}>исходный</Link>] as [string, React.ReactNode]] : []),
                  ]} />
                </Card>
                <Card title="История">
                  <Timeline items={(ev.data ?? []).map((e) => ({ at: e.at, who: names(e.actor_id) ?? 'Склад / система', text: ORDER_EVENT[e.action] ?? e.action, comment: e.comment }))} />
                </Card>
              </div>
            </div>
            <ConfirmDialog
              open={dialog !== null}
              title={{ reject: 'Отклонить заявку', cancel: 'Отменить заказ', payment: 'Подтвердить оплату заказа', receive: 'Приёмка поставки' }[dialog ?? 'cancel']}
              confirmLabel={{ reject: 'Отклонить', cancel: 'Отменить заказ', payment: 'Подтвердить зачисление', receive: 'Сохранить приёмку' }[dialog ?? 'cancel']}
              danger={dialog === 'reject' || dialog === 'cancel'}
              busy={act.isPending} error={act.error}
              summary={dialog === 'payment' ? [['Заказ', o.number ?? ''], ['Сумма', <Money key="s" minor={o.total_minor} currency={o.currency} />]] : undefined}
              onClose={() => { setDialog(null); act.reset(); }}
              onConfirm={() => act.mutate(() => {
                if (dialog === 'reject') return orderCommands.reject(o.id, text);
                if (dialog === 'cancel') return orderCommands.cancel(o.id, text);
                if (dialog === 'payment') return orderCommands.paymentConfirm(o.id, text);
                return orderCommands.receive(o.id, (lines.data ?? []).filter((l) => Number(l.qty_shipped) > 0).map((l) => ({
                  line_id: l.id, qty_received: Number((recv[l.id] ?? String(l.qty_shipped)).replace(',', '.')), final,
                })), text || null);
              })}
            >
              {dialog === 'receive' ? (
                <>
                  <p className="muted">Укажите фактически полученное количество по строкам. Расхождение создаст задачу снабжению.</p>
                  {(lines.data ?? []).filter((l) => Number(l.qty_shipped) > 0).map((l) => (
                    <Field key={l.id} label={`${l.name} (отгружено ${fmtQty(l.qty_shipped)})`}>
                      {(fid) => <Input id={fid} inputMode="decimal" value={recv[l.id] ?? String(Number(l.qty_shipped))} onChange={(e) => setRecv((r) => ({ ...r, [l.id]: e.target.value }))} />}
                    </Field>
                  ))}
                  <Checkbox label="Это окончательная приёмка отгруженного" hint="Недостача по отгрузке станет расхождением" checked={final} onChange={setFinal} />
                  <Field label="Комментарий">{(fid) => <Textarea id={fid} rows={2} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
                </>
              ) : (
                <Field label={dialog === 'payment' ? 'Документ зачисления (выписка)' : 'Причина'} required
                  hint={dialog === 'payment' ? 'Скриншот партнёра не является подтверждением зачисления' : undefined}>
                  {(fid) => <Textarea id={fid} rows={2} value={text} onChange={(e) => setText(e.target.value)} />}
                </Field>
              )}
            </ConfirmDialog>
          </>
        );
      }}
    </DataState>
  );
}
