#!/usr/bin/env python3
"""Short, pinned physical-console entry point; never reads key/S3 credentials."""
import os
import sys

SELF = '/root/bron-secrets/t41-owner-console.py'
PYTHON = '/usr/bin/python3'
MODES = {'check': '--check', 'recover': '--owner-recover', 'attest': '--attest'}
REMOTE_ENV = ('SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'TMUX', 'STY')


def clean_environment():
    value = {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'LC_ALL': 'C.UTF-8', 'TERM': 'dumb'}
    # Preserve denial signals across the isolated bootstrap, never erase them.
    for name in REMOTE_ENV:
        if os.environ.get(name):
            value[name] = os.environ[name]
    return value


def isolated_bootstrap():
    if sys.flags.isolated:
        return
    if (len(sys.argv) != 2 or sys.argv[1] not in MODES or __file__ != SELF
            or sys.platform != 'linux' or os.getuid() != 0 or os.geteuid() != 0
            or os.getgid() != 0 or os.getegid() != 0):
        print('OWNER_CONSOLE_EXPLICIT_ACTION_REQUIRED')
        raise SystemExit(2)
    try:
        os.execve(PYTHON, [PYTHON, '-I', SELF, sys.argv[1]], clean_environment())
    except OSError:
        print('OWNER_CONSOLE_ISOLATION_FAILED')
        raise SystemExit(2) from None


if __name__ == '__main__':
    isolated_bootstrap()

import hashlib
import json
from pathlib import Path
import re
import stat
import types

sys.dont_write_bytecode = True
STATE = Path('/root/bron-secrets/t41-owner-recovery')
RUNTIME = Path('/root/bron-secrets/t41-recovery-runtime')
MANIFEST = STATE / 'manifest.json'
APPROVED = STATE / 'approved-manifest.sha256'
SELF_REL = 'docs/runbooks/payloads/t41-owner-console.py'
WORKFLOW_REL = 'docs/runbooks/payloads/t41-owner-key-recovery.py'
CRYPTO_REL = 'docs/runbooks/payloads/owner-key-escrow-crypto.py'
S3_REL = 'deploy/timeweb/backup-s3.py'
OWNER_UID = OWNER_GID = 0
ANCESTOR_STOP = Path('/')


class ConsoleError(Exception):
    pass


def require(value, code):
    if not value:
        raise ConsoleError(code)


def private_bytes(filename, maximum):
    path = Path(filename)
    parent = path.parent
    while True:
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == OWNER_UID
                and info.st_gid == OWNER_GID and not info.st_mode & 0o022,
                'OWNER_CONSOLE_PRIVATE_PATH_REQUIRED')
        if parent == ANCESTOR_STOP:
            break
        require(parent != parent.parent, 'OWNER_CONSOLE_PRIVATE_PATH_REQUIRED')
        parent = parent.parent
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == OWNER_UID
                and before.st_gid == OWNER_GID and stat.S_IMODE(before.st_mode) == 0o600
                and before.st_nlink == 1 and 0 < before.st_size <= maximum,
                'OWNER_CONSOLE_PRIVATE_FILE_REQUIRED')
        raw = os.read(fd, maximum + 1)
        after = os.fstat(fd)
        named = path.lstat()
        require(len(raw) == before.st_size and len(raw) <= maximum
                and (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns)
                and (after.st_dev, after.st_ino) == (named.st_dev, named.st_ino),
                'OWNER_CONSOLE_FILE_CHANGED')
        return raw
    finally:
        os.close(fd)


def preliminary_console_guard():
    require(sys.platform == 'linux' and os.getuid() == 0 and os.geteuid() == 0
            and os.getgid() == 0 and os.getegid() == 0, 'OWNER_CONSOLE_ROOT_REQUIRED')
    require(not any(os.environ.get(name) for name in REMOTE_ENV), 'OWNER_CONSOLE_LOCAL_TTY_REQUIRED')
    devices = []
    for fd in (0, 1, 2):
        require(os.isatty(fd), 'OWNER_CONSOLE_LOCAL_TTY_REQUIRED')
        require(re.fullmatch(r'/dev/(?:tty[0-9]+|ttyS[0-9]+|hvc[0-9]+|xvc[0-9]+|console)', os.ttyname(fd))
                is not None, 'OWNER_CONSOLE_LOCAL_TTY_REQUIRED')
        info = os.fstat(fd)
        require(stat.S_ISCHR(info.st_mode) and os.tcgetpgrp(fd) == os.getpgrp(),
                'OWNER_CONSOLE_LOCAL_TTY_REQUIRED')
        devices.append(info.st_rdev)
    require(len(set(devices)) == 1, 'OWNER_CONSOLE_LOCAL_TTY_REQUIRED')


