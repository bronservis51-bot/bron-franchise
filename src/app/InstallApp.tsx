import { useState, useSyncExternalStore } from 'react';
import { ChevronRight, Smartphone } from 'lucide-react';
import { Button, ConfirmDialog, Field, Input, Select } from '../ui';
import { getInstallController, installDevice, installationUrl, isStandalone, type InstallDevice } from '../platform/install';
import { useLocale } from '../platform/locale';
import { InstallGuide } from './InstallGuide';
import './install-app.css';

const confirmationKey = 'bron.install-confirmed';
const confirmationEvent = 'bron:install-confirmed';
let confirmedForSession = false;

function hasConfirmedInstallation() {
  try { return confirmedForSession || localStorage.getItem(confirmationKey) === 'yes'; }
  catch { return confirmedForSession; }
}

function subscribeToConfirmation(listener: () => void) {
  window.addEventListener(confirmationEvent, listener);
  window.addEventListener('storage', listener);
  return () => {
    window.removeEventListener(confirmationEvent, listener);
    window.removeEventListener('storage', listener);
  };
}

function confirmInstallation() {
  confirmedForSession = true;
  try { localStorage.setItem(confirmationKey, 'yes'); } catch { /* Keep the confirmation for this session. */ }
  window.dispatchEvent(new Event(confirmationEvent));
}

export function useInstallState() {
  const c = getInstallController();
  return useSyncExternalStore(c.subscribe, c.getSnapshot);
}

export function InstallButton() {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const state = useInstallState();
  if (state.installed && !open) return null;
  return <>
    <Button block variant="secondary" onClick={() => setOpen(true)}>
      <Smartphone size={16} aria-hidden />{t('Установка приложения', 'Uygulama kurulumu')}
    </Button>
    {open && <InstallDialog onClose={() => setOpen(false)} />}
  </>;
}

export function InstallDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  const state = useInstallState();
  const detected = installDevice(navigator.userAgent, navigator.maxTouchPoints);
  const [device, setDevice] = useState<InstallDevice>(detected);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const url = installationUrl(location.origin, import.meta.env.BASE_URL);
  const temporary = location.hostname.endsWith('.github.io');
  const macSafari = detected === 'desktop' && /macintosh/i.test(navigator.userAgent)
    && /safari/i.test(navigator.userAgent) && !/chrome|chromium|edg/i.test(navigator.userAgent);
  const native = !state.installed && state.available && device === detected && device !== 'ios';

  async function install() {
    setBusy(true); setMessage('');
    const result = await getInstallController().prompt();
    setBusy(false);
    setMessage(result === 'accepted' ? t('После установки откройте новый значок.', 'Kurulumdan sonra yeni simgeyi açın.') :
      result === 'dismissed' ? t('Установка отменена. Можно установить вручную.', 'Yükleme iptal edildi. Elle yükleyebilirsiniz.') :
        t('Установите вручную по шагам ниже.', 'Aşağıdaki adımlarla elle yükleyin.'));
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopyState('copied');
    } catch { setCopyState('error'); }
  }

  return <ConfirmDialog open className="install-dialog" title={t('Как установить приложение', 'Uygulama nasıl yüklenir?')}
    cancelLabel={t('Закрыть', 'Kapat')} confirmLabel={t('Да, приложение установлено', 'Evet, uygulama yüklendi')}
    onClose={onClose} onConfirm={() => { confirmInstallation(); onClose(); }}>
    <div className="install-guide">
      {temporary && <p className="faint">{t('После смены адреса установите приложение заново.', 'Adres değiştiğinde uygulamayı yeniden yükleyin.')}</p>}
      <Field label={t('Ваше устройство', 'Cihazınız')}>{id => <Select id={id} value={device} onChange={e => { setDevice(e.target.value as InstallDevice); setMessage(''); }}>
        <option value="ios">iPhone / iPad</option><option value="android">Android</option><option value="desktop">{t('Компьютер', 'Bilgisayar')}</option>
      </Select>}</Field>
      {native && <Button variant="primary" block loading={busy} onClick={() => void install()}>{t('Установить приложение', 'Uygulamayı kur')}</Button>}
      {message && <p className="install-status" role="status">{message}</p>}
      <InstallGuide device={device} host={new URL(url).host} macSafari={macSafari} />
      {device === 'desktop' && macSafari && <p className="faint">
        {t('Если «Добавить в Dock» недоступно, откройте кабинет в Chrome или Edge.',
          '“Dock’a Ekle” kullanılamıyorsa paneli Chrome veya Edge’de açın.')}
      </p>}
      <details className="install-link">
        <summary>{t('Ссылка для Safari или Chrome', 'Safari veya Chrome için bağlantı')}</summary>
        <Field label={t('Ссылка на кабинет', 'Panel bağlantısı')}>
          {id => <Input id={id} readOnly value={url} onFocus={e => e.target.select()} />}</Field>
        <Button onClick={() => void copyLink()}>{t('Скопировать ссылку', 'Bağlantıyı kopyala')}</Button>
        {copyState === 'copied' && <p className="install-status" role="status">{t('Ссылка скопирована', 'Bağlantı kopyalandı')}</p>}
        {copyState === 'error' && <p className="install-status" role="status">
          {t('Выделите ссылку в поле выше и скопируйте вручную.', 'Yukarıdaki bağlantıyı seçip elle kopyalayın.')}
        </p>}
      </details>
    </div>
  </ConfirmDialog>;
}

export function InstallReminder() {
  const { t } = useLocale();
  useInstallState();
  const confirmed = useSyncExternalStore(subscribeToConfirmation, hasConfirmedInstallation);
  const [open, setOpen] = useState(false);
  const mobile = installDevice(navigator.userAgent, navigator.maxTouchPoints) !== 'desktop';
  return <>
    {!confirmed && (mobile || isStandalone()) && <button className="install-reminder" type="button"
      aria-haspopup="dialog" onClick={() => setOpen(true)}>
      <Smartphone size={19} aria-hidden="true" />
      <span>{t('Убедитесь, что вы правильно установили приложение', 'Uygulamayı doğru yüklediğinizden emin olun')}</span>
      <ChevronRight size={17} aria-hidden="true" />
    </button>}
    {open && <InstallDialog onClose={() => setOpen(false)} />}
  </>;
}
