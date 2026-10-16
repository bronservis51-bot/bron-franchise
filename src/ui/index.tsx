// Компоненты дизайн-системы. Состояния экранов (UX-05): загрузка, пусто, нет результатов, ошибка, нет прав, офлайн, конфликт.
import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ComponentProps, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, ArrowLeft, Ban, CheckCircle2, CircleDashed, Clock, FlaskConical, Inbox, Info, Lock, RefreshCw, SearchX, WifiOff } from 'lucide-react';
import { AppError, toAppError } from '../platform/backend';
import { dueInfo, formatDateTime } from '../platform/dates';
import { formatMoney, formatMoneyShort, minorToDecimal, parseMoney, type MinorInput } from '../platform/money';
import { intlLocale, t as tr, useT } from '../platform/i18n';

/** Строковые подписи компонентов переводятся автоматически (RU/TR, SUP-08); узлы React — как есть. */
const tx = (n: ReactNode): ReactNode => (typeof n === 'string' ? tr(n) : n);

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'demo';

export function Button({ variant = 'secondary', size, loading, block, children, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'silver'; size?: 'sm'; loading?: boolean; block?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      className={['btn', `btn-${variant}`, size === 'sm' && 'btn-sm', block && 'btn-block', rest.className].filter(Boolean).join(' ')}
      disabled={rest.disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading && <span className="spinner" aria-hidden />}
      {Array.isArray(children) ? children.map((c) => tx(c)) : tx(children)}
    </button>
  );
}

export function LinkButton({ to, variant = 'secondary', size, children }: { to: string; variant?: 'primary' | 'secondary' | 'ghost' | 'silver'; size?: 'sm'; children: ReactNode }) {
  return <Link to={to} className={['btn', `btn-${variant}`, size === 'sm' && 'btn-sm'].filter(Boolean).join(' ')}>{Array.isArray(children) ? children.map((c) => tx(c)) : tx(children)}</Link>;
}

export function Card({ title, actions, children, className, bodyless, icon, iconTone }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyless?: boolean; icon?: ReactNode; iconTone?: 'silver' | 'dark' | 'danger' }) {
  return (
    <section className={['card', className].filter(Boolean).join(' ')}>
      {(title || actions) && (
        <div className="card-header">
          {typeof title === 'string'
            ? <h2 className="card-title">{icon && <span className={`icon-tile${iconTone && iconTone !== 'silver' ? ` ${iconTone}` : ''}`} aria-hidden>{icon}</span>}{tr(title)}</h2>
            : title}
          {actions && <div className="row">{actions}</div>}
        </div>
      )}
      {bodyless ? children : <div className="card-body">{children}</div>}
    </section>
  );
}

const TONE_ICON: Record<Tone, ReactNode> = {
  neutral: <CircleDashed size={13} aria-hidden />,
  info: <Info size={13} aria-hidden />,
  success: <CheckCircle2 size={13} aria-hidden />,
  warning: <Clock size={13} aria-hidden />,
  danger: <AlertTriangle size={13} aria-hidden />,
  demo: <FlaskConical size={13} aria-hidden />,
};

export function Badge({ tone = 'neutral', children, icon = true, title }: { tone?: Tone; children: ReactNode; icon?: boolean; title?: string }) {
  return <span className={`badge tone-${tone}`} title={title}>{icon && TONE_ICON[tone]}{tx(children)}</span>;
}

export function DemoBadge({ label = 'Демо' }: { label?: string }) {
  const { t } = useT();
  return <Badge tone="demo" title="Демонстрационный режим: не является реальной операцией">{t(label)}</Badge>;
}

