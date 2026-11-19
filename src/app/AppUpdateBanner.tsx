import { useEffect, useState } from 'react';
import { onAvailableUpdate, updateBlockedMessage } from '../platform/update';
import { Button } from '../ui';

export function AppUpdateBanner({ hasQueuedWork = false }: { hasQueuedWork?: boolean }) {
  const [update, setUpdate] = useState<(() => Promise<void>) | null>(null);
  const [updating, setUpdating] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => onAvailableUpdate(fn => setUpdate(() => fn)), []);
  if (!update) return null;

  async function start(apply: () => Promise<void>) {
    if (hasQueuedWork) {
      setError(updateBlockedMessage);
      return;
    }
    setError('');
    setUpdating(true);
    try {
      await apply();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось обновить приложение. Повторите попытку.');
      setUpdating(false);
    }
  }

  return (
    <div className="alert tone-info app-update">
      <div className="alert-body">
        <div role="status">{updating ? 'Загружаем новую версию…' : 'Доступна новая версия приложения.'}</div>
        {error && <div role="alert">{error}</div>}
      </div>
      <Button size="sm" loading={updating} onClick={() => void start(update)}>Обновить</Button>
    </div>
  );
}
