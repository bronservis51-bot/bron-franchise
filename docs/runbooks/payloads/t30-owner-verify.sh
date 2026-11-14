#!/usr/bin/env bash
# Run PERSONALLY from a phone/second-device AdminVPS console, never from the Mac.
# The approved helper alone reads the hidden identity; this shell never sees it.
set -euo pipefail
umask 077

t30_cipher_sha=$(/usr/bin/python3 -I - <<'PY'
import hashlib, json, os, stat, sys
try:
    if sys.platform != 'linux' or os.getuid() != 0:
        raise RuntimeError()
    private = '/root/bron-secrets'
    info = os.lstat(private)
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or stat.S_IMODE(info.st_mode) != 0o700:
        raise RuntimeError()
    def read_private(path, maximum):
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        try:
            item = os.fstat(fd)
            if not stat.S_ISREG(item.st_mode) or item.st_uid != 0 or item.st_nlink != 1 or stat.S_IMODE(item.st_mode) != 0o600 or item.st_size > maximum:
                raise RuntimeError()
            return os.read(fd, maximum + 1)
        finally:
            os.close(fd)
    helper = read_private(private + '/t29-owner-key-proof.py', 65536)
    if hashlib.sha256(helper).hexdigest() != '5b67358a605d8280a5477ea1d335d28a5bf9ecf6798d6b5328dd60483a1b4c7f':
        raise RuntimeError()
    data = read_private('/var/backups/bron-franchise/target-20261113T133022Z-c4d9bbfd/manifest.json', 262144)
    if hashlib.sha256(data).hexdigest() != 'a1f6a1c9f187bd586aeec5d0189adc4f6648df29acb8c68490bf4fc77541d6b9':
        raise RuntimeError()
    artifacts = [x for x in json.loads(data)['artifacts'] if x.get('file') == 'roles.sql.zst.age']
    if len(artifacts) != 1:
        raise RuntimeError()
    digest = artifacts[0]['sha256']
    if not isinstance(digest, str) or len(digest) != 64 or any(x not in '0123456789abcdef' for x in digest):
        raise RuntimeError()
    result = private + '/t30-owner-key-proof-result.json'
    if os.path.lexists(result):
        read_private(result, 4096)
    print(digest)
except Exception:
    print('T30_OWNER_PREFLIGHT_BLOCKED', file=sys.stderr)
    sys.exit(2)
PY
)

printf '%s\n' 'Введите только строку AGE-SECRET-KEY-… из независимой копии. Ввод скрыт. Не используйте ключ из файла на этом VPS.'
/usr/bin/python3 -I /root/bron-secrets/t29-owner-key-proof.py \
  --verify \
  --ciphertext /var/backups/bron-franchise/target-20261113T133022Z-c4d9bbfd/roles.sql.zst.age \
  --sha256 "$t30_cipher_sha" | /usr/bin/tee /root/bron-secrets/t30-owner-key-proof-result.json
