#!/usr/bin/env python3
"""Owner-only hidden entry of one Telegram token into one GitHub repository secret."""
import getpass
import os
import re
import resource
import shutil
import subprocess
import sys
import warnings

REPO = 'bronservis51-bot/bron-franchise'
SECRET = 'BRON_TELEGRAM_BOT_TOKEN'


def main():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if not sys.stdin.isatty() or not sys.stderr.isatty():
        print('OWNER_TTY_REQUIRED')
        return 2
    gh = shutil.which('gh')
    if gh is None:
        print('GITHUB_CLI_REQUIRED')
        return 2
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            token = getpass.getpass('Вставьте токен Telegram-бота (ввод скрыт): ')
    except (EOFError, KeyboardInterrupt, getpass.GetPassWarning):
        print('OWNER_HIDDEN_INPUT_UNAVAILABLE')
        return 2
    if not re.fullmatch(r'[0-9]{5,15}:[A-Za-z0-9_-]{20,100}', token):
        print('TELEGRAM_TOKEN_FORMAT_INVALID')
        return 2
    env = dict(os.environ)
    for key in list(env):
        if key == 'GH_DEBUG' or key == 'GH_FORCE_TTY' or key == 'GIT_CURL_VERBOSE' or key.startswith('GIT_TRACE'):
            del env[key]
    env['GH_HOST'] = 'github.com'
    env['GH_PROMPT_DISABLED'] = '1'
    try:
        result = subprocess.run([gh, 'secret', 'set', SECRET, '--repo', REPO],
            input=token + '\n', text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=env, timeout=60, check=False)
    except subprocess.TimeoutExpired:
        print('GITHUB_SECRET_SAVE_TIMEOUT')
        return 1
    except (OSError, subprocess.SubprocessError):
        print('GITHUB_SECRET_SAVE_FAILED')
        return 1
    finally:
        token = ''
    if result.returncode:
        error = result.stderr.lower()
        code = ('GITHUB_SECRET_PERMISSION_DENIED' if '403' in error or 'forbidden' in error
                else 'GITHUB_AUTH_REQUIRED' if '401' in error or 'gh auth login' in error
                else 'GITHUB_SECRET_SAVE_FAILED')
        print(code)
        return 1
    print('GITHUB_BOT_TOKEN_SECRET_SAVED')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('OWNER_TOKEN_HELPER_CANCELLED')
        sys.exit(130)
    except Exception:
        # Never print exceptions: subprocess errors may contain private input.
        print('OWNER_TOKEN_HELPER_FAILED')
        sys.exit(1)
