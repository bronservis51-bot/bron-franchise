import { useEffect, useRef, useState } from 'react';
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
        () => { if (active) setError('Не удалось открыть вход в Google. Можно скачать файл и загрузить его вручную.'); },
      );
    }
    return () => { active = false; upload.current?.abort(); downloadRequest.current?.abort(); };
  }, []);

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
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Не удалось сохранить отчёт в Google Drive.');
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
      if (!controller.signal.aborted) setError('Не удалось скачать отчёт. Повторите попытку.');
    } finally {
      downloadRequest.current = null;
      if (!controller.signal.aborted) setDownloading(false);
    }
  }

  return (
    <ConfirmDialog open title="Отчёт в Google Drive" onClose={onClose} cancelLabel="Закрыть"
      confirmLabel={clientId && !link ? 'Сохранить в Google Drive' : undefined}
      onConfirm={() => void save()} disabled={!identity} busy={saving}>
      <p>{period}<br />{scope}</p>
      {link ? <Alert tone="info" title="Отчёт сохранён"><a href={link} target="_blank" rel="noreferrer">Открыть отчёт в Google Drive</a></Alert> : (
        <>
          {clientId && <p>Выберите свой аккаунт Google. Файл с этим отчётом появится в разделе «Мой диск».</p>}
          <button type="button" className="link-btn" disabled={downloading || saving} onClick={() => void download()}>
            {downloading ? 'Готовим файл…' : 'Скачать отчёт Excel'}
          </button>
          <p>Затем загрузите файл в <a href="https://drive.google.com/drive/my-drive" target="_blank" rel="noreferrer">«Мой диск»</a>.</p>
        </>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </ConfirmDialog>
  );
}
