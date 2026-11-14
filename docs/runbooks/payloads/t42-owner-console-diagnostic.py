#!/usr/bin/env python3
"""Bounded public-file/TTY diagnosis of T41. No recovery, secret input or exec."""
import hashlib
import json
import os
from pathlib import Path
import re
import resource
import stat
import sys
import types

sys.dont_write_bytecode = True
SELF = '/root/bron-secrets/t42-owner-console-diagnostic.py'
OWNER_UID = OWNER_GID = 0
ANCESTOR_STOP = Path('/')
RESULT_PATH = Path('/root/bron-secrets/t42-console-diagnostic/phone-result.json')
PARENT_SHA = '54c34e5abdf553fb36194aeca7f81251f1859af832b8406a48fe1520c4ae0321'
WRAPPER_SHA = 'a341b39f5740ee294f3928dee97ab3fa15b1f8afcb5a2a8374ff30f3ff1b222e'
CRYPTO_SHA = 'f5fdc144a6640d06d4c07b3782f775ced9256c1b0b941fa27449d1f96c1a04d5'
ROOT = '/root/bron-secrets/'
RECOVERY = ROOT + 't41-recovery-runtime/'
PATHS = {
    'WRAPPER': ROOT + 't41-owner-console.py',
    'MANIFEST': ROOT + 't41-owner-recovery/manifest.json',
    'MARKER': ROOT + 't41-owner-recovery/approved-manifest.sha256',
    'WORKFLOW': RECOVERY + 'docs/runbooks/payloads/t41-owner-key-recovery.py',
    'CRYPTO': RECOVERY + 'docs/runbooks/payloads/owner-key-escrow-crypto.py',
    'S3_CODE': RECOVERY + 'deploy/timeweb/backup-s3.py',
}
RELATIVES = {
    'WRAPPER': 'docs/runbooks/payloads/t41-owner-console.py',
    'WORKFLOW': 'docs/runbooks/payloads/t41-owner-key-recovery.py',
    'CRYPTO': 'docs/runbooks/payloads/owner-key-escrow-crypto.py',
    'S3_CODE': 'deploy/timeweb/backup-s3.py',
}
REMOTE_ENV = ('SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'TMUX', 'STY')
SAFE_CLASSES = frozenset(('FileNotFoundError', 'PermissionError', 'OSError',
    'TypeError', 'ValueError', 'AttributeError', 'ImportError', 'ModuleNotFoundError',
    'NameError', 'UnicodeError', 'SyntaxError', 'MemoryError', 'ConsoleError',
    'EscrowCryptoError', 'DiagnosticError'))
SAFE_CODES = frozenset((
    'OWNER_CONSOLE_EXPLICIT_ACTION_REQUIRED', 'OWNER_CONSOLE_PRIVATE_PATH_REQUIRED',
    'OWNER_CONSOLE_PRIVATE_FILE_REQUIRED', 'OWNER_CONSOLE_FILE_CHANGED',
    'OWNER_CONSOLE_ROOT_REQUIRED', 'OWNER_CONSOLE_LOCAL_TTY_REQUIRED',
    'OWNER_CONSOLE_LOCATION_INVALID', 'OWNER_CONSOLE_APPROVAL_PIN_INVALID',
    'OWNER_CONSOLE_MANIFEST_SHA_MISMATCH', 'OWNER_CONSOLE_MANIFEST_INVALID',
    'OWNER_CONSOLE_SCOPE_INVALID', 'OWNER_CONSOLE_EXECUTION_NOT_AUTHORIZED',
    'OWNER_CONSOLE_RUNTIME_PINS_REQUIRED', 'OWNER_CONSOLE_RUNTIME_PIN_INVALID',
    'OWNER_CONSOLE_RUNTIME_SHA_MISMATCH', 'ESCROW_PHYSICAL_ROOT_CONSOLE_REQUIRED',
    'ESCROW_REMOTE_SHELL_FORBIDDEN', 'ESCROW_PHYSICAL_TTY_REQUIRED',
    'ESCROW_FOREGROUND_TTY_REQUIRED', 'T42_PUBLIC_PATH_FORBIDDEN',
    'T42_ARGUMENTS_REQUIRED', 'T42_ROOT_LINUX_ISOLATED_REQUIRED',
    'T42_LOCATION_INVALID', 'T42_CORE_LIMIT_FAILED', 'T42_PUBLIC_FILE_UNSAFE',
    'T42_PUBLIC_FILE_CHANGED', 'T42_PARENT_SCOPE_INVALID', 'T42_PUBLIC_DIRECTORY_UNSAFE',
    'T42_RESULT_ALREADY_EXISTS', 'T42_RESULT_READBACK_FAILED', 'T42_RESULT_TOO_LARGE',
))
FUNCTIONS = {
    '<module>': 'MODULE', 'verify_and_guard': 'VERIFY_CHECK',
    'preliminary_console_guard': 'PRELIMINARY_TTY', 'private_bytes': 'PUBLIC_FILE_READ',
    'require': 'WRAPPER_REQUIRE', 'require_owner_console': 'CRYPTO_TTY',
    '_require': 'CRYPTO_REQUIRE',
}


class DiagnosticError(Exception):
    pass


def require(value, code):
    if not value:
        raise DiagnosticError(code)


def safe_exception(error):
    name = type(error).__name__
    answer = {'exceptionClass': name if name in SAFE_CLASSES else 'OTHER'}
    if isinstance(error, OSError) and type(error.errno) is int and 0 <= error.errno <= 4095:
        answer['errno'] = error.errno
    # Never stringify exceptions. Only a literal, predeclared code can leave this process.
    if error.args and type(error.args[0]) is str and error.args[0] in SAFE_CODES:
        answer['causeCode'] = error.args[0]
    return answer


def tty_metadata():
    answer = {'uid': os.getuid(), 'euid': os.geteuid(), 'gid': os.getgid(),
              'egid': os.getegid(), 'isolated': bool(sys.flags.isolated),
              'pythonVersion': list(sys.version_info[:3]),
              'pythonExecutable': sys.executable if re.fullmatch(
                  r'/usr/(?:local/)?bin/python3(?:\.\d+)?', sys.executable) else 'OTHER',
              'remoteIndicators': {name: bool(os.environ.get(name)) for name in REMOTE_ENV},
              'fds': []}
    try:
        group = os.getpgrp()
    except OSError:
        group = None
    for fd in (0, 1, 2):
        value = {'fd': fd}
        for operation in ('isatty', 'ttyname', 'foreground'):
            try:
                if operation == 'isatty':
                    value['isatty'] = os.isatty(fd)
                elif operation == 'ttyname':
                    name = os.ttyname(fd)
                    value['tty'] = name if re.fullmatch(
                        r'/dev/(?:tty[0-9]+|ttyS[0-9]+|hvc[0-9]+|xvc[0-9]+|console|pts/[0-9]+)', name) else 'OTHER'
                else:
                    value['foregroundMatches'] = os.tcgetpgrp(fd) == group if group is not None else False
            except OSError as error:
                value[operation + 'Error'] = safe_exception(error)
        answer['fds'].append(value)
    return answer


def metadata(path):
    try:
        info = Path(path).lstat()
        return {'exists': True, 'kind': 'file' if stat.S_ISREG(info.st_mode)
                else 'directory' if stat.S_ISDIR(info.st_mode)
                else 'symlink' if stat.S_ISLNK(info.st_mode) else 'other',
                'uid': info.st_uid, 'gid': info.st_gid,
                'mode': format(stat.S_IMODE(info.st_mode), '04o'),
                'nlink': info.st_nlink, 'bytes': info.st_size}
    except OSError as error:
        return {'exists': False, **safe_exception(error)}


def read_public(path, maximum=1048576):
    require(str(path) in PATHS.values(), 'T42_PUBLIC_PATH_FORBIDDEN')
    check_directories(Path(path).parent)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == OWNER_UID
                and before.st_gid == OWNER_GID and stat.S_IMODE(before.st_mode) == 0o600
                and before.st_nlink == 1 and 0 < before.st_size <= maximum,
                'T42_PUBLIC_FILE_UNSAFE')
        data = os.read(fd, maximum + 1)
        after = os.fstat(fd)
        named = Path(path).lstat()
        require(len(data) == before.st_size and
                (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) and
                (after.st_dev, after.st_ino) == (named.st_dev, named.st_ino),
                'T42_PUBLIC_FILE_CHANGED')
        return data
    finally:
        os.close(fd)


