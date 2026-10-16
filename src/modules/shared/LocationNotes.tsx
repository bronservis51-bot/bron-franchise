// Заметки к точке: короткие записи «чтобы не забыть» с необязательным напоминанием.
// Сотрудник компании может оставить заметку только для своих (франчайзи её не увидит); напоминание придёт в «Нужно сделать».
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Check, Lock, StickyNote, Trash2 } from 'lucide-react';
import { command, from, rows } from '../../platform/backend';
import { useSession } from '../../platform/session';
import { formatDate } from '../../platform/dates';
import { intlLocale, useT } from '../../platform/i18n';
import { ActionError, Button } from '../../ui';
import { useUserNames } from './lookups';

export interface LocationNote { id: string; location_id: string; author_id: string; body: string; internal: boolean; remind_on: string | null; done_at: string | null; created_at: string }

const plusDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

export function LocationNotes({ locationId, compact }: { locationId: string; compact?: boolean }) {
  const { t } = useT();
  const { me, isStaff } = useSession();
  const qc = useQueryClient();
  const names = useUserNames();
  const key = ['notes', locationId];
  const q = useQuery({ queryKey: key, queryFn: () => rows<LocationNote>(from('location_note').select('*').eq('location_id', locationId).order('created_at', { ascending: false }).limit(30)) });
  const [body, setBody] = useState('');
  const [remind, setRemind] = useState<string | null>(null);
  const [internal, setInternal] = useState(true);
  const [open, setOpen] = useState(false);
  const refresh = () => { void qc.invalidateQueries({ queryKey: key }); void qc.invalidateQueries({ queryKey: ['today'] }); };
  const add = useMutation({
    mutationFn: () => command('location_note_add', { location: locationId, body, remind_on: remind, internal: isStaff && internal }),
    onSuccess: () => { setBody(''); setRemind(null); setOpen(false); refresh(); },
  });
  const done = useMutation({ mutationFn: (n: LocationNote) => command('location_note_done', { note: n.id, done: !n.done_at }), onSuccess: refresh });
  const del = useMutation({ mutationFn: (id: string) => command('location_note_delete', { note: id }), onSuccess: refresh });
  const notes = (q.data ?? []).slice(0, compact ? 5 : 30);

  return (
    <section className="notes">
      <div className="notes-head">
        <h3><StickyNote size={16} aria-hidden /> {t('Заметки')}</h3>
        {!open && <button type="button" className="link-btn dark" onClick={() => setOpen(true)}>+ {t('Добавить')}</button>}
      </div>
      {open && (
        <div className="note-form">
          <textarea className="textarea" rows={3} autoFocus value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000}
            placeholder={t('Например: у партнёра проблема с арендой, решит к 20-му — после этого позвонить')} aria-label={t('Текст заметки')} />
          <div className="note-options">
            <span className="faint"><Bell size={14} aria-hidden /> {t('Напомнить')}:</span>
            {[['Нет', null], ['Завтра', plusDays(1)], ['Через 3 дня', plusDays(3)], ['Через неделю', plusDays(7)]].map(([l, v]) => (
              <button key={String(l)} type="button" className="chip" aria-pressed={remind === v} onClick={() => setRemind(v)}>{t(String(l))}</button>
            ))}
            <input type="date" className="input note-date" aria-label={t('Дата напоминания')} min={plusDays(0)} value={remind ?? ''} onChange={(e) => setRemind(e.target.value || null)} />
          </div>
          {isStaff && (
            <label className="note-private">
              <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} />{t('Только для сотрудников компании (франчайзи не увидит)')}
            </label>
          )}
          <div className="row" style={{ gap: 8 }}>
            <Button variant="primary" size="sm" disabled={!body.trim()} loading={add.isPending} onClick={() => add.mutate()}>{t('Сохранить')}</Button>
            <Button size="sm" variant="ghost" onClick={() => { setOpen(false); setBody(''); }}>{t('Отмена')}</Button>
          </div>
          <ActionError error={add.error} />
        </div>
      )}
      {!notes.length && !open && <p className="faint" style={{ margin: 0 }}>{t('Пока пусто. Запишите, что важно помнить об этой точке.')}</p>}
      <ul className="note-list">
        {notes.map((n) => {
          const mine = n.author_id === me?.user.id;
          const due = n.remind_on && !n.done_at && n.remind_on <= new Date().toISOString().slice(0, 10);
          return (
            <li key={n.id} className={`note${n.done_at ? ' done' : ''}${due ? ' due' : ''}`}>
              <div className="note-body">{n.body}</div>
              <div className="note-meta">
                <span>{mine ? t('Вы') : names(n.author_id)}</span>
                <span>{formatDate(n.created_at, intlLocale())}</span>
                {n.internal && <span title={t('Видят только сотрудники компании')}><Lock size={12} aria-hidden /> {t('для своих')}</span>}
                {n.remind_on && <span className="note-remind"><Bell size={12} aria-hidden /> {formatDate(n.remind_on, intlLocale())}</span>}
                {mine && n.remind_on && (
                  <button type="button" className="note-act" onClick={() => done.mutate(n)}><Check size={13} aria-hidden /> {n.done_at ? t('Вернуть') : t('Сделано')}</button>
                )}
                {mine && <button type="button" className="note-act" aria-label={t('Удалить заметку')} onClick={() => del.mutate(n.id)}><Trash2 size={13} aria-hidden /></button>}
              </div>
            </li>
          );
        })}
      </ul>
      <ActionError error={done.error ?? del.error} />
    </section>
  );
}
