#!/usr/bin/env python3
"""Exact lock-file permission repair only; no database, secret or network I/O."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import resource
import stat
import sys

sys.dont_write_bytecode = True
ROOT = Path('/root/bron-secrets')
STATE = ROOT / 't47-lock-mode'
SELF = ROOT / 't47-lock-mode.py'
MANIFEST = STATE / 'manifest.json'
REL = 'docs/runbooks/payloads/t47-lock-mode.py'
LOCK = Path('/opt/bron/rehearsal-audit.exfSfv9a/package-lock.json')
LOCK_SHA = 'a100d1e53b1923fa350912eac4cb82a330e7390f79949f3346295fefab0b8b69'
T45 = ROOT / 't45-release'
PARENT_SHA = '67b2bb6c7b72ef39bd66dbb2e008f177fb5b38ae9713e052ad8aee0aa5182ad8'
OLD_RECEIPT = ROOT / 't45-release-receipt.json'
OLD_SHA = '65a61c2888b96ba9a8ae9870fcbb95c9edc624c3fc2cec2d4a25352fe2d82d37'


class Blocked(Exception):
    pass


def require(ok, code):
    if not ok:
        raise Blocked(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encode(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':')) + '\n').encode()


def directory(p):
    s = p.lstat()
    require(stat.S_ISDIR(s.st_mode) and s.st_uid == s.st_gid == 0 and not s.st_mode & 0o022,
            'T47_DIRECTORY_UNSAFE')


def absent(p):
    try:
        p.lstat()
    except FileNotFoundError:
        return
    raise Blocked('T47_EXPECTED_ABSENT_PATH_PRESENT')


def content(fd):
    os.lseek(fd, 0, os.SEEK_SET)
    raw = os.read(fd, 1048577)
    require(0 < len(raw) <= 1048576, 'T47_FILE_BOUND')
    return raw


def private(p, expected=None):
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        s = os.fstat(fd)
        require(stat.S_ISREG(s.st_mode) and s.st_uid == s.st_gid == 0 and s.st_nlink == 1
                and stat.S_IMODE(s.st_mode) == 0o600, 'T47_PRIVATE_FILE_UNSAFE')
        raw = content(fd)
        after, named = os.fstat(fd), p.lstat()
        require(len(raw) == s.st_size and (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) and
                (named.st_dev, named.st_ino) == (s.st_dev, s.st_ino) and
                (expected is None or sha(raw) == expected), 'T47_METADATA_PIN_MISMATCH')
        return raw
    finally:
        os.close(fd)


def save(p, raw):
    fd = os.open(p, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb', closefd=False) as stream:
            stream.write(raw)
            stream.flush()
            os.fsync(fd)
    finally:
        os.close(fd)
    d = os.open(p.parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(d)
    finally:
        os.close(d)
    require(private(p) == raw, 'T47_WRITE_READBACK_FAILED')


def main():
    fd, guarded = None, False
    result = {'task': 'T47', 'status': 'BLOCKED', 'modeChangeOutcome': 'NOT_ATTEMPTED',
              'sourceActions': 0, 'databaseQueries': 0, 'secretReads': 0, 'retryAuthorized': False}
    phase = 'activation'
    try:
        require(sys.platform == 'linux' and os.getuid() == os.getgid() == 0 and
                sys.flags.isolated and Path(__file__) == SELF, 'T47_PINNED_ROOT_RUNTIME')
        os.umask(0o077)
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
        parser = argparse.ArgumentParser()
        parser.add_argument('--manifest', required=True)
        parser.add_argument('--sha256', required=True)
        args = parser.parse_args()
        require(args.manifest == str(MANIFEST), 'T47_MANIFEST_PATH')
        for p in (Path('/root'), ROOT, STATE, T45, Path('/opt'), Path('/opt/bron'), LOCK.parent):
            directory(p)
        require(stat.S_IMODE(STATE.lstat().st_mode) == 0o700, 'T47_STATE_MODE')
        m = json.loads(private(MANIFEST, args.sha256))
        require(m.get('task') == 'T47' and m.get('execution_authorized') is True and
                m.get('actionId') == 'T47.repair_lock_mode_and_resume_prepare' and
                m.get('additionalPrepareFinalInvocations') == 1 and
                m.get('priorPrepareFinalInvocations') == 1 and m.get('guardPreviouslyClaimed') is False and
                m.get('lockPath') == str(LOCK) and m.get('lockSha256') == LOCK_SHA and
                m.get('fromMode') == '0664' and m.get('toMode') == '0644', 'T47_SCOPE')
        private(SELF, m['files'][REL])
        private(T45 / 'manifest.json', PARENT_SHA)
        old = private(OLD_RECEIPT, OLD_SHA)
        for name in ('final-prepare.guard', 'final-capability', 'final-base-prepared.json',
                     'final-run.guard', 'final-result.json', 'source-fence-approved.json'):
            absent(T45 / name)
        for name in ('guard.json', 'result.json', 'prior-T45-blocked-receipt.json'):
            absent(STATE / name)
        phase = 'lock-preflight'
        fd = os.open(LOCK, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_uid == before.st_gid == 0 and
                before.st_nlink == 1 and stat.S_IMODE(before.st_mode) == 0o664 and
                sha(content(fd)) == LOCK_SHA, 'T47_LOCK_PRECONDITION')
        named = LOCK.lstat()
        require((before.st_dev, before.st_ino) == (named.st_dev, named.st_ino), 'T47_LOCK_CHANGED')
        phase = 'claim'
        guard_fd = os.open(STATE / 'guard.json', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        guarded = True
        try:
            raw = encode({'task': 'T47', 'manifestSha256': args.sha256, 'oldReceiptSha256': OLD_SHA,
                          'lockSha256': LOCK_SHA, 'fromMode': '0664', 'toMode': '0644',
                          'priorPrepareFinalInvocations': 1, 'additionalPrepareFinalInvocations': 1})
            with os.fdopen(guard_fd, 'wb', closefd=False) as stream:
                stream.write(raw); stream.flush(); os.fsync(guard_fd)
        finally:
            os.close(guard_fd)
        d = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            os.fsync(d)
        finally:
            os.close(d)
        require(private(STATE / 'guard.json') == raw, 'T47_GUARD_READBACK')
        save(STATE / 'prior-T45-blocked-receipt.json', old)
        phase = 'mode-change'
        result['modeChangeOutcome'] = 'UNKNOWN'
        os.fchmod(fd, 0o644)
        os.fsync(fd)
        after, named = os.fstat(fd), LOCK.lstat()
        require(stat.S_ISREG(after.st_mode) and after.st_uid == after.st_gid == 0 and after.st_nlink == 1 and
                stat.S_IMODE(after.st_mode) == 0o644 and
                (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) ==
                (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) and
                (named.st_dev, named.st_ino) == (after.st_dev, after.st_ino) and
                sha(content(fd)) == LOCK_SHA, 'T47_LOCK_POSTCONDITION')
        result.update(status='PASS', modeChangeOutcome='VERIFIED', oldMode='0664', newMode='0644',
                      lockSha256=LOCK_SHA, oldReceiptSha256=OLD_SHA, guardPreviouslyClaimed=False,
                      priorPrepareFinalInvocations=1, additionalPrepareFinalInvocations=1,
                      prepareFinalInvocationsExecutedByT47=0)
    except BaseException as e:
        result.update(status='BLOCKED', phase=phase, code=str(e) if isinstance(e, Blocked) else 'T47_FAILED')
    finally:
        if fd is not None:
            os.close(fd)
    if guarded:
        try:
            save(STATE / 'result.json', encode(result))
        except BaseException:
            result.update(status='BLOCKED', phase='result-durability', code='T47_RESULT_DURABILITY_FAILED')
    print('T47_RESULT ' + result['status'])
    print(json.dumps(result, sort_keys=True))
    return 0 if result['status'] == 'PASS' else 2


if __name__ == '__main__':
    raise SystemExit(main())
