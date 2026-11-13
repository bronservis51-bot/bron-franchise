#!/usr/bin/python3
"""Send one fixed operational alert; never print the token, URL or API response."""
import datetime
import json
import os
from pathlib import Path
import re
import ssl
import stat
import sys
import urllib.request

CONFIG = Path('/root/bron-secrets/telegram-alert.json')
EVENT = 'BRON_TARGET_BACKUP_OR_HEALTH_FAILURE'
MAX_BYTES = 65536


class AlertError(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise AlertError('TELEGRAM_REDIRECT_REFUSED')


def read_config(path):
    if os.geteuid() != 0:
        raise AlertError('TELEGRAM_ROOT_REQUIRED')
    info = path.parent.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0
            or stat.S_IMODE(info.st_mode) != 0o700):
        raise AlertError('TELEGRAM_PRIVATE_DIRECTORY_REQUIRED')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
                or stat.S_IMODE(info.st_mode) != 0o600):
            raise AlertError('TELEGRAM_PRIVATE_CONFIG_REQUIRED')
        raw = stream.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise AlertError('TELEGRAM_CONFIG_TOO_LARGE')
    config = json.loads(raw)
    if (not isinstance(config, dict) or set(config) != {'token', 'chat_id'}
            or not isinstance(config['token'], str)
            or not re.fullmatch(r'[0-9]{5,15}:[A-Za-z0-9_-]{20,100}', config['token'])
            or type(config['chat_id']) not in (str, int)
            or not re.fullmatch(r'-?[0-9]{1,20}', str(config['chat_id']))
            or int(config['chat_id']) == 0):
        raise AlertError('TELEGRAM_CONFIG_INVALID')
    return config['token'], str(int(config['chat_id']))


def send(token, chat_id):
    now = datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
    text = ('Тревога «Бронь Сервис»: проверка сервера или резервной копии завершилась ошибкой. '
            'Требуется проверить состояние сервера.\nВремя: ' + now)
    request = urllib.request.Request('https://api.telegram.org/bot' + token + '/sendMessage',
        data=json.dumps({'chat_id': chat_id, 'text': text}, ensure_ascii=False).encode('utf-8'),
        headers={'Content-Type': 'application/json', 'Accept': 'application/json'}, method='POST')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()), NoRedirect())
    with opener.open(request, timeout=15) as response:
        if response.getcode() != 200:
            raise AlertError('TELEGRAM_HTTP_FAILED')
        raw = response.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise AlertError('TELEGRAM_RESPONSE_TOO_LARGE')
    result = json.loads(raw)
    if not isinstance(result, dict) or result.get('ok') is not True:
        raise AlertError('TELEGRAM_API_REJECTED')
    message = result.get('result')
    if (not isinstance(message, dict) or not isinstance(message.get('chat'), dict)
            or str(message['chat'].get('id')) != chat_id):
        raise AlertError('TELEGRAM_RECIPIENT_MISMATCH')


def main():
    try:
        if sys.argv[1:] != [EVENT]:
            raise AlertError('TELEGRAM_EVENT_INVALID')
        token, chat_id = read_config(CONFIG)
        send(token, chat_id)
        print('TELEGRAM_ALERT_ACCEPTED')
        return 0
    except Exception as error:
        # urllib errors include the private token in their URL. Never format them.
        print(str(error) if isinstance(error, AlertError) else 'TELEGRAM_ALERT_FAILED')
        return 1


if __name__ == '__main__':
    sys.exit(main())
