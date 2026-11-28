import { ArrowLeft, ArrowRight, BookOpen, ChevronRight, EllipsisVertical, Home, MonitorDown, PanelsTopLeft, Share, SquarePlus } from 'lucide-react';
import { useLocale } from '../platform/locale';
import type { InstallDevice } from '../platform/install';

export function InstallGuide({ device, host, macSafari }: {
  device: InstallDevice; host: string; macSafari: boolean;
}) {
  const { t } = useLocale();
  const ios = device === 'ios';
  const android = device === 'android';
  const safariDesktop = device === 'desktop' && macSafari;
  const icon = ios ? 'apple-touch-icon.png' : android ? 'icon-maskable-512.png' : 'icon-192.png';
  const name = import.meta.env.VITE_APP_ENV === 'staging' ? 'Бронь — тест' : 'Бронь Сервис';
  const add = ios ? t('На экран «Домой»', 'Ana Ekrana Ekle')
    : android ? t('Установить и создать ярлык', 'Yükle ve kısayol oluştur')
      : safariDesktop ? t('Добавить в Dock', 'Dock’a Ekle') : t('Установить приложение', 'Uygulamayı yükle');
  const confirm = ios || safariDesktop ? t('Добавить', 'Ekle') : t('Установить', 'Yükle');
  const browserInstruction = ios
    ? t('В Safari нажмите «Поделиться».', 'Safari’de “Paylaş”a dokunun.')
    : android
      ? t('В Chrome нажмите ⋮.', 'Chrome’da ⋮ simgesine dokunun.')
      : safariDesktop
        ? t('В Safari откройте меню «Файл».', 'Safari’de “Dosya” menüsünü açın.')
        : t('В Chrome или Edge нажмите значок установки.', 'Chrome veya Edge’de yükleme simgesine tıklayın.');
  const installInstruction = ios
    ? t('«На экран „Домой“» → «Добавить».', '“Ana Ekrana Ekle” → “Ekle”.')
    : android
      ? t('«Установить и создать ярлык» → «Установить».', '“Yükle ve kısayol oluştur” → “Yükle”.')
      : safariDesktop
        ? t('«Добавить в Dock» → «Добавить».', '“Dock’a Ekle” → “Ekle”.')
        : t('Подтвердите установку.', 'Yüklemeyi onaylayın.');
  const appIcon = `${import.meta.env.BASE_URL}icons/${icon}`;

  return <ol className="install-steps">
    <li>
      <p>{browserInstruction}</p>
      <div className="install-figure install-browser-sample" aria-hidden="true">
        <div className="install-browser-chrome">
          {android && <Home size={17} />}
          {safariDesktop && <span>{t('Файл', 'Dosya')}</span>}
          <span className="install-address">{host}</span>
          {android && <span className="install-control-mark"><EllipsisVertical size={21} /></span>}
          {!ios && !android && !safariDesktop && <span className="install-control-mark"><MonitorDown size={19} /></span>}
        </div>
        {ios && <div className="install-browser-tools">
          <ArrowLeft size={17} /><ArrowRight size={17} />
          <span className="install-control-mark"><Share size={19} /></span>
          <BookOpen size={17} /><PanelsTopLeft size={17} />
        </div>}
      </div>
      {ios && <p className="install-step-note">{t('В компактном меню сначала нажмите «Ещё» (…).', 'Kompakt menüde önce “Daha Fazla” (…) düğmesine dokunun.')}</p>}
      {device === 'desktop' && !safariDesktop && <p className="install-step-note">{t('Установка также есть в меню браузера.', 'Yükleme seçeneği tarayıcı menüsünde de bulunur.')}</p>}
    </li>
    <li>
      <p>{installInstruction}</p>
      <div className="install-figure install-menu-sample" aria-hidden="true">
        <div className="install-menu-option">{ios ? <SquarePlus size={19} /> : <MonitorDown size={19} />}<strong>{add}</strong></div>
        {ios && <div className="install-menu-option install-menu-toggle">
          <span>{t('Открыть как веб-приложение', 'Web Uygulaması Olarak Aç')}</span><span className="install-switch" />
        </div>}
        <div className="install-menu-action"><span>{confirm}</span></div>
      </div>
      {ios && <p className="install-step-note">{t('Включите «Открыть как веб-приложение», если есть такой переключатель.', 'Varsa “Web Uygulaması Olarak Aç” seçeneğini açın.')}</p>}
      {android && <p className="install-step-note">{t('В некоторых версиях «Добавить на главный экран» → «Установить».', 'Bazı sürümlerde “Ana ekrana ekle” → “Yükle”.')}</p>}
    </li>
    <li>
      <p>{device === 'desktop'
        ? t(`Откройте кабинет через значок «${name}».`, `Paneli “${name}” simgesinden açın.`)
        : t(`На главном экране нажмите значок «${name}».`, `Ana ekrandaki “${name}” simgesine dokunun.`)}</p>
      <div className="install-figure install-launch-sample" aria-hidden="true">
        <div className="install-home-sample" data-device={device}>
          <img className="install-launch-icon" src={appIcon} width={48} height={48} alt="" />
          <span>{name}</span>
        </div>
        <ChevronRight size={18} />
        <div className="install-window-sample">
          <div><img src={appIcon} width={18} height={18} alt="" /><strong>{name}</strong></div>
          <span /><span /><span />
        </div>
      </div>
      <p className="install-step-note">{t('Кабинет откроется без адресной строки.', 'Panel adres çubuğu olmadan açılır.')}</p>
    </li>
  </ol>;
}
