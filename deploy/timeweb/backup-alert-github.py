#!/usr/bin/python3
"""Queue the fixed availability workflow; acceptance is not Telegram delivery."""
import json
import os
from pathlib import Path
import re
import ssl
import stat
import sys
import urllib.request

CONFIG = Path('/root/bron-secrets/github-alert.json')
EVENT = 'BRON_TARGET_BACKUP_OR_HEALTH_FAILURE'
ENDPOINT = 'https://api.github.com/repos/bronservis51-bot/bron-franchise/actions/workflows/availability.yml/dispatches'
REFS = {'main', 'ops/russia-migration-20261110'}
LIMIT = 65536


class RelayError(RuntimeError):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        raise RelayError('GITHUB_ALERT_REDIRECT_REFUSED')


def read_config(path):
    if os.geteuid() != 0:
        raise RelayError('GITHUB_ALERT_ROOT_REQUIRED')
    info = path.parent.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0
            or stat.S_IMODE(info.st_mode) != 0o700):
        raise RelayError('GITHUB_ALERT_PRIVATE_DIRECTORY_REQUIRED')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0
                or stat.S_IMODE(info.st_mode) != 0o600):
            raise RelayError('GITHUB_ALERT_PRIVATE_CONFIG_REQUIRED')
        raw = stream.read(LIMIT + 1)
    if len(raw) > LIMIT:
        raise RelayError('GITHUB_ALERT_CONFIG_TOO_LARGE')
    config = json.loads(raw)
    if (not isinstance(config, dict) or set(config) != {'token', 'ref'}
            or not isinstance(config['token'], str)
            or not re.fullmatch(r'github_pat_[A-Za-z0-9_]{20,250}', config['token'])
            or not isinstance(config['ref'], str) or config['ref'] not in REFS):
        raise RelayError('GITHUB_ALERT_CONFIG_INVALID')
    return config['token'], config['ref']


def dispatch(token, ref):
    request = urllib.request.Request(ENDPOINT, method='POST',
        data=json.dumps({'ref': ref}).encode(), headers={
            'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json',
            'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'Bron-Backup-Alert'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}),
        urllib.request.HTTPSHandler(context=ssl.create_default_context()), NoRedirect())
    with opener.open(request, timeout=15) as response:
        if response.getcode() != 204:
            raise RelayError('GITHUB_ALERT_DISPATCH_REJECTED')
        if len(response.read(LIMIT + 1)) > LIMIT:
            raise RelayError('GITHUB_ALERT_RESPONSE_TOO_LARGE')


def main():
    try:
        if sys.argv[1:] != [EVENT]:
            raise RelayError('GITHUB_ALERT_EVENT_INVALID')
        dispatch(*read_config(CONFIG))
        print('GITHUB_ALERT_DISPATCH_ACCEPTED')
        return 0
    except Exception as error:
        print(str(error) if isinstance(error, RelayError) else 'GITHUB_ALERT_DISPATCH_FAILED')
        return 1


if __name__ == '__main__':
    sys.exit(main())
