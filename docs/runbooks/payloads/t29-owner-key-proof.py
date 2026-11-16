#!/usr/bin/env python3
"""VPS-only proof for an owner-held age key. No backup bytes go to the Mac."""
import argparse
import getpass
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import stat
import subprocess
import sys
import time
import warnings

BACKUP_BASE = Path('/var/backups/bron-franchise')
BACKUP_ROOT = BACKUP_BASE / 'target-20261113T133022Z-c4d9bbfd'
CIPHER_NAME = 'roles.sql.zst.age'
OWNER_UID = 0
ANCESTOR_STOP = Path('/')
MAX_CIPHER = 10 * 1024 * 1024


class ProofError(Exception):
    pass


def require(condition, code):
    if not condition:
        raise ProofError(code)


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise ProofError('KEY_PROOF_ARGUMENTS_INVALID')


def cipher_fd(filename, expected_sha):
    require(re.fullmatch(r'[0-9a-f]{64}', expected_sha or '') is not None,
            'KEY_PROOF_DIGEST_INVALID')
    require(os.path.isabs(filename) and '..' not in Path(filename).parts,
            'KEY_PROOF_PATH_UNSAFE')
    path = Path(filename)
    require(path == BACKUP_ROOT / CIPHER_NAME, 'KEY_PROOF_PATH_UNSAFE')
    current = BACKUP_ROOT
    while True:
        info = current.lstat()
        require(stat.S_ISDIR(info.st_mode) and not current.is_symlink()
                and info.st_uid == OWNER_UID and not info.st_mode & 0o022,
                'KEY_PROOF_DIRECTORY_UNSAFE')
        if current in (BACKUP_ROOT, BACKUP_BASE):
            require(stat.S_IMODE(info.st_mode) == 0o700, 'KEY_PROOF_DIRECTORY_UNSAFE')
        if current == ANCESTOR_STOP:
            break
        current = current.parent
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER_UID
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1
                and 0 < info.st_size <= MAX_CIPHER, 'KEY_PROOF_FILE_UNSAFE')
        digest = hashlib.sha256()
        header = os.read(fd, 22)
        require(header.startswith(b'age-encryption.org/v1\n'), 'KEY_PROOF_CIPHER_FORMAT')
        digest.update(header)
        while True:
            block = os.read(fd, 1024 * 1024)
            if not block:
                break
            digest.update(block)
        require(digest.hexdigest() == expected_sha, 'KEY_PROOF_CIPHER_SHA_MISMATCH')
        os.lseek(fd, 0, os.SEEK_SET)
        return fd, info.st_size
    except BaseException:
        os.close(fd)
        raise


def discover_tools():
    result = {}
    for name in ('age', 'zstd'):
        found = '/usr/bin/' + name
        require(os.path.exists(found), 'KEY_PROOF_TOOLS_UNAVAILABLE')
        real = os.path.realpath(found)
        info = os.stat(real)
        require(real == found and stat.S_ISREG(info.st_mode) and info.st_uid == 0
                and not info.st_mode & 0o002 and os.access(real, os.X_OK),
                'KEY_PROOF_TOOL_UNSAFE')
        result[name] = real
    return result


def verify_fd(cipher, identity, tools, timeout=30):
    require(re.fullmatch(r'AGE-SECRET-KEY-1[0-9A-Z]{58}', identity or '') is not None,
            'KEY_PROOF_IDENTITY_FORMAT')
    reader, writer = os.pipe()
    processes = []
    deadline = time.monotonic() + timeout
    environment = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C'}
    try:
        os.write(writer, (identity + '\n').encode('ascii'))
        os.close(writer)
        writer = None
        decrypt = subprocess.Popen([tools['age'], '--decrypt', '--identity', f'/dev/fd/{reader}'],
            stdin=cipher, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, pass_fds=(reader,), env=environment)
        processes.append(decrypt)
        os.close(reader)
        reader = None
        check = subprocess.Popen([tools['zstd'], '--test', '--quiet'], stdin=decrypt.stdout,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=environment)
        processes.append(check)
        decrypt.stdout.close()
        for process in processes:
            process.wait(timeout=max(0.001, deadline - time.monotonic()))
        require(all(process.returncode == 0 for process in processes), 'KEY_PROOF_DECRYPT_FAILED')
    except subprocess.TimeoutExpired:
        raise ProofError('KEY_PROOF_DEADLINE') from None
    finally:
        for fd in (reader, writer):
            if fd is not None:
                os.close(fd)
        for process in processes:
            if process.poll() is None:
                process.kill()
            process.wait()
            if process.stdout is not None and not process.stdout.closed:
                process.stdout.close()


def main(argv=None):
    fd = None
    try:
        require(sys.platform == 'linux' and os.getuid() == 0 and os.geteuid() == 0,
                'KEY_PROOF_VPS_ROOT_REQUIRED')
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        parser = Parser(description=__doc__)
        mode = parser.add_mutually_exclusive_group(required=True)
        mode.add_argument('--check', action='store_true')
        mode.add_argument('--verify', action='store_true')
        parser.add_argument('--ciphertext', required=True)
        parser.add_argument('--sha256', required=True)
        args = parser.parse_args(argv)
        fd, size = cipher_fd(args.ciphertext, args.sha256)
        tools = discover_tools()
        if args.check:
            print(json.dumps({'status': 'READY', 'cipherBytes': size,
                'cipherShaVerified': True, 'identityRequested': False}))
            return 0
        require(sys.stdin.isatty() and sys.stderr.isatty(), 'KEY_PROOF_TTY_REQUIRED')
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            identity = getpass.getpass('Ключ age из независимой копии (ввод скрыт): ').strip()
        verify_fd(fd, identity, tools)
        print(json.dumps({'status': 'PASS', 'cipherShaVerified': True, 'decryptionVerified': True,
            'plaintextStored': False, 'identityStored': False,
            'externalCustody': 'OWNER_CONFIRMATION_REQUIRED'}))
        return 0
    except (EOFError, KeyboardInterrupt, getpass.GetPassWarning):
        code = 'KEY_PROOF_INPUT_INTERRUPTED'
    except ProofError as error:
        code = str(error)
    except Exception:
        code = 'KEY_PROOF_FAILED'
    finally:
        if fd is not None:
            os.close(fd)
    print(json.dumps({'status': 'BLOCKED', 'code': code}))
    return 2


if __name__ == '__main__':
    sys.exit(main())