export function PageHeader({ title, sub, actions, back }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; back?: { to: string; label: string } }) {
  return (
    <header className="page-header">
      <div style={{ minWidth: 0 }}>
        {back && <Link className="back-link" to={back.to}><ArrowLeft size={15} aria-hidden />{tr(back.label)}</Link>}
        <h1>{tx(title)}</h1>
        {sub && <div className="sub">{tx(sub)}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function EmptyState({ title, text, action, icon }: { title: string; text?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="state" role="status">
      <div className="icon">{icon ?? <Inbox size={22} aria-hidden />}</div>
      <h3>{tr(title)}</h3>
      {text && <div>{tx(text)}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

export function NoResults({ query, action }: { query?: string; action?: ReactNode }) {
  return <EmptyState icon={<SearchX size={22} aria-hidden />} title="Ничего не найдено" text={query ? tr('По запросу «{{q}}» результатов нет. Уточните запрос.', { q: query }) : 'Измените фильтры.'} action={action} />;
}

const ERROR_TEXT: Record<string, string> = {
  forbidden: 'Недостаточно прав для этого действия или раздела.',
  'not-found': 'Объект не найден или у вас нет к нему доступа.',
  'version-conflict': 'Данные изменились, пока вы работали. Обновите карточку — мы покажем актуальное состояние.',
  'transition-not-allowed': 'Действие недоступно в текущем состоянии.',
  offline: 'Нет связи с сервером. Данные не отправлены.',
  unauthenticated: 'Сессия истекла. Войдите снова.',
  'external-unavailable': 'Сервер недоступен. Попробуйте ещё раз.',
  'idempotency-conflict': 'Эта операция уже выполнялась с другими данными.',
};

export function errorText(e: unknown): string {
  const err = toAppError(e);
  // Сервер возвращает понятное объяснение в detail; общий текст — только если его нет
  const base = err.code === 'unknown' ? err.detail : err.detail || ERROR_TEXT[err.code];
  return base || 'Не удалось выполнить действие';
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const err = toAppError(error);
  const icon = err.code === 'offline' ? <WifiOff size={22} aria-hidden /> : err.code === 'forbidden' ? <Lock size={22} aria-hidden /> : <Ban size={22} aria-hidden />;
  return (
    <div className={`state${compact ? ' compact' : ''}`} role="alert">
      <div className="icon">{icon}</div>
      <h3>{tr(err.code === 'forbidden' ? 'Нет доступа' : err.code === 'not-found' ? 'Не найдено' : 'Не удалось загрузить')}</h3>
      <div>{tr(errorText(err))}</div>
      {err.requestId && err.code !== 'forbidden' && err.code !== 'not-found' && <div className="faint">{tr('Код запроса')}: <span className="mono">{err.requestId.slice(0, 8)}</span></div>}
      {onRetry && <Button size="sm" onClick={onRetry}><RefreshCw size={15} aria-hidden />Повторить</Button>}
    </div>
  );
}

/** Ошибка действия рядом с кнопкой; детали валидации показываются у полей самой формой. */
export function ActionError({ error }: { error: unknown }) {
  if (!error) return null;
  const err = error instanceof AppError ? error : toAppError(error);
  return (
    <div className="alert tone-danger" role="alert" style={{ marginTop: 12 }}>
      <AlertTriangle size={18} aria-hidden />
      <div className="alert-body">
        <div>{tr(errorText(err))}</div>
        {err.hint && err.code === 'transition-not-allowed' && err.hint.length < 600 && <div className="faint" style={{ marginTop: 4 }}>{err.hint}</div>}
        {err.code === 'version-conflict' && <div className="faint">Ваши изменения не потеряны: обновите и повторите.</div>}
      </div>
    </div>
  );
}

export function Alert({ tone = 'info', title, children, action }: { tone?: Tone; title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`alert tone-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {TONE_ICON[tone]}
      <div className="alert-body">
        {title && <div style={{ fontWeight: 650 }}>{tr(title)}</div>}
        {tx(children)}
      </div>
      {action}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div aria-busy="true" aria-label="Загрузка" style={{ padding: 20 }}>
      {Array.from({ length: lines }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 14, width: `${90 - i * 12}%`, marginBottom: 12 }} />
      ))}
    </div>
  );
}

/** Универсальная обёртка состояния запроса. */
export function DataState<T>({ query, empty, children, skeleton = 3 }: {
  query: { data: T | undefined; isLoading: boolean; error: unknown; refetch: () => unknown };
  empty?: (data: T) => ReactNode | null;
  children: (data: T) => ReactNode;
  skeleton?: number;
}) {
  if (query.isLoading) return <Skeleton lines={skeleton} />;
  if (query.error) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (query.data === undefined) return null;
  const e = empty?.(query.data);
  if (e) return <>{e}</>;
  return <>{children(query.data)}</>;
}

export function Field({ label, hint, error, required, children, id }: { label: string; hint?: ReactNode; error?: string | null; required?: boolean; children: (id: string, describedBy?: string) => ReactNode; id?: string }) {
  const auto = useId();
  const fid = id ?? auto;
  const hintId = hint ? `${fid}-hint` : undefined;
  const errId = error ? `${fid}-err` : undefined;
  return (
    <div className="field">
      <label htmlFor={fid}>{tr(label)}{required && <span className="req" aria-hidden>*</span>}</label>
      {children(fid, [hintId, errId].filter(Boolean).join(' ') || undefined)}
      {hint && <div className="hint" id={hintId}>{tx(hint)}</div>}
      {error && <div className="error" id={errId}><AlertTriangle size={14} aria-hidden />{tr(error)}</div>}
    </div>
  );
}

export const Input = (p: ComponentProps<'input'>) => <input {...p} className={['input', p.className].filter(Boolean).join(' ')} />;
export const Textarea = (p: ComponentProps<'textarea'>) => <textarea {...p} className={['textarea', p.className].filter(Boolean).join(' ')} />;
export const Select = (p: ComponentProps<'select'>) => <select {...p} className={['select', p.className].filter(Boolean).join(' ')} />;

export function Checkbox({ label, checked, onChange, hint }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; hint?: ReactNode }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{tx(label)}{hint && <span className="faint" style={{ display: 'block' }}>{tx(hint)}</span>}</span>
    </label>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.id} role="tab" type="button" aria-selected={t.id === value} onClick={() => onChange(t.id)}>{tx(t.label)}</button>
      ))}
    </div>
  );
}

export function Chips<T extends string>({ options, value, onChange, label }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" className="chip" aria-pressed={o.id === value} onClick={() => onChange(o.id)}>{tr(o.label)}</button>
      ))}
    </div>
  );
}

export function Money({ minor, currency, strong, short }: { minor: MinorInput; currency: string; strong?: boolean; short?: boolean }) {
  const s = (short ? formatMoneyShort : formatMoney)(minor, currency, intlLocale());
  return strong ? <strong className="num">{s}</strong> : <span className="num">{s}</span>;
}

/** Ввод суммы в рублях/тенге/лирах с запятой; наружу — минорные единицы строкой (без float). */
export function MoneyInput({ id, value, onChange, currency, invalid, placeholder, inputRef, onEnter }: {
  id: string; value: string; onChange: (minor: string) => void; currency: string; invalid?: boolean; placeholder?: string;
  inputRef?: (el: HTMLInputElement | null) => void; onEnter?: () => void;
}) {
  const show = (v: string) => (v && v !== '0' ? minorToDecimal(v, currency).replace('.', ',').replace(/,00$/, '') : '');
  const [text, setText] = useState(() => show(value));
  const [bad, setBad] = useState(false);
  // Значение изменили снаружи (например, «Заполнить из смен») — показать его, не трогая ввод, который уже ему равен
  useEffect(() => {
    const cur = text.trim() === '' ? 0n : parseMoney(text, currency);
    if (cur === null || cur.toString() !== (value || '0')) { setText(show(value)); setBad(false); }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Input id={id} ref={inputRef} inputMode="decimal" enterKeyHint={onEnter ? 'done' : undefined} placeholder={placeholder} value={text} aria-invalid={bad || invalid || undefined}
      onKeyDown={onEnter ? (e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } } : undefined}
      onChange={(e) => {
        setText(e.target.value);
        const v = e.target.value.trim() === '' ? 0n : parseMoney(e.target.value, currency);
        setBad(v === null);
        if (v !== null) onChange(v.toString());
      }} />
  );
}

export function Due({ at, done, timeZone }: { at: string | null | undefined; done?: boolean; timeZone?: string }) {
  if (!at) return <span className="faint">{tr('без срока')}</span>;
  const info = dueInfo(at);
  if (done) return <span className="faint">{formatDateTime(at, intlLocale(), timeZone)}</span>;
  return (
    <span title={formatDateTime(at, intlLocale(), timeZone) + (timeZone ? ` (${timeZone})` : '')}>
      <Badge tone={info.tone === 'neutral' ? 'neutral' : info.tone} icon={info.tone !== 'neutral'}>{info.label}</Badge>
    </span>
  );
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}><dt>{tx(k)}</dt><dd>{v ?? '—'}</dd></div>
      ))}
    </dl>
  );
}

export interface TimelineItem { at: string; who?: string | null; text: ReactNode; comment?: string | null }
export function Timeline({ items }: { items: TimelineItem[] }) {
  if (!items.length) return <div className="faint">{tr('История пуста')}</div>;
  return (
    <ol className="timeline">
      {items.map((i, n) => (
        <li key={n}>
          <div>{tx(i.text)}{i.who && <span className="muted"> · {i.who}</span>}</div>
          {i.comment && <div className="muted" style={{ fontSize: 'var(--fs-s)' }}>{i.comment}</div>}
          <div className="when">{formatDateTime(i.at, intlLocale())}</div>
        </li>
      ))}
    </ol>
  );
}

/** Подтверждение необратимого/финансового действия с итогом операции (UX-06). */
export function ConfirmDialog({ open, title, summary, confirmLabel, danger, onConfirm, onClose, children, busy, error, disabled }: {
  open: boolean; title: string; summary?: [string, ReactNode][]; confirmLabel: string; danger?: boolean;
  onConfirm: () => void; onClose: () => void; children?: ReactNode; busy?: boolean; error?: unknown; disabled?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="dlg-title">
      <div className="dialog-head"><h2 id="dlg-title">{tr(title)}</h2></div>
      <div className="dialog-body">
        {summary && (
          <div className="summary"><dl>{summary.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{tr(k)}</dt><dd>{tx(v)}</dd></div>)}</dl></div>
        )}
        {children && <div style={{ marginTop: summary ? 16 : 0 }}>{children}</div>}
        <ActionError error={error} />
      </div>
      <div className="dialog-foot">
        <Button onClick={onClose} disabled={busy}>Отмена</Button>
        <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy} disabled={disabled}>{tr(confirmLabel)}</Button>
      </div>
    </dialog>
  );
}

export function Progress({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div>
      <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}><span style={{ width: `${pct}%` }} /></div>
      <div className="faint" style={{ marginTop: 4 }}>{tr(label)}: {value} / {max}</div>
    </div>
  );
}

/** Подтверждение «успех отражает фактический результат» (UX-05): компонент показывает, что именно сохранено. */
export function useFlash() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const id = setTimeout(() => setMsg(null), 5000);
    return () => clearTimeout(id);
  }, [msg]);
  return [msg, setMsg] as const;
}
