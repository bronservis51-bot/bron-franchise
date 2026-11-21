import { phoneLoginDigits } from '../../platform/login';
import { ConfirmDialog } from '../../ui';
import { CopyCredential } from '../../ui/CredentialFields';
import { accessMessage, accessMessengerLinks } from './accessMessage';

export function NewAccountCredentials({ title, phone, password, onClose }: {
  title: string; phone: string; password: string; onClose: () => void;
}) {
  const site = `${location.origin}${location.pathname}`;
  const message = accessMessage(site, password);
  const digits = phoneLoginDigits(phone);

  return <ConfirmDialog open title={title} cancelLabel="Готово" onClose={onClose}>
    <div className="login-card-data">
      <div className="credential-field">
        <div><span className="faint">Логин</span><strong>{phone}</strong></div>
        <CopyCredential kind="login" value={phone} />
      </div>
      <div>
        <span className="faint">Сообщение для входа</span>
        <pre className="access-message">{message}</pre>
        <div className="row">
          <CopyCredential kind="message" value={message} />
          <CopyCredential kind="password" value={password} />
        </div>
      </div>
    </div>
    {digits && <>
      <p className="faint">Вставьте сообщение в личный чат получателя.</p>
      <div className="row" role="group" aria-label="Открыть мессенджер">
        {accessMessengerLinks(digits).map(({ name, href }) => <a key={name} className="btn btn-sm" href={href} target="_blank" rel="noopener noreferrer">{name}</a>)}
      </div>
    </>}
  </ConfirmDialog>;
}
