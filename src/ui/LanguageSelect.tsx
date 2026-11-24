import { useId } from 'react';
import { useLocale } from '../platform/locale';
import './language-select.css';

export function LanguageSelect({ automatic = false }: { automatic?: boolean }) {
  const { language, choice, setLanguage, t } = useLocale();
  const id = useId();
  return <label className="language-select" htmlFor={id}>
    <span>{t('Язык', 'Dil')}</span>
    <select id={id} value={automatic ? choice : language} onChange={event => {
      const value = event.currentTarget.value;
      if (value === 'ru' || value === 'tr' || value === 'auto') setLanguage(value);
    }}>
      {automatic && <option value="auto">{t('Автоматически', 'Otomatik')}</option>}
      <option value="ru" lang="ru">Русский</option>
      <option value="tr" lang="tr">Türkçe</option>
    </select>
  </label>;
}
