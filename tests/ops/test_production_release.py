import hashlib
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch


PATH = Path(__file__).resolve().parents[2] / 'scripts/production-release.py'
SPEC = importlib.util.spec_from_file_location('production_release', PATH)
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)

OLD, NEW = 'a' * 40, 'b' * 40
API = 'https://api.bronservis.ru'
BASE = '0013_order_link.sql'
NEXT = '20261119000004_released.sql'
OLD_ASSET = b'chunk for a previously opened tab'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(data):
    return json.dumps(data).encode()


def site(source):
    files = {'index.html': b'<html></html>', 'app-version.json': b'{}',
             'manifest.webmanifest': b'{"scope":"/","start_url":"/"}', 'sw.js': b'/* */',
             'assets/app-B8Kj1H7q.js': b'new chunk'}
    files['release-manifest.json'] = json_bytes({'format': 1, 'sourceCommit': source, 'base': '/', 'apiOrigin': API,
        'files': [{'file': name, 'bytes': len(value), 'sha256': sha(value)} for name, value in files.items()]})
    return files


def artifact(transform=None, tar_link=False):
    members = {f'site/{key}': value for key, value in site(NEW).items()}
    members[f'migrations/{BASE}'] = b'select 1;'
    members[f'migrations/{NEXT}'] = b'create table public.release_fixture(id int);'
    manifest = {'format_version': 1, 'source_sha': NEW, 'expected_live_source_sha': OLD,
                'files': {name: sha(value) for name, value in members.items()}}
    members['manifest.json'] = json_bytes(manifest)
    if transform:
        transform(members)
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode='w:gz') as archive:
        for key, data in members.items():
            entry = tarfile.TarInfo(key)
            entry.size = len(data)
            archive.addfile(entry, io.BytesIO(data))
        if tar_link:
            entry = tarfile.TarInfo('site/assets/link.js')
            entry.type = tarfile.SYMTYPE
            entry.linkname = '/not-a-release-file'
            archive.addfile(entry)
    return output.getvalue()


class ReleaseTests(unittest.TestCase):
    def test_accepts_exact_package_and_selects_only_unapplied_migration(self):
        package = release.read_package(artifact())
        self.assertEqual((package['expected'], package['source']), (OLD, NEW))
        self.assertEqual(set(release.plan_migrations(package['migrations'], {BASE: sha(b'select 1;')})), {NEXT})

    def test_rejects_escape_link_extra_and_changed_files(self):
        changes = [lambda contents: contents.update({'site/../escaped': b'bad'}),
                   lambda contents: contents.update({'site/not-declared': b'bad'}),
                   lambda contents: contents.update({'site/sw.js': b'tampered'})]
        for change in changes:
            with self.subTest(change=change), self.assertRaises(release.Blocked):
                release.read_package(artifact(change))
        with self.assertRaises(release.Blocked):
            release.read_package(artifact(tar_link=True))

    def test_blocks_ledger_conflicts_and_old_missing_migrations(self):
        migrations = release.read_package(artifact())['migrations']
        for ledger in ({BASE: sha(b'tampered')}, {NEXT: sha(migrations[NEXT])}):
            with self.subTest(ledger=ledger), self.assertRaises(release.Blocked):
                release.plan_migrations(migrations, ledger)

    def test_blocks_psql_and_transaction_boundaries_but_accepts_function_body(self):
        for script in ('select 1 \\gexec', '/* term */ commit;', 'start transaction;', 'prepare transaction \'name\';'):
            with self.subTest(script=script), self.assertRaises(release.Blocked):
                release.checked_sql(script.encode())
        script = b"create function x() returns void language plpgsql as $$ begin null; end $$;"
        self.assertEqual(release.checked_sql(script), script.decode())

    def test_atomic_swap_keeps_old_assets_and_health_failure_restores_prior_frontend(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            live = root / 'app'
            before = site(OLD)
            before['assets/app-OldChunk.js'] = OLD_ASSET
            release.stage(live, before)
            new = site(NEW)
            with patch.object(release, 'public_health', side_effect=[release.Blocked('UNHEALTHY'), None]):
                with self.assertRaisesRegex(release.Blocked, 'FRONTEND_ROLLED_BACK'):
                    release.publish_frontend(root, root, {'source': NEW, 'expected': OLD, 'site': new})
            self.assertEqual(json.loads((live / 'release-manifest.json').read_bytes())['sourceCommit'], OLD)
            self.assertEqual((live / 'assets/app-OldChunk.js').read_bytes(), OLD_ASSET)
            with patch.object(release, 'public_health'):
                release.publish_frontend(root, root, {'source': NEW, 'expected': OLD, 'site': new})
            self.assertEqual(json.loads((live / 'release-manifest.json').read_bytes())['sourceCommit'], NEW)
            self.assertEqual((live / 'assets/app-OldChunk.js').read_bytes(), OLD_ASSET)

    def test_stale_release_leaves_frontend_and_migration_callback_untouched(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            release.stage(root / 'app', site(OLD))
            pending = {'source': NEW, 'expected': 'c' * 40, 'site': site(NEW)}
            def unexpected_migrate():
                self.fail('Migration ran before the expected live source was checked')
            with self.assertRaisesRegex(release.Blocked, 'EXPECTED_LIVE_SOURCE_MISMATCH'):
                release.publish_frontend(root, root, pending, before_switch=unexpected_migrate)
            self.assertEqual({entry.name for entry in root.iterdir()}, {'app'})

    def test_forced_command_rejects_shell_and_arguments(self):
        wrapper = PATH.with_name('production-release-ssh.sh')
        for command, args in [('sh', []), ('bron-release-v1;sh', []), ('bron-release-v1', ['--check'])]:
            with self.subTest(command=command, args=args):
                result = subprocess.run(['/bin/sh', str(wrapper), *args], env={'SSH_ORIGINAL_COMMAND': command}, check=False)
                self.assertEqual(result.returncode, 64)
