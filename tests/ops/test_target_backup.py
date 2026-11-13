"""Target backup safety/failure checks; no real container, secrets or network."""
import datetime
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / 'deploy/timeweb/target-backup.py'
SPEC = importlib.util.spec_from_file_location('target_backup', SCRIPT)
backup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(backup)


class TargetBackupSafetyTests(unittest.TestCase):
    def test_dump_commands_use_container_and_never_host_secrets_or_mac_tunnel(self):
        record = {'Id': 'a' * 64, 'Config': {'Env': ['PGPASSWORD=do-not-expose']}}
        with mock.patch.dict(os.environ, {'PGPASSWORD': 'also-secret', 'PGHOST': 'hostile.invalid'}):
            command = backup.db_command(record, 'pg_dump', '--format=custom', '--dbname=postgres')
        joined = ' '.join(command)
        for forbidden in ('do-not-expose', 'also-secret', 'hostile.invalid', '15433', '15432'):
            self.assertNotIn(forbidden, joined)
        self.assertIn(record['Id'], command)
        self.assertIn('--host=127.0.0.1', command)
        self.assertIn('default_transaction_read_only=on', joined)
        self.assertNotIn('PGPASSWORD', backup.ENV)

    def test_file_content_change_is_detected_even_when_mtime_and_size_match(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / 'document'
            path.write_bytes(b'first')
            info = path.stat()
            before = backup.tree_signature([Path(temporary)])
            path.write_bytes(b'other')
            os.utime(path, ns=(info.st_atime_ns, info.st_mtime_ns))
            self.assertNotEqual(before, backup.tree_signature([Path(temporary)]))

    def test_symlinks_and_hardlinks_are_not_followed_into_archives(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            real = directory / 'real'
            real.write_bytes(b'private fixture')
            link = directory / 'link'
            link.symlink_to(real)
            with self.assertRaisesRegex(backup.BackupError, 'UNSAFE_FILE_TYPE'):
                backup.tree_signature([link])
            link.unlink()
            os.link(real, link)
            with self.assertRaisesRegex(backup.BackupError, 'UNSAFE_FILE_TYPE'):
                backup.tree_signature([real])

    def test_unexpected_storage_mount_and_db_key_directory_are_rejected(self):
        for mount in ({'Type': 'bind', 'Destination': '/etc/postgresql-custom', 'Source': '/tmp/unsafe'},
                      {'Type': 'volume', 'Destination': '/etc/postgresql-custom', 'Source': '/var/lib/postgresql/data'}):
            with self.subTest(mount=mount), self.assertRaisesRegex(backup.BackupError, 'CONFIG_MOUNT_MISMATCH'):
                backup.config_paths({'Mounts': [mount], 'Config': {'Labels': {
                    'com.docker.compose.project.config_files': '/opt/bron/supabase/docker/docker-compose.yml'}}})

    def test_failed_hourly_upload_never_advances_last_success_or_promotions(self):
        with mock.patch.object(backup.os.path, 'lexists', return_value=False), \
             mock.patch.object(backup.s3, 'operation_lock'), \
             mock.patch.object(backup.s3, 'credentials', return_value={}), \
             mock.patch.object(backup.s3, 's3_client'), \
             mock.patch.object(backup.s3, 'upload_target', side_effect=backup.BackupError('SYNTHETIC_UPLOAD_FAILURE')) as upload, \
             mock.patch.object(backup, 'save_state') as save:
            with self.assertRaises(backup.BackupError):
                backup.upload(Path('/private/manifest.json'), datetime.datetime.now(datetime.timezone.utc))
        self.assertEqual(upload.call_count, 1)
        save.assert_not_called()

    def test_promotions_only_once_per_utc_day_and_month_and_after_readback(self):
        now = datetime.datetime(2026, 11, 13, 12, 0, tzinfo=datetime.timezone.utc)
        state = {}
        saved = []
        def save(value):
            state.clear()
            state.update(json.loads(json.dumps(value)))
            saved.append(dict(value))
        with mock.patch.object(backup.os.path, 'lexists', return_value=True), \
             mock.patch.object(backup.s3, 'read_private_json', side_effect=lambda _: dict(state)), \
             mock.patch.object(backup.s3, 'operation_lock'), \
             mock.patch.object(backup.s3, 'credentials', return_value={}), \
             mock.patch.object(backup.s3, 's3_client'), \
             mock.patch.object(backup.s3, 'upload_target') as upload, \
             mock.patch.object(backup, 'save_state', side_effect=save):
            backup.upload(Path('/private/manifest.json'), now)
            self.assertEqual([call.args[3] for call in upload.call_args_list], ['hourly', 'daily', 'monthly'])
            self.assertNotIn('daily', saved[0])
            self.assertNotIn('monthly', saved[1])
            upload.reset_mock()
            backup.upload(Path('/private/new-manifest.json'), now + datetime.timedelta(hours=1))
            self.assertEqual([call.args[3] for call in upload.call_args_list], ['hourly'])

    def test_changed_files_prevent_manifest_and_s3_publication(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            keeper = mock.Mock()
            keeper.start.return_value = {'snapshot': '00000004-00000048-1', 'objects': 0,
                                        'server_version_num': 170011}
            with mock.patch.object(backup.s3, 'BACKUP_ROOT', directory), \
                 mock.patch.object(backup.source, 'secure_path'), \
                 mock.patch.object(backup, 'existing_recipient', return_value='age1' + 'a' * 58), \
                 mock.patch.object(backup, 'TargetSnapshot', return_value=keeper), \
                 mock.patch.object(backup, 'storage_signature', return_value='same'), \
                 mock.patch.object(backup, 'tree_signature', side_effect=[b'before', b'changed']), \
                 mock.patch.object(backup.source, 'encrypted_artifact', return_value={}) as encrypt, \
                 mock.patch.object(backup, 'upload') as upload:
                with self.assertRaisesRegex(backup.BackupError, 'FILES_CHANGED'):
                    backup.backup({'Id': 'a' * 64}, [Path('/safe/config')])
            self.assertEqual(encrypt.call_count, 5)
            self.assertFalse(list(directory.glob('target-*/manifest.json')))
            upload.assert_not_called()
            keeper.stop.assert_called_once()

    def test_missing_recovery_key_is_never_automatically_replaced(self):
        with mock.patch.object(backup.source, 'secure_path', side_effect=FileNotFoundError), \
             mock.patch.object(backup, 'capture') as capture:
            with self.assertRaises(FileNotFoundError):
                backup.existing_recipient()
        capture.assert_not_called()

    def test_missing_or_stale_marker_is_not_a_fresh_backup(self):
        stale = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=2)).isoformat()
        with mock.patch.object(backup.s3, 'read_private_json', return_value={'last_success_utc': stale}):
            with self.assertRaisesRegex(backup.BackupError, 'STALE'):
                backup.check_age()

    def test_successful_service_does_not_send_a_failure_alert(self):
        with mock.patch.object(backup.sys, 'argv', ['target-backup.py', '--alert-on-failure']), \
             mock.patch.dict(backup.os.environ, {'SERVICE_RESULT': 'success'}), \
             mock.patch.object(backup.s3, 'runtime_guard'), mock.patch.object(backup, 'alert') as alert:
            backup.main()
        alert.assert_not_called()

    def test_independent_health_check_reports_stale_backup_without_running_backup(self):
        with mock.patch.object(backup.sys, 'argv', ['target-backup.py', '--check-health']), \
             mock.patch.object(backup.s3, 'runtime_guard'), \
             mock.patch.object(backup, 'check_age', side_effect=backup.BackupError('TARGET_BACKUP_STALE')), \
             mock.patch.object(backup, 'backup') as run:
            with self.assertRaisesRegex(backup.BackupError, 'STALE'):
                backup.main()
        run.assert_not_called()

    def test_watchdog_detects_low_memory_before_container_queries(self):
        with mock.patch.object(backup, 'check_age'), \
             mock.patch.object(backup.shutil, 'disk_usage', return_value=mock.Mock(free=3 * 1024 ** 3)), \
             mock.patch.object(backup.Path, 'read_text', return_value='MemAvailable: 1000 kB\n'), \
             mock.patch.object(backup, 'inspect') as inspect:
            with self.assertRaisesRegex(backup.BackupError, 'MEMORY_HEADROOM'):
                backup.check_health()
        inspect.assert_not_called()

    def test_watchdog_detects_unhealthy_service(self):
        with mock.patch.object(backup, 'check_age'), \
             mock.patch.object(backup.shutil, 'disk_usage', return_value=mock.Mock(free=3 * 1024 ** 3)), \
             mock.patch.object(backup.Path, 'read_text', return_value='MemAvailable: 1000000 kB\n'), \
             mock.patch.object(backup, 'inspect', return_value={'State': {'Health': {'Status': 'unhealthy'}}}):
            with self.assertRaisesRegex(backup.BackupError, 'SERVICE_UNHEALTHY'):
                backup.check_health()


if __name__ == '__main__':
    unittest.main()
