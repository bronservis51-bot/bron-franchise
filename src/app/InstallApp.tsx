import { useState, useSyncExternalStore } from 'react';
import { EllipsisVertical, MonitorDown, Plus, Share, Smartphone } from 'lucide-react';
import { Button, ConfirmDialog, Field, Input, Select } from '../ui';
import { getInstallController, installDevice, installationUrl, isStandalone, type InstallDevice } from '../platform/install';
import { useLocale } from '../platform/locale';

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
  const [copied, setCopied] = useState(false);
  const url = installationUrl(location.origin, import.meta.env.BASE_URL);
  const temporary = location.hostname.endsWith('.github.io');
  const macSafari = /macintosh/i.test(navigator.userAgent) && /safari/i.test(navigator.userAgent) && !/chrome|chromium|edg/i.test(navigator.userAgent);
  const native = state.available && device === detected && device !== 'ios';
  const action = device === 'ios' ? t('Поделиться', 'Paylaş')
    : device === 'android' ? t('Меню Chrome', 'Chrome menüsü')
      : macSafari ? t('Меню «Файл»', 'Dosya menüsü') : t('Установка в браузере', 'Tarayıcıda kurulum');
  const add = device === 'ios' ? t('На экран «Домой»', 'Ana Ekrana Ekle')
    : device === 'desktop' && macSafari ? t('Добавить в Dock', 'Dock’a Ekle')
      : t('Установить приложение', 'Uygulamayı kur');
  const BrowserAction = device === 'ios' ? Share : device === 'android' ? EllipsisVertical : MonitorDown;
  const steps = [
    { visual: <><BrowserAction size={20} /><span>{action}</span></>,
      text: device === 'ios' ? t('Откройте кабинет в Safari и нажмите кнопку со стрелкой вверх.', 'Paneli Safari’de açın ve yukarı ok düğmesine dokunun.')
        : device === 'android' ? t('Откройте кабинет в Chrome и нажмите ⋮ вверху.', 'Paneli Chrome’da açın ve yukarıdaki ⋮ düğmesine dokunun.')
          : macSafari ? t('Откройте кабинет в Safari. В меню «Файл» выберите добавление в Dock.', 'Paneli Safari’de açın. Dosya menüsünden Dock’a eklemeyi seçin.')
            : t('Откройте кабинет в Chrome или Edge. Найдите значок в адресной строке или команду установки в меню.', 'Paneli Chrome veya Edge’de açın. Adres çubuğundaki simgeyi veya menüdeki kurulum seçeneğini bulun.') },
    { visual: <><Plus size={20} /><span>{add}</span></>,
      text: device === 'ios' ? t('Выберите этот пункт и нажмите «Добавить». Если есть настройка «Открывать как веб-приложение», оставьте её включённой.', 'Bu seçeneği seçip «Ekle»ye dokunun. «Web Uygulaması Olarak Aç» seçeneği varsa açık bırakın.')
        : device === 'android' ? t('Выберите «Установить приложение» или «Добавить на главный экран», затем подтвердите.', '«Uygulamayı kur» veya «Ana ekrana ekle»yi seçip onaylayın.')
          : t('Подтвердите установку.', 'Kurulumu onaylayın.') },
    { visual: <><img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} width={24} height={24} alt="" /><span>{t('Бронь Сервис', 'Bron Servis')}</span></>,
      text: t('Откройте кабинет с нового значка, войдите и подтвердите запуск в приложении.', 'Paneli yeni simgesinden açın, giriş yapın ve uygulamada açtığınızı onaylayın.') },
  ];

  async function install() {
    setBusy(true); setMessage('');
    const result = await getInstallController().prompt();
    setBusy(false);
    setMessage(result === 'accepted' ? t('Запрос принят браузером. Дождитесь установки и откройте приложение через новый значок.', 'Tarayıcı isteği kabul etti. Kurulum tamamlandığında uygulamayı yeni simgesinden açın.') :
      result === 'dismissed' ? t('Установка отменена. Можно продолжить работу на сайте или установить приложение позже.', 'Kurulum iptal edildi. Sitede çalışmaya devam edebilir veya uygulamayı daha sonra kurabilirsiniz.') :
        t('Браузер не открыл установку. Воспользуйтесь инструкцией ниже.', 'Tarayıcı kurulumu açamadı. Aşağıdaki adımları izleyin.'));
  }

  const copyError = t('Не удалось скопировать. Выделите ссылку в поле выше и скопируйте вручную.', 'Kopyalanamadı. Yukarıdaki bağlantıyı seçip elle kopyalayın.');
  return <ConfirmDialog open className="install-dialog" title={t('Установить Бронь Сервис', 'Bron Servis’i kur')} cancelLabel={t('Закрыть', 'Kapat')} onClose={onClose}>
    <div className="install-guide">
      {state.installed ? <p role="status">{t('Приложение установлено. Откройте его через значок «Бронь Сервис».', 'Uygulama kuruldu. Bron Servis simgesinden açın.')}</p> : <>
        <p>{t('Добавьте значок кабинета на экран устройства.', 'Panel simgesini cihazınızın ekranına ekleyin.')}</p>
        {temporary && <p className="faint">{t('Сейчас это временный адрес кабинета. После перехода на постоянный адрес приложение потребуется установить заново.', 'Bu geçici panel adresidir. Kalıcı adrese geçildiğinde uygulamayı yeniden kurmanız gerekir.')}</p>}
        <Field label={t('Ваше устройство', 'Cihazınız')}>{id => <Select id={id} value={device} onChange={e => { setDevice(e.target.value as InstallDevice); setMessage(''); }}>
          <option value="ios">iPhone / iPad</option><option value="android">Android</option><option value="desktop">{t('Компьютер', 'Bilgisayar')}</option>
        </Select>}</Field>
        {native && <Button variant="primary" block loading={busy} onClick={() => void install()}>{t('Установить приложение', 'Uygulamayı kur')}</Button>}
        {message && <p role="status">{message}</p>}
        <ol className="install-steps">{steps.map(step => <li key={step.text}>
          <div className="install-step-visual">{step.visual}</div><p>{step.text}</p>
        </li>)}</ol>
        {device === 'desktop' && macSafari && <p className="faint">
          {t('В Safari нет пункта «Добавить в Dock»? Откройте кабинет в Chrome или Edge и найдите установку в меню.',
            'Safari’de «Dock’a Ekle» yoksa paneli Chrome veya Edge’de açıp menüden kurun.')}
        </p>}
        <p className="faint">{t('Ссылка открылась в мессенджере? Скопируйте её и откройте в Safari или Chrome.', 'Bağlantı mesajlaşma uygulamasında mı açıldı? Kopyalayıp Safari veya Chrome’da açın.')}</p>
        <Field label={t('Ссылка на кабинет', 'Panel bağlantısı')} hint={t('Можно скопировать и открыть в другом браузере.', 'Kopyalayıp başka bir tarayıcıda açabilirsiniz.')}>
          {id => <Input id={id} readOnly value={url} onFocus={e => e.target.select()} />}</Field>
        <Button onClick={() => {
          void navigator.clipboard?.writeText(url).then(() => { setCopied(true); setMessage(''); }).catch(() => { setCopied(false); setMessage(copyError); });
          if (!navigator.clipboard) setMessage(copyError);
        }}>{copied ? t('Ссылка скопирована', 'Bağlantı kopyalandı') : t('Скопировать ссылку', 'Bağlantıyı kopyala')}</Button>
      </>}
    </div>
  </ConfirmDialog>;
}

/** Only a launch in the installed window can be explicitly confirmed. */
export function InstallConfirmation() {
  const { t } = useLocale();
  useInstallState();
  const [confirmed, setConfirmed] = useState(() => {
    try { return localStorage.getItem('bron.install-confirmed') === 'yes'; } catch { return false; }
  });
  if (confirmed || !isStandalone()) return null;
  return <div className="install-hint install-confirmation" role="status">
    <Smartphone size={18} aria-hidden />
    <div className="alert-body">
      <strong>{t('Кабинет открыт в приложении', 'Panel uygulamada açıldı')}</strong>
      <div>{t('Подтвердите, что открыли его через значок «Бронь Сервис».', 'Bron Servis simgesinden açtığınızı onaylayın.')}</div>
      <Button size="sm" onClick={() => {
        setConfirmed(true);
        try { localStorage.setItem('bron.install-confirmed', 'yes'); } catch { /* keep the confirmation for this session */ }
      }}>{t('Подтвердить установку', 'Kurulumu onayla')}</Button>
    </div>
  </div>;
}
