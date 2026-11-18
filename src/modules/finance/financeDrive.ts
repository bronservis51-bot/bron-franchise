const GIS_SRC = 'https://accounts.google.com/gsi/client';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

interface DriveTokenResponse { access_token?: string; scope?: string; error?: string }

export interface GoogleDriveIdentity {
  initTokenClient(options: {
    client_id: string;
    scope: string;
    include_granted_scopes: boolean;
    callback: (response: DriveTokenResponse) => void;
    error_callback: () => void;
  }): { requestAccessToken(options: { prompt: 'select_account' }): void };
}

export function googleDriveClientId(value?: string): string | null {
  const id = value?.trim() ?? '';
  return /^[a-z0-9-]+\.apps\.googleusercontent\.com$/i.test(id) ? id : null;
}

let loading: Promise<GoogleDriveIdentity> | undefined;
export function loadGoogleDriveIdentity(): Promise<GoogleDriveIdentity> {
  const getIdentity = () => (window as Window & { google?: { accounts?: { oauth2?: GoogleDriveIdentity } } }).google?.accounts?.oauth2;
  const identity = getIdentity();
  if (identity) return Promise.resolve(identity);
  loading ??= new Promise<GoogleDriveIdentity>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.onload = () => {
      const oauth = getIdentity();
      if (oauth) resolve(oauth);
      else reject(new Error('Не удалось запустить вход в Google.'));
    };
    script.onerror = () => reject(new Error('Не удалось загрузить вход в Google.'));
    document.head.append(script);
  }).catch(error => {
    document.querySelector(`script[src="${GIS_SRC}"]`)?.remove();
    loading = undefined;
    throw error;
  });
  return loading;
}

function requestDriveToken(identity: GoogleDriveIdentity, clientId: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const fail = () => {
      signal.removeEventListener('abort', abort);
      reject(new Error('Google не предоставил доступ для сохранения файла. Вы можете повторить попытку.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      identity.initTokenClient({ client_id: clientId, scope: DRIVE_SCOPE, include_granted_scopes: false,
        callback: (response) => {
          if (response.error || !response.access_token || !response.scope?.split(/\s+/).includes(DRIVE_SCOPE)) {
            fail();
            return;
          }
          signal.removeEventListener('abort', abort);
          resolve(response.access_token);
        },
        error_callback: fail,
      }).requestAccessToken({ prompt: 'select_account' });
    } catch {
      fail();
    }
  });
}

export async function saveFinanceReportToDrive(
  identity: GoogleDriveIdentity, clientId: string, makeFile: () => Promise<File>, signal: AbortSignal,
): Promise<string> {
  const token = await requestDriveToken(identity, clientId, signal);
  signal.throwIfAborted();
  const file = await makeFile();
  signal.throwIfAborted();
  const boundary = `bron-${crypto.randomUUID()}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n`,
    JSON.stringify({ name: file.name }),
    `\r\n--${boundary}\r\nContent-Type: ${file.type}\r\n\r\n`,
    file,
    `\r\n--${boundary}--\r\n`,
  ]);
  let response: Response;
  try {
    response = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
      method: 'POST', signal, body,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    });
  } catch {
    signal.throwIfAborted();
    throw new Error('Не удалось связаться с Google Drive. Повторите попытку или скачайте Excel.');
  }
  if (!response.ok) throw new Error('Google Drive не сохранил отчёт. Повторите попытку или скачайте Excel.');
  const { id } = await response.json() as { id?: string };
  if (!id || !/^[\w-]+$/.test(id)) throw new Error('Google Drive не вернул ссылку на отчёт. Проверьте файлы в «Мой диск».');
  return `https://drive.google.com/open?id=${id}`;
}
