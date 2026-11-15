import ctypes
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('morning_static_publish', ROOT / 'docs/runbooks/payloads/morning-static-publish.py')
PUB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(PUB)


def package(extra=None):
    files = {'index.html': b'<html></html>', 'app-version.json': b'{"build":"test"}',
             'manifest.webmanifest': b'{"scope":"/","start_url":"/"}', 'sw.js': b'//sw',
             'assets/main-new12345.js': b'new JS'}
    manifest = json.dumps({'format': 1, 'base': '/', 'apiOrigin': 'https://api.bronservis.ru',
                          'sourceCommit': 'a' * 40, 'files': [{'file': name, 'bytes': len(value),
                          'sha256': hashlib.sha256(value).hexdigest()} for name, value in files.items()]}).encode()
    files['release-manifest.json'] = manifest
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w') as archive:
        for name, value in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(value)
            archive.addfile(info, io.BytesIO(value))
        if extra:
            archive.addfile(*extra)
    raw = output.getvalue()
    return raw, {'archiveSha256': PUB.digest(raw), 'manifestSha256': PUB.digest(manifest), 'sourceCommit': 'a' * 40}


class StaticPublishTests(unittest.TestCase):
    def test_exact_manifest_archive(self):
        raw, pin = package()
        self.assertEqual(len(PUB.scan_archive(raw, pin)), 6)

    def test_path_traversal_refused_before_extract(self):
        info = tarfile.TarInfo('../escape')
        info.size = 1
        raw, pin = package((info, io.BytesIO(b'x')))
        with self.assertRaisesRegex(PUB.Blocked, 'UNSAFE_ARTIFACT_PATH'):
            PUB.scan_archive(raw, pin)

    def test_symlink_and_duplicate_refused(self):
        info = tarfile.TarInfo('assets/link')
        info.type, info.linkname = tarfile.SYMTYPE, '/etc/passwd'
        raw, pin = package((info, None))
        with self.assertRaisesRegex(PUB.Blocked, 'TAR_LINK_OR_SPECIAL'):
            PUB.scan_archive(raw, pin)
        info = tarfile.TarInfo('index.html')
        raw, pin = package((info, io.BytesIO(b'')))
        with self.assertRaisesRegex(PUB.Blocked, 'DUPLICATE_TAR_PATH'):
            PUB.scan_archive(raw, pin)

    def test_unlisted_content_refused(self):
        info = tarfile.TarInfo('secret.txt')
        raw, pin = package((info, io.BytesIO(b'')))
        with self.assertRaisesRegex(PUB.Blocked, 'UNLISTED_OR_MISSING_CONTENT'):
            PUB.scan_archive(raw, pin)

    def test_retain_old_assets_without_old_html_or_sw(self):
        new = {'index.html': b'new', 'sw.js': b'new worker', 'assets/same.js': b'same'}
        retained = PUB.retain_assets(new, {'assets/same.js': b'same', 'assets/old-hash123.js': b'old'})
        self.assertEqual(retained, ['assets/old-hash123.js'])
        self.assertEqual(new['index.html'], b'new')
        self.assertEqual(new['assets/old-hash123.js'], b'old')
        with self.assertRaisesRegex(PUB.Blocked, 'RETAIN_OUTSIDE_ASSETS'):
            PUB.retain_assets(new, {'index.html': b'old'})

    def test_asset_same_path_different_content_is_conflict(self):
        with self.assertRaisesRegex(PUB.Blocked, 'SAME_ASSET_PATH_DIFFERENT_CONTENT'):
            PUB.retain_assets({'assets/a.js': b'new'}, {'assets/a.js': b'old'})

    def test_exchange_uses_linux_atomic_flag(self):
        function = mock.Mock(return_value=0)
        with mock.patch.object(PUB.ctypes, 'CDLL', return_value=mock.Mock(renameat2=function)), \
                mock.patch.object(PUB, 'sync_dir'):
            PUB.exchange('/path/app', '/path/staged')
        function.assert_called_once_with(-100, b'/path/app', -100, b'/path/staged', 2)

    def test_real_atomic_exchange_and_return_in_isolated_fixture(self):
        with tempfile.TemporaryDirectory() as folder:
            first, second = Path(folder) / 'app', Path(folder) / 'staged'
            first.mkdir()
            second.mkdir()
            (first / 'index.html').write_text('old')
            (second / 'index.html').write_text('new')
            PUB.exchange(first, second)
            self.assertEqual((first / 'index.html').read_text(), 'new')
            self.assertEqual((second / 'index.html').read_text(), 'old')
            PUB.exchange(first, second)
            self.assertEqual((first / 'index.html').read_text(), 'old')

    def test_ledger_is_readonly_exact_checksums(self):
        pin = {'migrations': [{'name': name, 'sha256': 'a' * 64} for name in PUB.MIGRATIONS]}
        with mock.patch.object(PUB, 'command', return_value=b'3\n') as command:
            PUB.ledger(pin)
        query = command.call_args.args[1].decode()
        self.assertIn('BEGIN READ ONLY', query)
        self.assertIn("checksum='" + 'a' * 64 + "'", query)
        self.assertNotIn('INSERT', query)


if __name__ == '__main__':
    unittest.main()
