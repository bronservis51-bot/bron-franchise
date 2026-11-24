import { useEffect, useState } from 'react';
import { onAvailableUpdate, updateBlockedMessage } from '../platform/update';
import { useLocale } from '../platform/locale';
import { Button } from '../ui';

export function AppUpdateBanner({ hasQueuedWork = false }: { hasQueuedWork?: boolean }) {
  const { t, language } = useLocale();
  const blocked = t(updateBlockedMessage, 'Güncellemeden önce kayıtları tamamlayıp gönderin.');
  const [update, setUpdate] = useState<(() => Promise<void>) | null>(null);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => onAvailableUpdate(fn => {
    setUpdate(() => fn);
    if (!fn) setError('');
  }), []);
  if (!update) return null;

  async function start(apply: () => Promise<void>) {
    if (hasQueuedWork) {
      setError(blocked);
      return;
    }
    setError('');
    setUpdating(true);
    try {
      await apply();
    } catch (err) {
      setError(err instanceof Error && err.message === updateBlockedMessage ? blocked
        : err instanceof Error && language === 'ru' ? err.message
        : t('Не удалось обновить приложение. Повторите попытку.', 'Uygulama güncellenemedi. Yeniden deneyin.'));
    } finally {
      setUpdating(false);
    }
  }

  return (
    <div className="alert tone-info app-update">
      <div className="alert-body">
        <div role="status">{updating ? t('Загружаем новую версию…', 'Yeni sürüm yükleniyor…') : t('Доступна новая версия приложения.', 'Uygulamanın yeni sürümü hazır.')}</div>
        {error && <div role="alert">{error}</div>}
      </div>
      <Button size="sm" loading={updating} onClick={() => void start(update)}>{t('Обновить', 'Güncelle')}</Button>
    </div>
  );
}
