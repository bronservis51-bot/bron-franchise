import base64
import datetime as dt
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
PROBE_KEY = 'sb_publishable_testing_only'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def json_bytes(data):
    return json.dumps(data).encode()


def site(source):
    files = {'index.html': b'<html></html>', 'app-version.json': b'{}',
             'manifest.webmanifest': b'{"scope":"/","start_url":"/"}', 'sw.js': b'/* */',
             f'workbox-{source[:8]}.js': b'worker import',
             f'assets/app-{source[:8]}.js': b'app chunk'}
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
            def verify_prepared():
                self.assertEqual(release.live_core(root)['release-manifest.json'], before['release-manifest.json'])
                self.assertEqual((live / 'assets/app-bbbbbbbb.js').read_bytes(), new['assets/app-bbbbbbbb.js'])
                self.assertEqual((live / 'workbox-bbbbbbbb.js').read_bytes(), new['workbox-bbbbbbbb.js'])
            with patch.object(release, 'public_health', side_effect=[release.Blocked('UNHEALTHY'), None]) as probe:
                with self.assertRaisesRegex(release.Blocked, 'FRONTEND_ROLLED_BACK'):
                    release.publish_frontend(root, root, {'source': NEW, 'expected': OLD, 'site': new},
                                             probe_key=PROBE_KEY, before_switch=verify_prepared)
            for check in probe.call_args_list:
                self.assertEqual(check.args[0]['assets/app-bbbbbbbb.js'], new['assets/app-bbbbbbbb.js'])
            self.assertEqual(json.loads((live / 'release-manifest.json').read_bytes())['sourceCommit'], OLD)
            self.assertEqual((live / 'assets/app-OldChunk.js').read_bytes(), OLD_ASSET)
            self.assertEqual((live / 'assets/app-bbbbbbbb.js').read_bytes(), new['assets/app-bbbbbbbb.js'])
            self.assertTrue((live / 'workbox-aaaaaaaa.js').is_file())
            self.assertTrue((live / 'workbox-bbbbbbbb.js').is_file())
            with patch.object(release, 'public_health'):
                release.publish_frontend(root, root, {'source': NEW, 'expected': OLD, 'site': new}, probe_key=PROBE_KEY)
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
                release.publish_frontend(root, root, pending, probe_key=PROBE_KEY, before_switch=unexpected_migrate)
            self.assertEqual({entry.name for entry in root.iterdir()}, {'app'})

    def test_failed_rollback_asset_preparation_blocks_sql_and_keeps_live_core(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            previous = site(OLD)
            release.stage(root / 'app', previous)
            package = {'source': NEW, 'expected': OLD, 'site': site(NEW)}
            def unexpected_migrate():
                self.fail('Migration ran with incomplete rollback assets')
            with patch.object(release, 'prepare_rollback_assets', side_effect=release.Blocked('ASSET_SETUP_FAILED')):
                with self.assertRaisesRegex(release.Blocked, 'ASSET_SETUP_FAILED'):
                    release.publish_frontend(root, root, package, probe_key=PROBE_KEY, before_switch=unexpected_migrate)
            self.assertEqual(release.live_core(root)['release-manifest.json'], previous['release-manifest.json'])
            self.assertEqual((root / 'app/workbox-aaaaaaaa.js').read_bytes(), previous['workbox-aaaaaaaa.js'])

    def test_existing_immutable_asset_collision_blocks_before_sql(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            previous = site(OLD)
            release.stage(root / 'app', previous)
            candidate = {**site(NEW), 'assets/app-aaaaaaaa.js': b'changed existing hash'}
            def unexpected_migrate():
                self.fail('Migration ran despite an immutable asset collision')
            with self.assertRaisesRegex(release.Blocked, 'SAME_ASSET_PATH_DIFFERENT_CONTENT'):
                release.publish_frontend(root, root, {'source': NEW, 'expected': OLD, 'site': candidate},
                                         probe_key=PROBE_KEY, before_switch=unexpected_migrate)
            self.assertEqual(release.live_core(root)['release-manifest.json'], previous['release-manifest.json'])

    def test_canonical_service_probes_and_noninserting_honeypot(self):
        cases = {'/auth/v1/health': {'name': 'GoTrue'}, '/rest/v1/rpc/ping': 'ok',
                 '/rest/v1/rpc/lead_submit': {'ok': True}}
        with patch.object(release, 'download', side_effect=[json_bytes(response) for response in cases.values()]) as download:
            release.probe_services(PROBE_KEY)
        self.assertEqual([call.args[0] for call in download.call_args_list], [API + path for path in cases])
        self.assertEqual([call.kwargs['key'] for call in download.call_args_list], [PROBE_KEY] * 3)
        self.assertEqual([call.kwargs.get('body') for call in download.call_args_list],
                         [None, b'{}', b'{"p_lead":{"website":"availability-check"}}'])
        with patch.object(release, 'download', side_effect=[json_bytes(cases['/auth/v1/health']), b'"not-ok"']):
            with self.assertRaisesRegex(release.Blocked, 'PUBLIC_DATA_PROBE'):
                release.probe_services(PROBE_KEY)
        with patch.object(release, 'build_opener') as open_connection:
            with self.assertRaisesRegex(release.Blocked, 'PUBLIC_PROBE_ORIGIN'):
                release.download('https://wrong.example.test/auth/v1/health', 1024, key=PROBE_KEY)
            open_connection.assert_not_called()

    def test_accepts_only_public_key_shapes(self):
        def jwt(alg, role):
            tokens = [json_bytes({'alg': alg}), json_bytes({'role': role}), b'synthetic']
            return '.'.join(base64.urlsafe_b64encode(token).decode().rstrip('=') for token in tokens)
        self.assertTrue(release.public_key(PROBE_KEY))
        self.assertTrue(release.public_key(jwt('HS256', 'anon')))
        for key in ('sb_secret_testing_only', jwt('HS256', 'service_role'), jwt('none', 'anon'), 'bad.jwt.data'):
            with self.subTest(key=key):
                self.assertFalse(release.public_key(key))

    def test_persistent_api_failure_rolls_back_on_disk_and_records_public_verification_split(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            live = root / 'app'
            release.stage(live, site(OLD))
            package = {'source': NEW, 'expected': OLD, 'site': site(NEW)}
            now = dt.datetime.now(dt.timezone.utc).isoformat()
            def failed_auth(url, _limit, **options):
                if url.startswith(release.APP + '/'):
                    path = url.removeprefix(release.APP + '/') or 'index.html'
                    return (live / path).read_bytes()
                if url == API + '/.well-known/bron-health.json':
                    return json_bytes({'checked_at': now, 'last_backup_utc': now, 'healthy': True})
                if url == release.AUTH and options.get('key') == PROBE_KEY:
                    return b'{"name":"Unhealthy"}'
                self.fail('Unexpected endpoint in failed Auth release probe')
            with patch.object(release, 'download', side_effect=failed_auth) as download:
                with self.assertRaisesRegex(release.Blocked, 'FRONTEND_ROLLED_BACK_PUBLIC_UNVERIFIED'):
                    release.publish_frontend(root, root, package, probe_key=PROBE_KEY)
            self.assertEqual([call.args[0] for call in download.call_args_list].count(release.AUTH), 2)
            self.assertEqual(release.live_core(root)['release-manifest.json'], site(OLD)['release-manifest.json'])
            self.assertTrue((live / 'assets/app-aaaaaaaa.js').is_file())
            self.assertTrue((live / 'assets/app-bbbbbbbb.js').is_file())
            self.assertEqual(json.loads((root / 'latest.json').read_bytes())['status'], 'FRONTEND_ROLLED_BACK_PUBLIC_UNVERIFIED')

    def test_forced_command_rejects_shell_and_arguments(self):
        wrapper = PATH.with_name('production-release-ssh.sh')
        for command, args in [('sh', []), ('bron-release-v1;sh', []), ('bron-release-v1', ['--check'])]:
            with self.subTest(command=command, args=args):
                result = subprocess.run(['/bin/sh', str(wrapper), *args], env={'SSH_ORIGINAL_COMMAND': command}, check=False)
                self.assertEqual(result.returncode, 64)
