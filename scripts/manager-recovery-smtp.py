"""Restricted stdin-only TLS SMTP relay for the manager recovery worker."""
from contextlib import suppress
from email.headerregistry import Address
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
import json
import smtplib
import ssl
import sys


SOCKET_TIMEOUT = 6
MAX_PAYLOAD = 16_384
TEMPLATES = {
    'confirm': ('Подтвердите почту для восстановления',
                'Подтвердите этот адрес для восстановления доступа к кабинету «Бронь Сервис».'),
    'reset': ('Восстановление пароля «Бронь Сервис»',
              'Откройте ссылку, чтобы установить новый пароль для входа в кабинет «Бронь Сервис».'),
}


def message_for(sender, recipient, kind, link, login):
    subject, action = TEMPLATES[kind]
    mail = EmailMessage()
    mail['From'] = Address(display_name='Бронь Сервис', addr_spec=sender)
    mail['To'] = Address(addr_spec=recipient)
    mail['Subject'] = subject
    mail['Date'] = formatdate(usegmt=True)
    mail['Message-ID'] = make_msgid(domain=sender.rsplit('@', 1)[1])
    login_line = f'\n\nЛогин {login}' if kind == 'reset' and login else ''
    mail.set_content(f'{action}{login_line}\n\n{link}\n\nСсылка одноразовая. Если вы не запрашивали это действие, проигнорируйте письмо.\n')
    return mail


def deliver(payload):
    smtp = payload['smtp']
    mode = payload['mode']
    sender = smtp['from']
    if mode == 'send':
        recipient = payload['email']
        mail = message_for(sender, recipient, payload['kind'], payload['link'], payload.get('login'))
    elif mode != 'check':
        raise ValueError('invalid SMTP operation')

    context = ssl.create_default_context(ssl.Purpose.SERVER_AUTH)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    settings = {'timeout': SOCKET_TIMEOUT, 'local_hostname': sender.rsplit('@', 1)[1]}
    client = None
    try:
        if smtp['tls'] == 'implicit':
            client = smtplib.SMTP_SSL(smtp['host'], smtp['port'], context=context, **settings)
        elif smtp['tls'] == 'starttls':
            client = smtplib.SMTP(smtp['host'], smtp['port'], **settings)
            client.starttls(context=context)
        else:
            raise ValueError('verified SMTP TLS is required')
        client.login(smtp['username'], smtp['password'])
        if mode == 'send':
            refused = client.send_message(mail, from_addr=sender, to_addrs=[recipient])
            if refused:
                raise RuntimeError('recipient was refused')
    finally:
        # Once DATA is accepted, a lost QUIT must not enqueue a duplicate.
        if client is not None:
            with suppress(OSError):
                client.close()


def main():
    try:
        raw = sys.stdin.read(MAX_PAYLOAD + 1)
        if len(raw) > MAX_PAYLOAD:
            return 1
        deliver(json.loads(raw))
        return 0
    except Exception:
        # SMTP errors can contain the full envelope or the provider reply.
        return 1


if __name__ == '__main__':
    sys.exit(main())
