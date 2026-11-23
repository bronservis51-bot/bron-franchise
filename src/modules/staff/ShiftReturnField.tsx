import { useEffect, useId, useRef } from 'react';
import { Button, Field, MoneyInput } from '../../ui';

export function validShiftReturn(value: string | null, inputValid: boolean) {
  return value === null || (inputValid && /^\d{1,12}$/.test(value) && Number(value) > 0 && Number(value) <= 100_000_000_000);
}

export function ShiftReturnField({ value, onChange, valid, onValidityChange, currency, busy }: {
  value: string | null; onChange: (value: string | null) => void; valid: boolean;
  onValidityChange: (valid: boolean) => void; currency: string; busy: boolean;
}) {
  const id = useId();
  const focusAfterToggle = useRef(false);
  const reveal = useRef<HTMLButtonElement>(null);
  const amount = useRef<HTMLInputElement | null>(null);
  const shown = value !== null;
  useEffect(() => {
    if (!focusAfterToggle.current) return;
    focusAfterToggle.current = false;
    (shown ? amount.current : reveal.current)?.focus();
  }, [shown]);
  return <div className="stack" style={{ gap: 8 }}>
    {value === null ? <Button ref={reveal} size="sm" variant="ghost" style={{ alignSelf: 'flex-start' }}
      aria-expanded={false} aria-controls={id} disabled={busy}
      onClick={() => { focusAfterToggle.current = true; onChange(''); }}>Был возврат</Button> : null}
    <div id={id} hidden={value === null}>
      {value !== null && <>
        <Field label="Сумма возврата" hint="Продажи укажите в полях «Наличные» и «Картой» до вычета возврата."
          error={value !== '' && !validShiftReturn(value, valid) ? 'Укажите допустимую сумму возврата больше нуля.' : undefined}
          required>{(input, describedBy) =>
          <MoneyInput id={input} describedBy={describedBy} value={value} onChange={onChange} onValidityChange={onValidityChange}
            inputRef={element => { amount.current = element; }} requireExplicitValue currency={currency} disabled={busy} />
        }</Field>
        <Button size="sm" variant="ghost" disabled={busy}
          onClick={() => { focusAfterToggle.current = true; onValidityChange(true); onChange(null); }}>Убрать возврат</Button>
      </>}
    </div>
  </div>;
}
