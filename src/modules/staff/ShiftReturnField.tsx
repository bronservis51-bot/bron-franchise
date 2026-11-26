import { useEffect, useId, useRef } from 'react';
import { Button, Field, MoneyInput } from '../../ui';
import { useLocale } from '../../platform/locale';

export function validShiftReturn(value: string | null, inputValid: boolean) {
  return inputValid && (!value || (/^\d{1,12}$/.test(value) && Number(value) > 0 && Number(value) <= 100_000_000_000));
}

export function ShiftReturnField({ value, onChange, valid, onValidityChange, currency, busy }: {
  value: string | null; onChange: (value: string | null) => void; valid: boolean;
  onValidityChange: (valid: boolean) => void; currency: string; busy: boolean;
}) {
  const { t } = useLocale();
  const id = useId();
  const focusAfterToggle = useRef(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const amount = useRef<HTMLInputElement | null>(null);
  const shown = value !== null;
  const invalid = !validShiftReturn(value, valid);
  useEffect(() => {
    if (!focusAfterToggle.current) return;
    focusAfterToggle.current = false;
    (shown ? amount.current : toggle.current)?.focus();
  }, [shown]);
  return <div className="shift-return">
    <Button ref={toggle} size="sm" variant="ghost" aria-expanded={shown} aria-controls={id} disabled={busy}
      onClick={() => {
        focusAfterToggle.current = true;
        onValidityChange(true);
        onChange(shown ? null : '');
      }}>{shown ? t('Убрать возврат', 'İadeyi kaldır') : t('Был возврат', 'İade var')}</Button>
    <div id={id} hidden={!shown}>
      {value !== null && (
        <Field label={t('Сумма возврата', 'İade tutarı')}
          error={invalid ? t('Укажите допустимую сумму возврата больше нуля.', 'Sıfırdan büyük, geçerli bir iade tutarı girin.') : undefined}>
          {(input, describedBy) => (
            <MoneyInput id={input} describedBy={describedBy} value={value} onChange={onChange} onValidityChange={onValidityChange}
              inputRef={element => { amount.current = element; }} invalid={invalid} preserveBlank currency={currency} disabled={busy} />
          )}
        </Field>
      )}
    </div>
  </div>;
}
