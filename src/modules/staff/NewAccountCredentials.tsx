import { useId, useState } from 'react';
import { ArrowUpRight, Share2 } from 'lucide-react';
import { installationUrl } from '../../platform/install';
import { useLocale } from '../../platform/locale';
import { phoneLoginDigits } from '../../platform/login';
import { Button, ConfirmDialog } from '../../ui';
import { CopyCredential, CredentialFields } from '../../ui/CredentialFields';
import { accessDraftApps, accessMessage, accessMessengerDraft, accessMessengerLinks } from './accessMessage';

export function NewAccountCredentials({ title, phone, password, onClose }: {
  title: string; phone: string; password: string; onClose: () => void;
}) {
  const { t, language } = useLocale();
  const site = installationUrl(location.origin, import.meta.env.BASE_URL);
  const message = accessMessage(site, password, language);
  const digits = phoneLoginDigits(phone);
  const sendHint = useId();
  const [preview, setPreview] = useState(false);
  const [handoffFailed, setHandoffFailed] = useState(false);
  const canShare = typeof navigator.share === 'function' && (navigator.canShare?.({ text: message }) ?? true);

  function openDraft(name: (typeof accessDraftApps)[number]) {
    if (!digits) return;
    try {
      setHandoffFailed(false);
      // Keep the credential dialog open even if the device has no app for this scheme.
      window.open(accessMessengerDraft(name, digits, message), '_blank', 'noopener,noreferrer');
    } catch {
      setHandoffFailed(true);
    }
  }

  async function share() {
    setHandoffFailed(false);
    try {
      await navigator.share({ text: message });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setHandoffFailed(true);
    }
  }

  return <ConfirmDialog open title={title} className="account-issued" cancelLabel={t('Готово', 'Bitti')} onClose={onClose}>
    <div className="account-issued-content">
      <div className="account-share">
        {digits && <>
          <p className="account-issued-hint" id={sendHint}>
            {t('Откройте личный чат в установленном мессенджере. Проверьте получателя и отправьте готовое сообщение.',
              'Yüklü mesajlaşma uygulamasında özel sohbeti açın. Alıcıyı kontrol edip hazır mesajı gönderin.')}
          </p>
          <div className="account-messengers" role="group" aria-label={t('Сообщение в личный чат', 'Özel sohbete mesaj')} aria-describedby={sendHint}>
            {accessDraftApps.map(name => <Button key={name} variant="secondary" onClick={() => openDraft(name)}>
              {name}<ArrowUpRight size={13} aria-hidden />
            </Button>)}
            {canShare && <Button variant="secondary" onClick={() => void share()}><Share2 size={15} aria-hidden />
              {t('Поделиться в MAX', 'MAX’ta paylaş')}
            </Button>}
          </div>
          {canShare && <p className="account-issued-hint">{t('В системном меню выберите MAX, затем личный чат.',
            'Sistem menüsünde MAX’ı ve ardından özel sohbeti seçin.')}</p>}
        </>}
        {handoffFailed && <p className="account-issued-hint" role="status">{t('Не удалось открыть мессенджер. Скопируйте сообщение.',
          'Mesajlaşma uygulaması açılamadı. Mesajı kopyalayın.')}</p>}
        <CopyCredential kind="message" value={message} onFailure={() => setPreview(true)} />
        {digits && <details>
          <summary>{t('Открыть в браузере', 'Tarayıcıda aç')}</summary>
          <p className="account-issued-hint">{t('Скопируйте сообщение и вставьте его в личный чат получателя.',
            'Mesajı kopyalayıp alıcının özel sohbetine yapıştırın.')}</p>
          <div className="account-messengers" role="group" aria-label={t('Мессенджеры в браузере', 'Tarayıcıdaki mesajlaşma uygulamaları')}>
            {accessMessengerLinks(digits).map(({ name, href }) => <a key={name} className="btn" href={href}
              target="_blank" rel="noopener noreferrer">
              {name}<ArrowUpRight size={13} aria-hidden />
            </a>)}
          </div>
        </details>}
        <button type="button" className="account-preview" aria-expanded={preview} onClick={() => setPreview(!preview)}>
          {preview ? t('Скрыть сообщение', 'Mesajı gizle') : t('Посмотреть сообщение', 'Mesajı görüntüle')}
        </button>
        {preview && <pre className="access-message">{message}</pre>}
      </div>
      <CredentialFields login={phone} password={password} />
      <p className="account-issued-hint">{t('Пароль можно посмотреть до закрытия окна.', 'Parola pencere kapanana kadar görüntülenebilir.')}</p>
    </div>
  </ConfirmDialog>;
}
