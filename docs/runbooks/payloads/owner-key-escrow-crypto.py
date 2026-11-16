#!/usr/bin/env python3
"""Narrow native age crypto API; the pinned owner workflow owns authorization/S3.

No command-line secret input or standalone execution is supported. Production
uses only /usr/bin/age 1.1.1 and /usr/bin/zstd. Explicit tools arguments exist
solely for synthetic integration tests and are never a VPS proof.
"""
import errno
import fcntl
import getpass
import os
import pty
import re
import resource
import select
import signal
import stat
import subprocess
import sys
import termios
import time
import unicodedata
import warnings

OWNER_UID = 0
MAX_IDENTITY = 16 * 1024
MAX_WRAPPED_IDENTITY = 64 * 1024
MAX_BACKUP = 10 * 1024 * 1024
MAX_TERMINAL_BYTES = 32 * 1024
SAFE_ENV = {'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C', 'TERM': 'dumb'}
ORIGINAL_IDENTITY_PATH = '/root/bron-secrets/source-backup.agekey'


class EscrowCryptoError(Exception):
    """Contains a fixed safe code, never native output or a secret."""


def _require(condition, code):
    if not condition:
        raise EscrowCryptoError(code)


def require_owner_console():
    """Require local physical root TTY; device ownership is a separate gate.

    A PTY from ssh -tt, tmux, screen, pipes or a browser's command-runner is not
    accepted. This does not prove which physical device displays a VNC console.
    """
    _require(sys.platform == 'linux' and os.getuid() == 0 and os.geteuid() == 0
             and os.getgid() == 0 and os.getegid() == 0,
             'ESCROW_PHYSICAL_ROOT_CONSOLE_REQUIRED')
    _require(not any(os.environ.get(name) for name in
                     ('SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'TMUX', 'STY')),
             'ESCROW_REMOTE_SHELL_FORBIDDEN')
    devices = []
    try:
        for fd in (0, 1, 2):
            _require(os.isatty(fd), 'ESCROW_PHYSICAL_TTY_REQUIRED')
            name = os.ttyname(fd)
            _require(re.fullmatch(r'/dev/(?:tty[0-9]+|ttyS[0-9]+|hvc[0-9]+|xvc[0-9]+|console)', name)
                     is not None, 'ESCROW_PHYSICAL_TTY_REQUIRED')
            info = os.fstat(fd)
            _require(stat.S_ISCHR(info.st_mode), 'ESCROW_PHYSICAL_TTY_REQUIRED')
            _require(os.tcgetpgrp(fd) == os.getpgrp(), 'ESCROW_FOREGROUND_TTY_REQUIRED')
            devices.append(info.st_rdev)
        _require(len(set(devices)) == 1, 'ESCROW_PHYSICAL_TTY_REQUIRED')
        tty_fd = os.open('/dev/tty', os.O_RDWR | os.O_NOCTTY | os.O_CLOEXEC)
        try:
            _require(os.isatty(tty_fd) and os.tcgetpgrp(tty_fd) == os.getpgrp(),
                     'ESCROW_FOREGROUND_TTY_REQUIRED')
        finally:
            os.close(tty_fd)
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    except EscrowCryptoError:
        raise
    except (OSError, ValueError):
        raise EscrowCryptoError('ESCROW_PHYSICAL_TTY_REQUIRED') from None
    return {'physicalRootConsole': True, 'phoneOwnership': 'OWNER_ATTESTATION_REQUIRED'}


def _validate_passphrase(phrase):
    _require(isinstance(phrase, str), 'ESCROW_PASSPHRASE_INVALID')
    _require(20 <= len(phrase) <= 1024
             and len(set(phrase)) >= 4 and len(phrase.strip()) >= 20
             and not any(unicodedata.category(char).startswith('C') for char in phrase)
             and len(phrase.encode('utf-8')) <= 1024,
             'ESCROW_PASSPHRASE_INVALID')


def read_owner_passphrase(confirm=True):
    """Hidden TTY input only; no identity/key file is opened by this function."""
    require_owner_console()
    phrase = confirmation = None
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', getpass.GetPassWarning)
            phrase = getpass.getpass('Новая фраза восстановления (ввод скрыт): ' if confirm
                                     else 'Фраза из вашей независимой копии (ввод скрыт): ')
            _validate_passphrase(phrase)
            if confirm:
                confirmation = getpass.getpass('Повторите фразу (ввод скрыт): ')
                _require(phrase == confirmation, 'ESCROW_PASSPHRASE_CONFIRMATION_FAILED')
        return phrase
    except (EOFError, KeyboardInterrupt, getpass.GetPassWarning):
        raise EscrowCryptoError('ESCROW_OWNER_INPUT_INTERRUPTED') from None
    finally:
        # Python strings cannot promise zeroization. Neither value is persisted,
        # interpolated into exceptions, argv/environment, or terminal output.
        confirmation = None


def discover_tools():
    tools = {'age': '/usr/bin/age', 'zstd': '/usr/bin/zstd'}
    for path in tools.values():
        try:
            info = os.lstat(path)
            _require(stat.S_ISREG(info.st_mode) and info.st_uid == 0
                     and not info.st_mode & 0o022 and os.access(path, os.X_OK),
                     'ESCROW_NATIVE_TOOL_UNSAFE')
        except OSError:
            raise EscrowCryptoError('ESCROW_NATIVE_TOOL_UNAVAILABLE') from None
    try:
        result = subprocess.run([tools['age'], '--version'], stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, env=SAFE_ENV, timeout=5,
                                check=False, close_fds=True)
        _require(result.returncode == 0 and result.stdout.strip() in (b'1.1.1', b'v1.1.1'),
                 'ESCROW_AGE_VERSION_MISMATCH')
    except (OSError, subprocess.TimeoutExpired):
        raise EscrowCryptoError('ESCROW_NATIVE_TOOL_UNAVAILABLE') from None
    return tools


def _regular_fd(fd, maximum, output=False):
    try:
        _require(isinstance(fd, int) and fd >= 3, 'ESCROW_FILE_UNSAFE')
        info = os.fstat(fd)
        mode = fcntl.fcntl(fd, fcntl.F_GETFL) & os.O_ACCMODE
        _require(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER_UID
                 and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
                 'ESCROW_FILE_UNSAFE')
        _require((output and mode == os.O_RDWR and info.st_size == 0
                  and os.lseek(fd, 0, os.SEEK_CUR) == 0)
                 or (not output and mode == os.O_RDONLY and 0 < info.st_size <= maximum),
                 'ESCROW_FILE_UNSAFE')
        return info
    except EscrowCryptoError:
        raise
    except (OSError, ValueError):
        raise EscrowCryptoError('ESCROW_FILE_UNSAFE') from None


def _child_limits():
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_WRAPPED_IDENTITY, MAX_WRAPPED_IDENTITY))
    resource.setrlimit(resource.RLIMIT_CPU, (60, 60))
    os.umask(0o077)


