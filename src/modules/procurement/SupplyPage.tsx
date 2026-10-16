// «Поступления» для снабжения: что закончилось, сколько партнёров ждут и сколько уже заказано, когда придёт.
// Запланированная дата сразу видна партнёрам в магазине; отметка «Пришло» и «Объявить новинку» рассылают уведомления.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarPlus, Megaphone, PackageCheck, Users, X } from 'lucide-react';
import { formatDate } from '../../platform/dates';
import { intlLocale, useT } from '../../platform/i18n';
import { Badge, Button, Card, Chips, ConfirmDialog, DataState, EmptyState, Field, Input, PageHeader, Textarea } from '../../ui';
import { useToast } from '../../ui/toast';
import { stockBoard, supplyCommands, type BoardItem } from './api';
import { ProductMockup } from './Mockup';

type Filter = 'need' | 'waiting' | 'all';
type Dialog = { kind: 'plan' | 'announce'; item: BoardItem } | { kind: 'arrive' | 'cancel'; item: BoardItem; incoming: BoardItem['incoming'][number] };

const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

export function SupplyPage() {
  const { t } = useT();
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['stock-board'], queryFn: stockBoard });
  const [filter, setFilter] = useState<Filter>('need');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [qty, setQty] = useState('');
  const [date, setDate] = useState(plusDays(5));
  const [text, setText] = useState('');
  const open = (d: Dialog) => { setDialog(d); setQty(d.kind === 'arrive' ? String(d.incoming.qty) : ''); setDate(plusDays(5)); setText(''); act.reset(); };
  const act = useMutation({
    mutationFn: async () => {
      const d = dialog!;
      if (d.kind === 'plan') { await supplyCommands.plan(d.item.id, Number(qty.replace(',', '.')), date, text || null); return 'Поступление запланировано. Партнёры видят дату в магазине'; }
      if (d.kind === 'arrive') { await supplyCommands.arrive(d.incoming.id, qty ? Number(qty.replace(',', '.')) : null); return 'Приход отмечен. Ожидавшие партнёры получили уведомление'; }
      if (d.kind === 'cancel') { await supplyCommands.cancel(d.incoming.id, text); return 'Поступление отменено, ожидавшие предупреждены'; }
      await supplyCommands.announce(d.item.id, text || null);
      return 'Новинка объявлена всем, кто заказывает';
    },
    onSuccess: (msg) => { toast(msg); setDialog(null); void qc.invalidateQueries({ queryKey: ['stock-board'] }); void qc.invalidateQueries({ queryKey: ['catalog'] }); },
  });

  return (
    <>
      <PageHeader title={t('Поступления')} sub="Остатки, ожидаемые поставки и новинки: партнёры видят даты в магазине и получают уведомления" />
      <div style={{ marginBottom: 16 }}>
        <Chips label="Фильтр" value={filter} onChange={setFilter} options={[
          { id: 'need', label: 'Нет в наличии или мало' }, { id: 'waiting', label: 'Ждут партнёры' }, { id: 'all', label: 'Все товары' }]} />
      </div>
      <DataState query={q}>
        {(items) => {
          const list = items.filter((i) => filter === 'all' || (filter === 'waiting' ? i.waiting > 0 || i.backlog_qty > 0 : Number(i.available_qty) < 20));
          if (!list.length) return <Card><EmptyState title="Всё в наличии" text="Нет товаров, которые закончились или которых ждут партнёры." /></Card>;
          return (
            <div className="stack">
              {list.map((i) => {
                const avail = Number(i.available_qty);
                return (
                  <div key={i.id} className="card supply-row">
                    <div className="supply-media"><ProductMockup visual={i.visual} seed={i.sku} /></div>
                    <div className="supply-main">
                      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                        <strong>{i.name}</strong>
                        <span className="faint">{t('Артикул')} {i.article_no ?? i.sku} · {i.subtitle ?? i.category}</span>
                        {i.published_at && new Date(i.published_at).getTime() > Date.now() - 14 * 864e5 && <Badge tone="info" icon={false}>{t('Новинка')}</Badge>}
                      </div>
                      <div className="supply-stats">
                        <span className={avail <= 0 ? 'bad' : avail < 20 ? 'warn' : ''}>{t('Остаток')}: <strong>{avail.toLocaleString('ru-RU')}</strong></span>
                        <span title={t('Нажали «Сообщить о поступлении»')}><Users size={14} aria-hidden /> {t('Ждут')}: <strong>{i.waiting}</strong></span>
                        <span title={t('Заказано, но склад ещё не подтвердил')}>{t('В заказах')}: <strong>{Number(i.backlog_qty).toLocaleString('ru-RU')}</strong></span>
                        {i.last_arrival && <span className="faint">{t('Последний приход')} {formatDate(i.last_arrival, intlLocale())}</span>}
                      </div>
                      {i.incoming.length > 0 && (
                        <ul className="supply-incoming">
                          {i.incoming.map((r) => (
                            <li key={r.id}>
                              <span><CalendarPlus size={14} aria-hidden /> {formatDate(r.expected_on, intlLocale())} · {Number(r.qty).toLocaleString('ru-RU')} {t('шт.')}{r.note ? ` · ${r.note}` : ''}</span>
                              <span className="row">
                                <Button size="sm" variant="primary" onClick={() => open({ kind: 'arrive', item: i, incoming: r })}><PackageCheck size={14} aria-hidden />{t('Пришло')}</Button>
                                <button type="button" className="icon-btn" aria-label={t('Отменить поступление')} onClick={() => open({ kind: 'cancel', item: i, incoming: r })}><X size={16} /></button>
                              </span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <div className="supply-actions">
                      <Button size="sm" onClick={() => open({ kind: 'plan', item: i })}><CalendarPlus size={14} aria-hidden />{t('Запланировать поставку')}</Button>
                      <Button size="sm" variant="ghost" onClick={() => open({ kind: 'announce', item: i })}><Megaphone size={14} aria-hidden />{t('Объявить новинку')}</Button>
                    </div>
                  </div>
                );
              })}
              <p className="faint">{t('Остатки обновляются со склада. Когда ожидаемый товар поступит, придёт уведомление.')}</p>
            </div>
          );
        }}
      </DataState>
      <ConfirmDialog open={Boolean(dialog)} busy={act.isPending} error={act.error}
        title={dialog ? { plan: 'Запланировать поставку', arrive: 'Отметить приход', cancel: 'Отменить поступление', announce: 'Объявить новинку' }[dialog.kind] : ''}
        confirmLabel={dialog ? { plan: 'Запланировать', arrive: 'Пришло на склад', cancel: 'Отменить поступление', announce: 'Отправить партнёрам' }[dialog.kind] : ''}
        danger={dialog?.kind === 'cancel'}
        disabled={(dialog?.kind === 'plan' && !(Number(qty.replace(',', '.')) > 0)) || (dialog?.kind === 'cancel' && !text.trim())}
        onClose={() => setDialog(null)} onConfirm={() => act.mutate()}
        summary={dialog ? [['Товар', dialog.item.name], ...(dialog.item.waiting ? [['Ждут партнёров', String(dialog.item.waiting)] as [string, string]] : [])] : undefined}>
        {dialog?.kind === 'plan' && <>
          <div className="grid grid-2">
            <Field label="Количество" required>{(id) => <Input id={id} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />}</Field>
            <Field label="Ожидаемая дата" required>{(id) => <Input id={id} type="date" value={date} min={plusDays(0)} onChange={(e) => setDate(e.target.value)} />}</Field>
          </div>
          <Field label="Комментарий для партнёров" hint="Например: партия из Китая">{(id) => <Input id={id} value={text} onChange={(e) => setText(e.target.value)} />}</Field>
        </>}
        {dialog?.kind === 'arrive' && <Field label="Сколько пришло" hint="Если пришло меньше или больше плана — укажите факт">{(id) => <Input id={id} inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} />}</Field>}
        {dialog?.kind === 'cancel' && <Field label="Причина — её увидят ожидающие партнёры" required>{(id) => <Textarea id={id} rows={2} value={text} onChange={(e) => setText(e.target.value)} />}</Field>}
        {dialog?.kind === 'announce' && <Field label="Текст уведомления" hint="Получат все франчайзи и управляющие">{(id) => <Textarea id={id} rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Например: новая коллекция камуфляжа уже на складе')} />}</Field>}
      </ConfirmDialog>
    </>
  );
}