def check_directories(directory):
    current = Path(directory)
    while True:
        info = current.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == OWNER_UID
                and info.st_gid == OWNER_GID and not info.st_mode & 0o022,
                'T42_PUBLIC_DIRECTORY_UNSAFE')
        if current == ANCESTOR_STOP:
            break
        require(current != current.parent, 'T42_PUBLIC_DIRECTORY_UNSAFE')
        current = current.parent


def claim_result():
    check_directories(RESULT_PATH.parent)
    require(stat.S_IMODE(RESULT_PATH.parent.lstat().st_mode) == 0o700,
            'T42_PUBLIC_DIRECTORY_UNSAFE')
    try:
        return os.open(RESULT_PATH, os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        raise DiagnosticError('T42_RESULT_ALREADY_EXISTS') from None


def persist_result(fd, value):
    raw = (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()
    require(len(raw) <= 32768, 'T42_RESULT_TOO_LARGE')
    remaining = memoryview(raw)
    while remaining:
        remaining = remaining[os.write(fd, remaining):]
    os.fsync(fd)
    os.lseek(fd, 0, os.SEEK_SET)
    require(os.read(fd, len(raw) + 1) == raw, 'T42_RESULT_READBACK_FAILED')
    info = os.fstat(fd)
    named = RESULT_PATH.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_uid == OWNER_UID
            and info.st_gid == OWNER_GID and stat.S_IMODE(info.st_mode) == 0o600
            and info.st_nlink == 1 and (info.st_dev, info.st_ino) == (named.st_dev, named.st_ino),
            'T42_RESULT_READBACK_FAILED')
    directory = os.open(RESULT_PATH.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(directory)
    finally:
        os.close(directory)
    return hashlib.sha256(raw).hexdigest()


def inspect_files():
    inventory = {key: metadata(path) for key, path in PATHS.items()}
    captured = {}
    expected = {'WRAPPER': WRAPPER_SHA, 'MANIFEST': PARENT_SHA, 'CRYPTO': CRYPTO_SHA,
                'MARKER': hashlib.sha256((PARENT_SHA + '\n').encode()).hexdigest()}
    # A pinned public parent supplies only the remaining public-code hashes.
    try:
        parent = read_public(PATHS['MANIFEST'])
        require(hashlib.sha256(parent).hexdigest() == PARENT_SHA, 'T42_PARENT_SCOPE_INVALID')
        parsed = json.loads(parent)
        require(parsed.get('task') == 'T41', 'T42_PARENT_SCOPE_INVALID')
        for key, relative in RELATIVES.items():
            value = parsed.get('files', {}).get(relative)
            require(type(value) is str and re.fullmatch(r'[0-9a-f]{64}', value)
                    and (key not in expected or expected[key] == value), 'T42_PARENT_SCOPE_INVALID')
            expected[key] = value
    except Exception as error:
        inventory['MANIFEST']['status'] = 'BLOCKED'
        inventory['MANIFEST'].update(safe_exception(error))
    for key, path in PATHS.items():
        row = inventory[key]
        if row.get('status') == 'BLOCKED':
            continue
        if key not in expected:
            row['status'] = 'PIN_UNAVAILABLE'
            continue
        try:
            raw = read_public(path, 65 if key == 'MARKER' else 1048576)
            digest = hashlib.sha256(raw).hexdigest()
            row.update({'sha256': digest, 'shaMatches': digest == expected[key]})
            row['status'] = 'MATCH' if digest == expected[key] else 'PIN_MISMATCH'
            if row['status'] == 'MATCH':
                captured[key] = raw
        except Exception as error:
            row['status'] = 'BLOCKED'
            row.update(safe_exception(error))
    return inventory, captured


def load_wrapper(raw):
    module = types.ModuleType('bron_t42_pinned_t41_wrapper')
    module.__file__ = PATHS['WRAPPER']
    exec(compile(raw, module.__file__, 'exec', dont_inherit=True), module.__dict__)
    return module


def failure_frames(error):
    allowed = {PATHS['WRAPPER']: 'WRAPPER', PATHS['CRYPTO']: 'CRYPTO'}
    frames = []
    tb = error.__traceback__
    while tb is not None:
        code = tb.tb_frame.f_code
        file_id, function_id = allowed.get(code.co_filename), FUNCTIONS.get(code.co_name)
        if file_id and function_id:
            frames.append({'fileId': file_id, 'functionId': function_id, 'line': tb.tb_lineno})
        tb = tb.tb_next
    return frames[-8:]


def evaluate(mode):
    result = {'format': 1, 'task': 'T42', 'mode': mode, 'status': 'BLOCKED',
              'phase': 'PUBLIC_FILE_INSPECTION', 'terminal': tty_metadata(),
              'recoveryRun': False, 'workflowExecuted': False, 'secretInputRequested': False,
              'sourceOrDatabaseAccess': False, 'networkRequested': False,
              'diagnosticIsOwnerRecoveryProof': False}
    inventory, captured = inspect_files()
    result['files'] = inventory
    blocked = [key for key, row in inventory.items() if row.get('status') != 'MATCH']
    if blocked:
        result.update({'code': 'T42_PUBLIC_FILES_BLOCKED', 'fileId': blocked[0]})
        return result
    if mode == '--inspect-files':
        result.update({'status': 'INSPECTION_COMPLETE', 'code': 'T42_PUBLIC_FILES_MATCH',
                       'cryptoImported': False, 'ownerTtyGuardInvoked': False})
        return result
    phase, current_file = 'WRAPPER_IMPORT', None
    try:
        wrapper = load_wrapper(captured['WRAPPER'])
        original = wrapper.private_bytes
        def checked_read(filename, maximum):
            nonlocal current_file, phase
            current_file = next((key for key, path in PATHS.items() if str(filename) == path), None)
            require(current_file is not None, 'T42_PUBLIC_PATH_FORBIDDEN')
            phase = 'WRAPPER_PUBLIC_FILE_READ'
            return original(filename, maximum)
        wrapper.private_bytes = checked_read
        phase = 'PRELIMINARY_TTY'
        command = wrapper.verify_and_guard('check')  # Never main(), execve(), or workflow.
        require(command == [wrapper.PYTHON, '-I', PATHS['WORKFLOW'], '--check',
                '--manifest', PATHS['MANIFEST'], '--manifest-sha256', PARENT_SHA],
                'T42_PARENT_SCOPE_INVALID')
        result.update({'status': 'CHECK_PATH_COMPLETE_NO_EXEC', 'phase': 'COMPLETE',
                       'code': 'T42_WRAPPER_CHECK_PATH_PASSED', 'ownerTtyGuardInvoked': True})
    except Exception as error:
        frames = failure_frames(error)
        if any(row['fileId'] == 'CRYPTO' for row in frames):
            phase, current_file = 'PINNED_CRYPTO_IMPORT_OR_TTY', 'CRYPTO'
        result.update({'code': 'T42_WRAPPER_CHECK_PATH_BLOCKED', 'phase': phase,
                       'frames': frames, **safe_exception(error)})
        if current_file:
            result['fileId'] = current_file
    return result


def main(argv=None):
    result_fd = None
    try:
        arguments = sys.argv[1:] if argv is None else argv
        require(len(arguments) == 1 and arguments[0] in ('--inspect-files', '--diagnose'),
                'T42_ARGUMENTS_REQUIRED')
        require(sys.platform == 'linux' and os.getuid() == 0 and os.geteuid() == 0
                and os.getgid() == 0 and os.getegid() == 0 and bool(sys.flags.isolated),
                'T42_ROOT_LINUX_ISOLATED_REQUIRED')
        require(__file__ == SELF, 'T42_LOCATION_INVALID')
        try:
            resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        except (OSError, ValueError):
            raise DiagnosticError('T42_CORE_LIMIT_FAILED') from None
        if arguments[0] == '--diagnose':
            result_fd = claim_result()  # Own diagnostic artifact; never redirect owner stdio.
        result = evaluate(arguments[0])
    except (KeyboardInterrupt, EOFError):
        result = {'format': 1, 'task': 'T42', 'status': 'BLOCKED',
                  'code': 'T42_DIAGNOSTIC_INTERRUPTED'}
    except Exception as error:
        result = {'format': 1, 'task': 'T42', 'status': 'BLOCKED',
                  'code': 'T42_DIAGNOSTIC_BLOCKED', **safe_exception(error)}
    if result_fd is not None:
        try:
            result['diagnosticResultSha256'] = persist_result(result_fd, result)
        except Exception as error:
            result = {'format': 1, 'task': 'T42', 'status': 'BLOCKED',
                      'code': 'T42_DIAGNOSTIC_RESULT_WRITE_FAILED', **safe_exception(error)}
        finally:
            os.close(result_fd)
    visible = {key: value for key, value in result.items() if key not in ('files', 'terminal')}
    print(json.dumps(visible if result_fd is not None else result, sort_keys=True))
    return 0 if result['status'] in ('INSPECTION_COMPLETE', 'CHECK_PATH_COMPLETE_NO_EXEC') else 2


if __name__ == '__main__':
    raise SystemExit(main())