def _kill_and_reap(pid):
    if pid is None:
        return
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    # fork() can fail before login_tty()/setsid() creates pid's process group.
    # Kill our still-owned direct child as well, avoiding an unbounded reap.
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass


def _age_terminal(argv, input_fd, output_fd, passphrase, confirm, deadline, identity_fd=None):
    """Feed age's private controlling PTY; never relay its stderr to the owner."""
    _validate_passphrase(passphrase)
    _require(0 < deadline - time.monotonic() <= 90, 'ESCROW_DEADLINE_INVALID')
    pid = master = None
    status = None
    expected = [b'Enter passphrase', b'Confirm passphrase'] if confirm else [b'Enter passphrase']
    step = total = 0
    pending = b''
    phrase_bytes = (passphrase + '\n').encode('utf-8')
    try:
        pid, master = pty.fork()
        if pid == 0:
            try:
                _child_limits()
                os.dup2(input_fd, 0)
                os.dup2(output_fd, 1)
                if identity_fd is not None:
                    os.dup2(identity_fd, 3, inheritable=True)
                os.closerange(4 if identity_fd is not None else 3,
                              min(resource.getrlimit(resource.RLIMIT_NOFILE)[0], 1048576))
                os.execve(argv[0], argv, SAFE_ENV)
            except BaseException:
                os._exit(126)
        attrs = termios.tcgetattr(master)
        attrs[3] &= ~(termios.ECHO | termios.ECHONL)
        termios.tcsetattr(master, termios.TCSANOW, attrs)
        os.set_blocking(master, False)
        while True:
            _require(time.monotonic() < deadline, 'ESCROW_CRYPTO_DEADLINE')
            ready, _, _ = select.select([master], [], [], min(0.1, max(0, deadline - time.monotonic())))
            if ready:
                try:
                    block = os.read(master, 4096)
                except OSError as error:
                    if error.errno == errno.EIO:
                        block = b''
                    elif error.errno in (errno.EAGAIN, errno.EWOULDBLOCK):
                        block = None
                    else:
                        raise
                if block:
                    total += len(block)
                    _require(total <= MAX_TERMINAL_BYTES, 'ESCROW_NATIVE_OUTPUT_LIMIT')
                    pending += block
                    if step < len(expected):
                        marker = pending.find(expected[step])
                        if marker >= 0 and b': ' in pending[marker:]:
                            remaining = memoryview(phrase_bytes)
                            while remaining:
                                _require(time.monotonic() < deadline, 'ESCROW_CRYPTO_DEADLINE')
                                try:
                                    written = os.write(master, remaining)
                                    remaining = remaining[written:]
                                except BlockingIOError:
                                    select.select([], [master], [], min(0.1, max(0, deadline - time.monotonic())))
                            pending = b''
                            step += 1
                    elif b'Enter passphrase' in pending or b'Confirm passphrase' in pending:
                        raise EscrowCryptoError('ESCROW_UNEXPECTED_SECRET_PROMPT')
            waited, raw = os.waitpid(pid, os.WNOHANG)
            if waited:
                status = os.waitstatus_to_exitcode(raw)
                pid = None
                break
        _require(status == 0 and step == len(expected), 'ESCROW_NATIVE_CRYPTO_FAILED')
    except EscrowCryptoError:
        raise
    except (OSError, ValueError):
        raise EscrowCryptoError('ESCROW_NATIVE_CRYPTO_FAILED') from None
    finally:
        _kill_and_reap(pid)
        if master is not None:
            os.close(master)
        pending = phrase_bytes = None


