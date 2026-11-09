import { useState, useSyncExternalStore } from 'react';
import { Smartphone } from 'lucide-react';
import { Button, ConfirmDialog, Field, Input, Select } from '../ui';
import { getInstallController, installDevice, installationUrl, type InstallDevice } from '../platform/install';

export function useInstallState() {
  const c = getInstallController();
  return useSyncExternalStore(c.subscribe, c.getSnapshot);
}

export function InstallButton() {
  const [open, setOpen] = useState(false);
  const state = useInstallState();
  if (state.installed) return null;
  return <>
    <Button block onClick={() => setOpen(true)}><Smartphone size={18} aria-hidden />Как установить приложение</Button>
    {open && <InstallDialog onClose={() => setOpen(false)} />}
  </>;
}

export function InstallDialog({ onClose }: { onClose: () => void }) {
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
    'Откройте ссылку кабинета в Safari.',
    'Нажмите «Поделиться» — значок квадрата со стрелкой вверх. Выберите «На экран «Домой»».',
    'Если есть переключатель «Открывать как веб-приложение», оставьте его включённым. Нажмите «Добавить».',
    'Откройте «Бронь Сервис» с экрана телефона и войдите со своим логином и паролем.',
  ] : device === 'android' ? [
    'Откройте ссылку кабинета в Chrome.',
    'Нажмите меню ⋮ справа вверху. Выберите «Установить приложение» или «Добавить на главный экран».',
    'Подтвердите установку. Откройте «Бронь Сервис» с экрана телефона и войдите со своим логином и паролем.',
  ] : macSafari ? [
    'В Safari откройте меню «Файл» → «Добавить в Dock», если этот пункт доступен.',
    'Нажмите «Добавить», затем откройте «Бронь Сервис» из Dock и войдите со своим логином и паролем.',
    'Если такого пункта нет, откройте кабинет в Chrome или Edge и найдите «Установить» в меню браузера.',
  ] : [
    'Откройте кабинет в Chrome или Edge.',
    'Нажмите значок установки в адресной строке или откройте меню браузера и найдите «Установить Бронь Сервис».',
    'Подтвердите установку. Откройте приложение через появившийся значок и войдите со своим логином и паролем.',
  ];

  async function install() {
    setBusy(true); setMessage('');
    const result = await getInstallController().prompt();
    setBusy(false);
    setMessage(result === 'accepted' ? 'Запрос принят браузером. Дождитесь установки и откройте приложение через новый значок.' :
      result === 'dismissed' ? 'Установка отменена. Можно продолжить работу на сайте или установить приложение позже.' :
        'Браузер не открыл установку. Воспользуйтесь инструкцией ниже.');
  }

  return <ConfirmDialog open className="install-dialog" title="Установить Бронь Сервис" cancelLabel="Закрыть" onClose={onClose}>
    <div className="install-guide">
      {state.installed ? <p role="status">Приложение установлено. Откройте его через значок «Бронь Сервис».</p> : <>
        <p>Кабинет будет открываться отдельным приложением. Установка бесплатная.</p>
        {temporary && <p className="faint">Сейчас это временный адрес кабинета. После перехода на постоянный адрес приложение потребуется установить заново.</p>}
        <Field label="Ваше устройство">{id => <Select id={id} value={device} onChange={e => { setDevice(e.target.value as InstallDevice); setMessage(''); }}>
          <option value="ios">iPhone / iPad</option><option value="android">Android</option><option value="desktop">Компьютер</option>
        </Select>}</Field>
        {native && <Button variant="primary" block loading={busy} onClick={() => void install()}>Установить приложение</Button>}
        {message && <p role="status">{message}</p>}
        <ol>{steps.map(step => <li key={step}>{step}</li>)}</ol>
        <p className="faint">Нет нужного пункта? Если ссылка открылась внутри Telegram или другого приложения, откройте её в обычном браузере. Если приложение уже установлено, найдите его значок на устройстве. Работать в кабинете можно и без установки.</p>
        <Field label="Ссылка на кабинет" hint="Можно скопировать и открыть в другом браузере.">{id => <Input id={id} readOnly value={url} onFocus={e => e.target.select()} />}</Field>
        <Button onClick={() => {
          void navigator.clipboard?.writeText(url).then(() => { setCopied(true); setMessage(''); }).catch(() => { setCopied(false); setMessage('Не удалось скопировать. Выделите ссылку в поле выше и скопируйте вручную.'); });
          if (!navigator.clipboard) setMessage('Выделите ссылку в поле выше и скопируйте вручную.');
        }}>{copied ? 'Ссылка скопирована' : 'Скопировать ссылку'}</Button>
      </>}
    </div>
  </ConfirmDialog>;
}
