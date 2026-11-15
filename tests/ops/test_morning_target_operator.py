import importlib.util
import datetime as dt
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('morning_target_operator', ROOT / 'docs/runbooks/payloads/morning-target-operator.py')
OP = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OP)


class MorningTargetOperatorTests(unittest.TestCase):
    def test_inventory_only_application_metadata(self):
        lower = OP.INVENTORY_SQL.lower()
        for forbidden in ('auth.users', 'auth.identities', 'encrypted_password', 'auth.sessions'):
            self.assertNotIn(forbidden, lower)
        self.assertIn('repeatable read read only', lower)
        self.assertTrue(lower.rstrip().endswith('rollback;'))

    def test_public_login_transformation(self):
        self.assertEqual(OP.login_for({'email': 'user@access.bron.local'}), 'user')
        self.assertEqual(OP.login_for({'email': '79000000000@staff.bron.local'}), '79000000000')
        self.assertEqual(OP.login_for({'email': 'owner@example.test'}), 'owner@example.test')

    def test_private_write_preserves_no_overwrite_and_mode(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'out.txt'
            with mock.patch.object(OP, 'checked_file', side_effect=lambda value: Path(value).read_bytes()):
                OP.private_write(path, b'private')
                self.assertEqual(path.stat().st_mode & 0o777, 0o600)
                with self.assertRaises(FileExistsError):
                    OP.private_write(path, b'overwrite')
                self.assertEqual(path.read_bytes(), b'private')

    def test_inventory_matches_in_memory_and_never_outputs_names(self):
        snapshot = {'users': [{'id': 'u', 'full_name': 'Private Person', 'email': 'person@access.bron.local',
                              'status': 'active', 'roles': [{'role': 'franchisee', 'partner_id': 'p'}], 'staff': None}],
                    'partners': [{'id': 'p', 'name': 'P', 'contact_name': 'Private Person'}],
                    'locations': [{'id': 'l', 'partner_id': 'p'}]}
        with mock.patch.object(OP, 'sql', return_value=json.dumps(snapshot).encode()) as sql, \
                mock.patch.object(OP, 'private_write') as write:
            result = OP.inventory(Path('/root/private'), {'subjects': [{'key': 'owner', 'name': 'Private Person'}]})
        self.assertEqual(sql.call_count, 1)
        self.assertEqual(result['subjectCounts']['owner'], {'users': 1, 'locations': 1, 'uniqueLocation': True})
        self.assertNotIn('Private Person', json.dumps(result))
        self.assertEqual(write.call_count, 2)

    def test_migration_allowlist_rejects_extra_or_reordered(self):
        with mock.patch.object(OP, 'checked_file', return_value=json.dumps({
                'task': 'T63', 'format': 1, 'migrations': [{'name': 'seed.sql', 'sha256': 'a' * 64}]}).encode()):
            with self.assertRaisesRegex(OP.Blocked, 'MIGRATION_ALLOWLIST'):
                OP.migration_bundle('/root/private/manifest.json')

    def test_migration_checksum_guards_and_atomicity(self):
        script = OP.migration_sql([({'name': OP.MIGRATIONS[0], 'sha256': 'a' * 64}, 'SELECT 1;')])
        self.assertTrue(script.startswith('BEGIN;'))
        self.assertIn('pg_advisory_xact_lock', script)
        self.assertIn('MIGRATION_CHECKSUM_CONFLICT', script)
        self.assertIn('\\if :apply_0', script)
        self.assertLess(script.index('SELECT 1;'), script.index('COMMIT;'))
        self.assertTrue(script.endswith("SELECT 'T63_MIGRATIONS_COMMITTED';\n"))

    def test_existing_backup_age_threshold_is_enforced_without_running_backup(self):
        now = dt.datetime(2026, 11, 16, 1, 0, tzinfo=dt.timezone.utc)
        def state(age):
            stamp = (now - dt.timedelta(seconds=age)).isoformat()
            return {OP.BACKUP_STATE: json.dumps({'last_success_utc': stamp}).encode(),
                    OP.HEALTH: json.dumps({'healthy': True, 'last_backup_utc': stamp,
                                          'checked_at': now.isoformat()}).encode()}
        valid = state(4200)
        with mock.patch.object(OP, 'checked_file', side_effect=lambda path, **kw: valid[path]):
            self.assertEqual(OP.freshness(now)['backupAgeSeconds'], 4200)
        stale = state(4201)
        with mock.patch.object(OP, 'checked_file', side_effect=lambda path, **kw: stale[path]):
            with self.assertRaisesRegex(OP.Blocked, 'BACKUP_OR_HEALTH_STALE'):
                OP.freshness(now)

    def test_manifest_wrong_bytes_never_reach_sql(self):
        manifest = {'format': 1, 'task': 'T63', 'migrations': [
            {'name': name, 'sha256': 'a' * 64} for name in OP.MIGRATIONS]}
        def content(path, **unused):
            return json.dumps(manifest).encode() if str(path).endswith('manifest.json') else b'SELECT 1;'
        with mock.patch.object(OP, 'checked_file', side_effect=content), mock.patch.object(OP, 'sql') as sql:
            with self.assertRaisesRegex(OP.Blocked, 'MIGRATION_SHA'):
                OP.migration_bundle('/root/private/manifest.json')
            sql.assert_not_called()


if __name__ == '__main__':
    unittest.main()
