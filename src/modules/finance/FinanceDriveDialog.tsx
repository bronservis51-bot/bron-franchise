import { useEffect, useRef, useState } from 'react';
import { useLocale } from '../../platform/locale';
import { Alert, ConfirmDialog } from '../../ui';
import { googleDriveClientId, loadGoogleDriveIdentity, saveFinanceReportToDrive, type GoogleDriveIdentity } from './financeDrive';
import { downloadFinanceFile } from './financeReport';

const clientId = googleDriveClientId(import.meta.env.VITE_GOOGLE_DRIVE_CLIENT_ID);

export function FinanceDriveDialog({ period, scope, makeFile, onClose }: {
  period: string;
  scope: string;
  makeFile: () => Promise<File>;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const [identity, setIdentity] = useState<GoogleDriveIdentity | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [saving, setSaving] = useState(false);
  const upload = useRef<AbortController | null>(null);
  const downloadRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    let active = true;
    if (clientId) {
      loadGoogleDriveIdentity().then(
        oauth => { if (active) setIdentity(oauth); },
        () => { if (active) setError(t('Не удалось открыть вход в Google. Можно скачать файл и загрузить его вручную.',
          'Google oturumu açılamadı. Dosyayı indirip elle yükleyebilirsiniz.')); },
      );
    }
    return () => { active = false; upload.current?.abort(); downloadRequest.current?.abort(); };
  }, [t]);

  async function save() {
    if (!clientId || !identity || upload.current) return;
    const controller = new AbortController();
    upload.current = controller;
    setSaving(true);
    setError(null);
    try {
      const url = await saveFinanceReportToDrive(identity, clientId, makeFile, controller.signal);
      if (!controller.signal.aborted) setLink(url);
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message
        : t('Не удалось сохранить отчёт в Google Drive.', 'Rapor Google Drive’a kaydedilemedi.'));
    } finally {
      upload.current = null;
      if (!controller.signal.aborted) setSaving(false);
    }
  }

  async function download() {
    if (downloadRequest.current) return;
    const controller = new AbortController();
    downloadRequest.current = controller;
    setDownloading(true);
    setError(null);
    try {
      await downloadFinanceFile(makeFile, controller.signal);
    } catch {
      if (!controller.signal.aborted) setError(t('Не удалось скачать отчёт. Повторите попытку.', 'Rapor indirilemedi. Tekrar deneyin.'));
    } finally {
      downloadRequest.current = null;
      if (!controller.signal.aborted) setDownloading(false);
    }
  }

  return (
    <ConfirmDialog open title={t('Отчёт в Google Drive', 'Google Drive raporu')} onClose={onClose} cancelLabel={t('Закрыть', 'Kapat')}
      confirmLabel={clientId && !link ? t('Сохранить в Google Drive', 'Google Drive’a kaydet') : undefined}
      onConfirm={() => void save()} disabled={!identity} busy={saving}>
      <p>{period}<br />{scope}</p>
      {link ? <Alert tone="info" title={t('Отчёт сохранён', 'Rapor kaydedildi')}><a href={link} target="_blank" rel="noreferrer">
        {t('Открыть отчёт в Google Drive', 'Raporu Google Drive’da aç')}
      </a></Alert> : (
        <>
          {clientId && <p>{t('Выберите аккаунт Google. Файл появится в разделе «Мой диск».',
            'Google hesabınızı seçin. Dosya “Drive’ım” bölümünde görünür.')}</p>}
          <button type="button" className="link-btn" disabled={downloading || saving} onClick={() => void download()}>
            {downloading ? t('Готовим файл…', 'Dosya hazırlanıyor…') : t('Скачать отчёт Excel', 'Excel raporunu indir')}
          </button>
          <p>{t('Затем загрузите файл в ', 'Ardından dosyayı ')}
            <a href="https://drive.google.com/drive/my-drive" target="_blank" rel="noreferrer">{t('«Мой диск»', '“Drive’ım”a')}</a>
            {t('.', ' yükleyin.')}</p>
        </>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </ConfirmDialog>
  );
}