def verify_and_guard(action):
    require(action in MODES, 'OWNER_CONSOLE_EXPLICIT_ACTION_REQUIRED')
    preliminary_console_guard()  # No module/file is opened on SSH, pipes or devpts.
    require(Path(__file__) == Path(SELF), 'OWNER_CONSOLE_LOCATION_INVALID')
    approved = private_bytes(APPROVED, 65)
    require(re.fullmatch(rb'[0-9a-f]{64}\n', approved) is not None, 'OWNER_CONSOLE_APPROVAL_PIN_INVALID')
    pin = approved[:64].decode('ascii')
    raw = private_bytes(MANIFEST, 1048576)
    require(hashlib.sha256(raw).hexdigest() == pin, 'OWNER_CONSOLE_MANIFEST_SHA_MISMATCH')
    try:
        manifest = json.loads(raw)
    except (ValueError, UnicodeError):
        raise ConsoleError('OWNER_CONSOLE_MANIFEST_INVALID') from None
    require(isinstance(manifest, dict) and manifest.get('task') == 'T41', 'OWNER_CONSOLE_SCOPE_INVALID')
    recovery, files = manifest.get('ownerRecovery'), manifest.get('files')
    require(isinstance(recovery, dict) and isinstance(files, dict)
            and recovery.get('method') == 'BRON_OWNER_KEY_ESCROW_V1'
            and recovery.get('ownerPhoneConsoleRequired') is True
            and recovery.get('stateRoot') == str(STATE) and recovery.get('runtimeRoot') == str(RUNTIME),
            'OWNER_CONSOLE_SCOPE_INVALID')
    if action != 'check':
        require(manifest.get('execution_authorized') is True and recovery.get('executionAuthorized') is True,
                'OWNER_CONSOLE_EXECUTION_NOT_AUTHORIZED')
    runtime_files = recovery.get('runtimeFiles')
    require(isinstance(runtime_files, dict) and set(runtime_files) ==
            {str(RUNTIME / name) for name in (WORKFLOW_REL, CRYPTO_REL, S3_REL)},
            'OWNER_CONSOLE_RUNTIME_PINS_REQUIRED')
    code = {}
    for relative, filename in ((SELF_REL, Path(SELF)), (WORKFLOW_REL, RUNTIME / WORKFLOW_REL),
                               (CRYPTO_REL, RUNTIME / CRYPTO_REL), (S3_REL, RUNTIME / S3_REL)):
        expected = files.get(relative)
        require(isinstance(expected, str) and re.fullmatch(r'[0-9a-f]{64}', expected)
                and (relative == SELF_REL or runtime_files[str(filename)] == expected),
                'OWNER_CONSOLE_RUNTIME_PIN_INVALID')
        body = private_bytes(filename, 1048576)
        require(hashlib.sha256(body).hexdigest() == expected, 'OWNER_CONSOLE_RUNTIME_SHA_MISMATCH')
        code[relative] = body
    # Compile exactly the verified bytes: no unpinned .pyc or second source open.
    guard = types.ModuleType('bron_owner_console_guard')
    guard.__file__ = str(RUNTIME / CRYPTO_REL)
    exec(compile(code[CRYPTO_REL], guard.__file__, 'exec'), guard.__dict__)
    guard.require_owner_console()
    return [PYTHON, '-I', str(RUNTIME / WORKFLOW_REL), MODES[action],
            '--manifest', str(MANIFEST), '--manifest-sha256', pin]


def main(argv=None):
    try:
        arguments = sys.argv[1:] if argv is None else argv
        require(len(arguments) == 1 and arguments[0] in MODES, 'OWNER_CONSOLE_EXPLICIT_ACTION_REQUIRED')
        require(bool(sys.flags.isolated), 'OWNER_CONSOLE_ISOLATION_REQUIRED')
        command = verify_and_guard(arguments[0])
        os.execve(PYTHON, command, clean_environment())
        raise ConsoleError('OWNER_CONSOLE_EXEC_FAILED')
    except ConsoleError as error:
        code = str(error)
    except (KeyboardInterrupt, EOFError):
        code = 'OWNER_CONSOLE_INTERRUPTED'
    except Exception:
        code = 'OWNER_CONSOLE_CHECK_FAILED'
    print(code)
    return 2


if __name__ == '__main__':
    raise SystemExit(main())
