import { useState, useSyncExternalStore } from 'react';
import { Smartphone } from 'lucide-react';
import { Button, ConfirmDialog, Field, Input, Select } from '../ui';
import { getInstallController, installDevice, installationUrl, type InstallDevice } from '../platform/install';
import { useLocale } from '../platform/locale';

export function useInstallState() {
  const c = getInstallController();
  return useSyncExternalStore(c.subscribe, c.getSnapshot);
}

export function InstallButton({ compact = false }: { compact?: boolean }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const state = useInstallState();
  if (state.installed) return null;
  return <>
    <Button block={!compact} variant={compact ? 'ghost' : 'secondary'} onClick={() => setOpen(true)}>
      <Smartphone size={16} aria-hidden />{t(compact ? 'Установка' : 'Как установить приложение', compact ? 'Kurulum' : 'Uygulama nasıl kurulur?')}
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
  const steps = device === 'ios' ? [
    t('Откройте ссылку кабинета в Safari.', 'Panel bağlantısını Safari’de açın.'),
    t('Нажмите «Поделиться» — значок квадрата со стрелкой вверх. Выберите «На экран «Домой»».', 'Kare ve yukarı ok simgeli «Paylaş» düğmesine dokunun. «Ana Ekrana Ekle»yi seçin.'),
    t('Если есть переключатель «Открывать как веб-приложение», оставьте его включённым. Нажмите «Добавить».', '«Web Uygulaması Olarak Aç» seçeneği varsa açık bırakın. «Ekle»ye dokunun.'),
    t('Откройте «Бронь Сервис» с экрана телефона и войдите со своим логином и паролем.', 'Telefonunuzun ana ekranından Bron Servis’i açın ve kullanıcı adınız ve parolanızla giriş yapın.'),
  ] : device === 'android' ? [
    t('Откройте ссылку кабинета в Chrome.', 'Panel bağlantısını Chrome’da açın.'),
    t('Нажмите меню ⋮ справа вверху. Выберите «Установить приложение» или «Добавить на главный экран».', 'Sağ üstteki ⋮ menüsünü açın. «Uygulamayı yükle» veya «Ana ekrana ekle»yi seçin.'),
    t('Подтвердите установку. Откройте «Бронь Сервис» с экрана телефона и войдите со своим логином и паролем.', 'Kurulumu onaylayın. Telefonunuzun ana ekranından Bron Servis’i açın ve giriş yapın.'),
  ] : macSafari ? [
    t('В Safari откройте меню «Файл» → «Добавить в Dock», если этот пункт доступен.', 'Safari’de «Dosya» menüsünden «Dock’a Ekle»yi seçin.'),
    t('Нажмите «Добавить», затем откройте «Бронь Сервис» из Dock и войдите со своим логином и паролем.', '«Ekle»ye tıklayın, ardından Bron Servis’i Dock’tan açıp giriş yapın.'),
    t('Если такого пункта нет, откройте кабинет в Chrome или Edge и найдите «Установить» в меню браузера.', 'Bu seçenek yoksa paneli Chrome veya Edge’de açıp tarayıcı menüsünden «Yükle»yi seçin.'),
  ] : [
    t('Откройте кабинет в Chrome или Edge.', 'Paneli Chrome veya Edge’de açın.'),
    t('Нажмите значок установки в адресной строке или откройте меню браузера и найдите «Установить Бронь Сервис».', 'Adres çubuğundaki yükleme simgesine tıklayın veya tarayıcı menüsünden «Bron Servis’i yükle»yi seçin.'),
    t('Подтвердите установку. Откройте приложение через появившийся значок и войдите со своим логином и паролем.', 'Kurulumu onaylayın. Yeni simgeden uygulamayı açın ve giriş yapın.'),
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
        <p>{t('Кабинет будет открываться отдельным приложением. Установка бесплатная.', 'Panel ayrı bir uygulamada açılır. Kurulum ücretsizdir.')}</p>
        {temporary && <p className="faint">{t('Сейчас это временный адрес кабинета. После перехода на постоянный адрес приложение потребуется установить заново.', 'Bu geçici panel adresidir. Kalıcı adrese geçildiğinde uygulamayı yeniden kurmanız gerekir.')}</p>}
        <Field label={t('Ваше устройство', 'Cihazınız')}>{id => <Select id={id} value={device} onChange={e => { setDevice(e.target.value as InstallDevice); setMessage(''); }}>
          <option value="ios">iPhone / iPad</option><option value="android">Android</option><option value="desktop">{t('Компьютер', 'Bilgisayar')}</option>
        </Select>}</Field>
        {native && <Button variant="primary" block loading={busy} onClick={() => void install()}>{t('Установить приложение', 'Uygulamayı kur')}</Button>}
        {message && <p role="status">{message}</p>}
        <ol>{steps.map(step => <li key={step}>{step}</li>)}</ol>
        <p className="faint">{t('Нет нужного пункта? Если ссылка открылась внутри Telegram или другого приложения, откройте её в обычном браузере. Если приложение уже установлено, найдите его значок на устройстве. Работать в кабинете можно и без установки.',
          'Seçeneği bulamıyor musunuz? Bağlantıyı Telegram veya başka bir uygulamanın içinden açtıysanız normal tarayıcıda açın. Uygulama kuruluysa cihazınızda simgesini bulun. Paneli tarayıcıda da kullanabilirsiniz.')}</p>
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
