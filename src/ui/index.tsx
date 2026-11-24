// Компоненты дизайн-системы. Состояния экранов: загрузка, пусто, нет результатов, ошибка, нет прав, офлайн, конфликт.
import { useEffect, useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Link } from 'react-router';
import { AlertTriangle, ArrowLeft, Ban, CheckCircle2, CircleDashed, Clock, FlaskConical, Inbox, Info, Lock, RefreshCw, SearchX, WifiOff } from 'lucide-react';
import { useLocale, type Language } from '../platform/locale';
import { AppError, toAppError } from '../platform/backend';
import { formatMoney, formatMoneyShort, minorToDecimal, parseMoney, type MinorInput } from '../platform/money';
import { HelpTip } from './HelpTip';

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'demo';

export function Button({ variant = 'secondary', size, loading, block, children, ...rest }:
  ComponentProps<'button'> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'silver'; size?: 'sm'; loading?: boolean; block?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      className={['btn', `btn-${variant}`, size === 'sm' && 'btn-sm', block && 'btn-block', rest.className].filter(Boolean).join(' ')}
      disabled={rest.disabled || loading}
      aria-busy={loading || undefined}
    >
      {loading && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
}

export function LinkButton({ to, variant = 'secondary', size, children }: { to: string; variant?: 'primary' | 'secondary' | 'ghost' | 'silver'; size?: 'sm'; children: ReactNode }) {
  return <Link to={to} className={['btn', `btn-${variant}`, size === 'sm' && 'btn-sm'].filter(Boolean).join(' ')}>{children}</Link>;
}

export function Card({ title, actions, children, className, bodyless, icon, iconTone }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyless?: boolean; icon?: ReactNode; iconTone?: 'silver' | 'dark' | 'danger' }) {
  return (
    <section className={['card', className].filter(Boolean).join(' ')}>
      {(title || actions) && (
        <div className="card-header">
          {typeof title === 'string'
            ? <h2 className="card-title">{icon && <span className={`icon-tile${iconTone && iconTone !== 'silver' ? ` ${iconTone}` : ''}`} aria-hidden>{icon}</span>}{title}</h2>
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
  return <span className={`badge tone-${tone}`} title={title}>{icon && TONE_ICON[tone]}{children}</span>;
}

export function PageHeader({ title, sub, actions, back }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; back?: { to: string; label: string } }) {
  return (
    <header className="page-header">
      <div style={{ minWidth: 0 }}>
        {back && <Link className="back-link" to={back.to}><ArrowLeft size={15} aria-hidden />{back.label}</Link>}
        <h1>{title}</h1>
        {sub && <div className="sub">{sub}</div>}
      </div>
      {actions && <div className="actions">{actions}</div>}
    </header>
  );
}

export function EmptyState({ title, text, action, icon }: { title: string; text?: ReactNode; action?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="state" role="status">
      <div className="icon">{icon ?? <Inbox size={22} aria-hidden />}</div>
      <h3>{title}</h3>
      {text && <div>{text}</div>}
      {action && <div style={{ marginTop: 8 }}>{action}</div>}
    </div>
  );
}

export function NoResults({ query, action }: { query?: string; action?: ReactNode }) {
  return <EmptyState icon={<SearchX size={22} aria-hidden />} title="Ничего не найдено" text={query ? `По запросу «${query}» результатов нет. Уточните запрос.` : 'Измените фильтры.'} action={action} />;
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

const TURKISH_ERRORS: Record<string, string> = {
  forbidden: 'Bu işlemi yapmak veya bu bölümü açmak için yetkiniz yok.',
  'not-found': 'Kayıt bulunamadı veya erişiminiz yok.',
  'version-conflict': 'Kayıt değişti. Güncel bilgileri kontrol edip yeniden deneyin.',
  'transition-not-allowed': 'Bu işlem şu an yapılamıyor.',
  offline: 'Sunucuyla bağlantı yok. Veriler gönderilmedi.',
  unauthenticated: 'Oturumunuz sona erdi. Yeniden giriş yapın.',
  'external-unavailable': 'Sunucuya ulaşılamıyor. Daha sonra yeniden deneyin.',
  'idempotency-conflict': 'Bu işlem daha önce farklı bilgilerle yapıldı.',
  'period-locked': 'Bu dönem değişikliklere kapalı.',
  validation: 'Girdiğiniz bilgileri kontrol edin.',
  'policy-split-required': 'Bu işlem için kalemleri ayrı ayrı kaydedin.',
  'integration-pending': 'İşlem hâlâ sürüyor. Biraz sonra yeniden kontrol edin.',
  maintenance: 'Geçici bakım yapılıyor. Daha sonra yeniden deneyin.',
};

export function errorText(e: unknown, language: Language = 'ru'): string {
  const err = toAppError(e);
  if (language === 'tr') {
    return err.detail && !/\p{Script=Cyrillic}/u.test(err.detail) ? err.detail
      : TURKISH_ERRORS[err.code] ?? 'İşlem tamamlanamadı.';
  }
  // Сервер возвращает понятное объяснение в detail; общий текст — только если его нет
  const base = err.code === 'unknown' ? err.detail : err.detail || ERROR_TEXT[err.code];
  return base || 'Не удалось выполнить действие';
}

export function ErrorState({ error, onRetry, compact }: { error: unknown; onRetry?: () => void; compact?: boolean }) {
  const { t, language } = useLocale();
  const err = toAppError(error);
  const icon = err.code === 'offline' ? <WifiOff size={22} aria-hidden /> : err.code === 'forbidden' ? <Lock size={22} aria-hidden /> : <Ban size={22} aria-hidden />;
  return (
    <div className={`state${compact ? ' compact' : ''}`} role="alert">
      <div className="icon">{icon}</div>
      <h3>{err.code === 'forbidden' ? t('Нет доступа', 'Erişim yok') : err.code === 'not-found' ? t('Не найдено', 'Bulunamadı') : t('Не удалось загрузить', 'Yüklenemedi')}</h3>
      <div>{errorText(err, language)}</div>
      {err.requestId && err.code !== 'forbidden' && err.code !== 'not-found' && <div className="faint">{t('Код запроса', 'İstek kodu')}: <span className="mono">{err.requestId.slice(0, 8)}</span></div>}
      {onRetry && <Button size="sm" onClick={onRetry}><RefreshCw size={15} aria-hidden />{t('Повторить', 'Yeniden dene')}</Button>}
    </div>
  );
}

/** Ошибка действия рядом с кнопкой; детали валидации показываются у полей самой формой. */
export function ActionError({ error }: { error: unknown }) {
  const { t, language } = useLocale();
  if (!error) return null;
  const err = error instanceof AppError ? error : toAppError(error);
  return (
    <div className="alert tone-danger" role="alert" style={{ marginTop: 12 }}>
      <AlertTriangle size={18} aria-hidden />
      <div className="alert-body">
        <div>{errorText(err, language)}</div>
        {err.hint && err.code === 'transition-not-allowed' && err.hint.length < 600 && (language === 'ru' || !/\p{Script=Cyrillic}/u.test(err.hint)) && <div className="faint" style={{ marginTop: 4 }}>{err.hint}</div>}
        {err.code === 'version-conflict' && <div className="faint">{t('Ваши изменения не потеряны: обновите и повторите.', 'Değişiklikleriniz duruyor. Kaydı yenileyip tekrar deneyin.')}</div>}
      </div>
    </div>
  );
}

export function Alert({ tone = 'info', title, children, action }: { tone?: Tone; title?: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={`alert tone-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {TONE_ICON[tone]}
      <div className="alert-body">
        {title && <div style={{ fontWeight: 650 }}>{title}</div>}
        {children}
      </div>
      {action}
    </div>
  );
}

export function Skeleton({ lines = 3 }: { lines?: number }) {
  const { t } = useLocale();
  return (
    <div aria-busy="true" aria-label={t('Загрузка', 'Yükleniyor')} style={{ padding: 20 }}>
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
  const { t, language } = useLocale();
  if (query.isLoading) return <Skeleton lines={skeleton} />;
  if (query.error && (query.data === undefined || ['unauthenticated', 'forbidden'].includes(toAppError(query.error).code))) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  if (query.data === undefined) return null;
  const e = empty?.(query.data);
  if (e) return <>{e}</>;
  return <>{query.error && <Alert tone="warning" title={t('Не удалось обновить данные', 'Veriler güncellenemedi')} action={<Button size="sm" onClick={() => void query.refetch()}>{t('Повторить', 'Yeniden dene')}</Button>}>{t('Показаны последние загруженные данные.', 'Son yüklenen veriler gösteriliyor.')} {errorText(query.error, language)}</Alert>}{children(query.data)}</>;
}

export function Field({ label, hint, error, required, help, helpLabel, children, id }: {
  label: string; hint?: ReactNode; error?: string | null; required?: boolean; help?: ReactNode; helpLabel?: string;
  children: (id: string, describedBy?: string) => ReactNode; id?: string;
}) {
  const auto = useId();
  const fid = id ?? auto;
  const hintId = hint ? `${fid}-hint` : undefined;
  const errId = error ? `${fid}-err` : undefined;
  const labelElement = <label htmlFor={fid}>{label}{required && <span className="req" aria-hidden>*</span>}</label>;
  return (
    <div className="field">
      {help ? <div className="field-heading">{labelElement}<HelpTip label={helpLabel ?? label}>{help}</HelpTip></div> : labelElement}
      {children(fid, [hintId, errId].filter(Boolean).join(' ') || undefined)}
      {hint && <div className="hint" id={hintId}>{hint}</div>}
      {error && <div className="error" id={errId}><AlertTriangle size={14} aria-hidden />{error}</div>}
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
      <span>{label}{hint && <span className="faint" style={{ display: 'block' }}>{hint}</span>}</span>
    </label>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((t) => (
        <button key={t.id} role="tab" type="button" aria-selected={t.id === value} onClick={() => onChange(t.id)}>{t.label}</button>
      ))}
    </div>
  );
}

export function Chips<T extends string>({ options, value, onChange, label }: { options: { id: T; label: string }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div className="chips" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} type="button" className="chip" aria-pressed={o.id === value} onClick={() => onChange(o.id)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Money({ minor, currency, strong, short }: { minor: MinorInput; currency: string; strong?: boolean; short?: boolean }) {
  const { locale } = useLocale();
  const s = (short ? formatMoneyShort : formatMoney)(minor, currency, locale);
  return strong ? <strong className="num">{s}</strong> : <span className="num">{s}</span>;
}

/** Ввод суммы в рублях/тенге/лирах с запятой; наружу — минорные единицы строкой (без float). */
export function MoneyInput({ id, value, onChange, currency, invalid, placeholder, inputRef, onEnter, enterKeyHint = 'done', onValidityChange, describedBy, requireExplicitValue = false, preserveBlank = false, disabled }: {
  id: string; value: string; onChange: (minor: string) => void; currency: string; invalid?: boolean; placeholder?: string;
  inputRef?: (el: HTMLInputElement | null) => void; onEnter?: () => void; enterKeyHint?: ComponentProps<'input'>['enterKeyHint'];
  onValidityChange?: (valid:boolean) => void; describedBy?: string; requireExplicitValue?:boolean; preserveBlank?: boolean; disabled?: boolean;
}) {
  const show = (v: string) => (v && (v !== '0' || requireExplicitValue || preserveBlank) ? minorToDecimal(v, currency).replace('.', ',').replace(/,00$/, '') : '');
  const [text, setText] = useState(() => show(value));
  const [bad, setBad] = useState(false);
  // Значение изменили снаружи (например, «Заполнить из смен») — показать его, не трогая ввод, который уже ему равен
  useEffect(() => {
    const cur = text.trim() === '' && (requireExplicitValue || preserveBlank) ? '' :
      (text.trim() === '' ? 0n : parseMoney(text, currency))?.toString();
    if (cur !== (requireExplicitValue || preserveBlank ? value : value || '0')) { setText(show(value)); setBad(false); }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Input id={id} ref={inputRef} inputMode="decimal" enterKeyHint={onEnter ? enterKeyHint : undefined} placeholder={placeholder} value={text} disabled={disabled} aria-invalid={bad || invalid || undefined} aria-describedby={describedBy}
      onKeyDown={onEnter ? (e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); onEnter(); } } : undefined}
      onChange={(e) => {
        setText(e.target.value);
        if ((requireExplicitValue || preserveBlank) && e.target.value.trim() === '') {
          setBad(false);
          onValidityChange?.(!requireExplicitValue);
          onChange('');
          return;
        }
        const v = e.target.value.trim() === '' ? 0n : parseMoney(e.target.value, currency);
        setBad(v === null); onValidityChange?.(v !== null);
        if (v !== null) onChange(v.toString());
      }} />
  );
}

export function KV({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {items.map(([k, v], i) => (
        <div key={i} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v ?? '—'}</dd></div>
      ))}
    </dl>
  );
}

/** Подтверждение необратимого/финансового действия с итогом операции (UX-06). */
export function ConfirmDialog({ open, title, summary, confirmLabel, cancelLabel, danger, onConfirm, onClose, onBack, children, busy, error, disabled, dirty, className = '' }: {
  open: boolean; title: string; summary?: [string, ReactNode][]; confirmLabel?: string; cancelLabel?: string; danger?: boolean;
  onConfirm?: () => void; onClose: () => void; onBack?: () => void; children?: ReactNode; busy?: boolean; error?: unknown; disabled?: boolean;
  className?: string; dirty?: boolean;
}) {
  const { t } = useLocale();
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const lastField = useRef<HTMLElement | null>(null);
  const beforeDiscard = useRef<{ frame: number; body: number } | null>(null);
  const titleId = useId();
  const [discard, setDiscard] = useState(false);
  useLayoutEffect(() => {
    const d = ref.current;
    if (!open || !d) {
      beforeDiscard.current = null;
      setDiscard(false);
      return;
    }
    const opener = document.activeElement;
    const shell = d.closest('.content') ?? document.querySelector('.content');
    const page = document.scrollingElement;
    const shellTop = shell?.scrollTop ?? 0;
    const pageTop = page?.scrollTop ?? 0;
    const restoreScroll = () => {
      if (shell) shell.scrollTop = shellTop;
      if (page) page.scrollTop = pageTop;
    };
    d.showModal();
    heading.current?.focus({ preventScroll: true });
    restoreScroll();
    return () => {
      if (d.open) d.close();
      if (opener instanceof HTMLElement && opener.isConnected && document.activeElement === document.body) {
        opener.focus({ preventScroll: true });
      }
      restoreScroll();
    };
  }, [open]);
  useLayoutEffect(() => {
    if (discard) {
      if (frame.current) frame.current.scrollTop = 0;
      heading.current?.focus({ preventScroll: true });
    } else if (beforeDiscard.current) {
      const position = beforeDiscard.current;
      beforeDiscard.current = null;
      if (frame.current) frame.current.scrollTop = position.frame;
      if (body.current) body.current.scrollTop = position.body;
      (lastField.current?.isConnected ? lastField.current : heading.current)?.focus({ preventScroll: true });
    }
  }, [discard]);
  const resume = () => setDiscard(false);
  const requestClose = () => {
    if (busy) return;
    if (discard) resume();
    else if (dirty) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && body.current?.contains(active)) lastField.current = active;
      beforeDiscard.current = { frame: frame.current?.scrollTop ?? 0, body: body.current?.scrollTop ?? 0 };
      setDiscard(true);
    }
    else onClose();
  };
  return (
    <dialog ref={ref} className={`dialog ${className}`} aria-labelledby={titleId}
      onClose={event => { if (open && event.target === event.currentTarget && !event.currentTarget.open) onClose(); }}
      onCancel={event => { if (event.target === event.currentTarget) { event.preventDefault(); event.stopPropagation(); requestClose(); } }}>
      <div className="dialog-frame" ref={frame}>
        <div className="dialog-head" ref={heading} tabIndex={-1} autoFocus><h2 id={titleId}>{discard ? t('Отбросить изменения?', 'Değişiklikler silinsin mi?') : title}</h2></div>
        <div className="dialog-body" ref={body} onFocusCapture={e => { if (e.target instanceof HTMLElement) lastField.current = e.target; }}>
          <div hidden={discard}>
            {summary && (
              <div className="summary"><dl>{summary.map(([k, v]) => <div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>)}</dl></div>
            )}
            {children && <div style={{ marginTop: summary ? 16 : 0 }}>{children}</div>}
            <ActionError error={error} />
          </div>
          {discard && <p>{t('Введённые данные ещё не сохранены.', 'Girdiğiniz bilgiler henüz kaydedilmedi.')}</p>}
        </div>
        <div className="dialog-foot">
          {discard ? <>
            <Button onClick={resume}>{t('Продолжить ввод', 'Düzenlemeye dön')}</Button>
            <Button variant="danger" onClick={onClose}>{t('Отбросить изменения', 'Değişiklikleri sil')}</Button>
          </> : <>
            <Button onClick={requestClose} disabled={busy}>{cancelLabel ?? t('Отмена', 'İptal')}</Button>
            {onBack && <Button variant="ghost" onClick={onBack} disabled={busy}>{t('Назад', 'Geri')}</Button>}
            {confirmLabel && onConfirm && <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm} loading={busy} disabled={disabled}>{confirmLabel}</Button>}
          </>}
        </div>
      </div>
    </dialog>
  );
}

export function Progress({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div>
      <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} aria-label={label}><span style={{ width: `${pct}%` }} /></div>
      <div className="faint" style={{ marginTop: 4 }}>{label}: {value} / {max}</div>
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
