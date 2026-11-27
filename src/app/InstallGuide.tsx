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
    ? t('Откройте кабинет в Safari и нажмите «Поделиться». Если видите кнопку «Ещё» (…), сначала нажмите её.', 'Paneli Safari’de açıp “Paylaş”a dokunun. “Daha Fazla” (…) görünüyorsa önce ona dokunun.')
    : android
      ? t('Откройте кабинет в Chrome и нажмите ⋮ рядом с адресной строкой.', 'Paneli Chrome’da açıp adres çubuğunun yanındaki ⋮ simgesine dokunun.')
      : safariDesktop
        ? t('Откройте кабинет в Safari и выберите меню «Файл».', 'Paneli Safari’de açıp “Dosya” menüsünü seçin.')
        : t('Откройте кабинет в Chrome или Edge. Нажмите значок установки в адресной строке или найдите установку в меню браузера.', 'Paneli Chrome veya Edge’de açın. Adres çubuğundaki yükleme simgesini kullanın ya da tarayıcı menüsünden yüklemeyi seçin.');
  const installInstruction = ios
    ? t('Выберите «На экран „Домой“». Если есть переключатель «Открыть как веб-приложение», включите его. Нажмите «Добавить».',
      '“Ana Ekrana Ekle”yi seçin. “Web Uygulaması Olarak Aç” anahtarı varsa açın. “Ekle”ye dokunun.')
    : android
      ? t('Выберите «Установить и создать ярлык» → «Установить». В некоторых версиях Chrome этот пункт называется «Добавить на главный экран». Если появится выбор, нажмите «Установить».',
        '“Yükle ve kısayol oluştur” → “Yükle”yi seçin. Bazı Chrome sürümlerinde bu seçenek “Ana ekrana ekle” olarak görünür. Seçim sunulursa “Yükle”ye dokunun.')
      : safariDesktop
        ? t('В меню выберите «Добавить в Dock» и нажмите «Добавить».', 'Menüden “Dock’a Ekle”yi seçip “Ekle”ye tıklayın.')
        : t('Выберите установку приложения и подтвердите её.', 'Uygulamayı yüklemeyi seçip onaylayın.');
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
    </li>
    <li>
      <p>{device === 'desktop'
        ? t(`Открывайте кабинет через значок «${name}» на компьютере. У приложения своё окно без адресной строки.`, `Paneli bilgisayarınızdaki “${name}” simgesinden açın. Uygulamanın adres çubuğu olmayan kendi penceresi vardır.`)
        : t(`Открывайте кабинет со значка «${name}» на домашнем экране. Если установка прошла правильно, кабинет откроется без адресной строки браузера.`, `Paneli ana ekrandaki “${name}” simgesinden açın. Kurulum tamamlandıysa panel tarayıcı adres çubuğu olmadan açılır.`)}</p>
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
    </li>
  </ol>;
}