def seal_identity(identity_fd, output_fd, passphrase, tools=None, timeout=45):
    """Encrypt an existing raw identity FD to an exclusive empty ciphertext FD.

    Caller created output_fd with O_CREAT|O_EXCL|O_NOFOLLOW and owns its path.
    Native stdout goes directly into this FD; age stderr is private/discarded.
    """
    _require(0 < timeout <= 90, 'ESCROW_DEADLINE_INVALID')
    _validate_passphrase(passphrase)
    _regular_fd(identity_fd, MAX_IDENTITY)
    _regular_fd(output_fd, MAX_WRAPPED_IDENTITY, output=True)
    _require(identity_fd != output_fd, 'ESCROW_FILE_UNSAFE')
    tools = discover_tools() if tools is None else tools
    os.lseek(identity_fd, 0, os.SEEK_SET)
    _age_terminal([tools['age'], '--passphrase'], identity_fd, output_fd, passphrase,
                  True, time.monotonic() + timeout)
    os.fsync(output_fd)
    info = os.fstat(output_fd)
    _require(0 < info.st_size <= MAX_WRAPPED_IDENTITY, 'ESCROW_CIPHERTEXT_SIZE_INVALID')
    header = os.pread(output_fd, min(info.st_size, 512), 0)
    _require(header.startswith(b'age-encryption.org/v1\n-> scrypt ')
             and header.count(b'\n-> ') == 1, 'ESCROW_SCRYPT_FORMAT_REQUIRED')
    return {'status': 'SEALED', 'method': 'AGE_SCRYPT_ENCRYPTED_IDENTITY',
            'cipherBytes': info.st_size, 'plaintextIdentityStored': False}


def verify_encrypted_identity(cipher_identity_path, backup_fd, passphrase, tools=None, timeout=45):
    """Use downloaded encrypted identity only; never open original raw identity.

    age's decrypted compressed backup is piped straight into zstd --test.
    Plaintext identity/SQL and native errors never reach stdout or a file.
    """
    _require(0 < timeout <= 90, 'ESCROW_DEADLINE_INVALID')
    _validate_passphrase(passphrase)
    _regular_fd(backup_fd, MAX_BACKUP)
    tools = discover_tools() if tools is None else tools
    deadline = time.monotonic() + timeout
    encrypted_fd = None
    check = None
    try:
        _require(isinstance(cipher_identity_path, (str, os.PathLike))
                 and os.path.isabs(cipher_identity_path)
                 and os.path.normpath(cipher_identity_path) != ORIGINAL_IDENTITY_PATH,
                 'ESCROW_ORIGINAL_IDENTITY_VERIFY_FORBIDDEN')
        encrypted_fd = os.open(cipher_identity_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
        _regular_fd(encrypted_fd, MAX_WRAPPED_IDENTITY)
        header = os.pread(encrypted_fd, 512, 0)
        _require(header.startswith(b'age-encryption.org/v1\n-> scrypt ')
                 and header.count(b'\n-> ') == 1, 'ESCROW_SCRYPT_FORMAT_REQUIRED')
        os.lseek(backup_fd, 0, os.SEEK_SET)
        check = subprocess.Popen([tools['zstd'], '--test', '--quiet', '--memory=64MB'],
                                 stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, env=SAFE_ENV,
                                 close_fds=True, start_new_session=True,
                                 preexec_fn=_child_limits)
        _age_terminal([tools['age'], '--decrypt', '--identity', '/dev/fd/3'],
                      backup_fd, check.stdin.fileno(), passphrase, False,
                      deadline, identity_fd=encrypted_fd)
        check.stdin.close()
        try:
            check.wait(timeout=max(0.001, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise EscrowCryptoError('ESCROW_CRYPTO_DEADLINE') from None
        _require(check.returncode == 0, 'ESCROW_BACKUP_DECOMPRESS_FAILED')
        return {'status': 'PASS', 'method': 'AGE_SCRYPT_ENCRYPTED_IDENTITY',
                'downloadedCiphertextUsed': True, 'originalIdentityRead': False,
                'backupDecryptionVerified': True, 'zstdTestVerified': True,
                'plaintextStored': False}
    except EscrowCryptoError:
        raise
    except (OSError, ValueError):
        raise EscrowCryptoError('ESCROW_ENCRYPTED_IDENTITY_VERIFY_FAILED') from None
    finally:
        if check is not None:
            if check.stdin is not None and not check.stdin.closed:
                check.stdin.close()
            if check.poll() is None:
                try:
                    os.killpg(check.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            check.wait()
        if encrypted_fd is not None:
            os.close(encrypted_fd)


if __name__ == '__main__':
    print('ESCROW_PINNED_OWNER_WORKFLOW_REQUIRED')
    raise SystemExit(2)
