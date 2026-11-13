"""Target backup uploads: real private files, synthetic ciphertext, no network."""
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / 'deploy/timeweb/backup-s3.py'
SPEC = importlib.util.spec_from_file_location('target_backup_s3', SCRIPT)
s3 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(s3)


class MissingObject(Exception):
    response = {'ResponseMetadata': {'HTTPStatusCode': 404}}


class FakeS3:
    def __init__(self):
        self.objects = {}
        self.calls = []
        self.versioning = {}
        self.used = 0
        self.corrupt = False

    def get_bucket_versioning(self, **_args):
        self.calls.append(('versioning', ''))
        return self.versioning

    def list_objects_v2(self, **_args):
        self.calls.append(('list', ''))
        return {'Contents': [{'Size': self.used}], 'IsTruncated': False}

    def head_object(self, Key, **_args):
        self.calls.append(('head', Key))
        if Key not in self.objects:
            raise MissingObject()
        return {}

    def put_object(self, Key, Body, ContentLength, **_args):
        self.calls.append(('put', Key))
        data = Body.read()
        if len(data) != ContentLength:
            raise AssertionError('incorrect test stream length')
        self.objects[Key] = data

    def get_object(self, Key, **_args):
        self.calls.append(('get', Key))
        value = self.objects[Key]
        if self.corrupt:
            value = b'x' + value[1:]
        return {'Body': io.BytesIO(value), 'ContentLength': len(value)}


class TargetUploadTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.directory = self.root/'target-20261113T120000Z-a1b2c3d4'
        self.directory.mkdir(mode=0o700)
        self.manifest = {'format': 1, 'status': 'target_backup_saved_restore_unverified',
            'complete': False, 'target': 'bron-franchise-russia',
            'created_utc': '20261113T120000Z', 'storage_objects': 0, 'artifacts': []}
        for name in sorted(s3.TARGET_FILES):
            data = s3.AGE_HEADER + b'synthetic-ciphertext-only-'*6
            path = self.directory/name
            path.write_bytes(data)
            path.chmod(0o600)
            self.manifest['artifacts'].append({'file': name, 'bytes': len(data),
                'sha256': hashlib.sha256(data).hexdigest()})
        self.path = self.directory/'manifest.json'
        self.save_manifest()
        self.client = FakeS3()
        self.guard = mock.patch.object(s3, 'BACKUP_ROOT', self.root)
        self.guard.start()
        self.addCleanup(self.guard.stop)
        self.owner = mock.patch.object(s3, 'OWNER_UID', os.getuid())
        self.owner.start()
        self.addCleanup(self.owner.stop)
        self.probe = mock.patch.object(s3, 'require_probe')
        self.probe.start()
        self.addCleanup(self.probe.stop)

    def save_manifest(self):
        self.path.write_text(json.dumps(self.manifest))
        self.path.chmod(0o600)

    def test_uploads_exact_ciphertext_with_readback_and_manifest_last(self):
        for period in ('hourly', 'daily', 'monthly'):
            with self.subTest(period=period):
                self.client = FakeS3()
                result = s3.upload_target(self.path, {}, self.client, period)
                self.assertEqual(result['status'], 'TARGET_UPLOAD_READBACK_VERIFIED')
                self.assertFalse(result['complete'])
                self.assertRegex(result['prefix'], rf'^{period}/target-20261113T120000Z-[0-9a-f]{{32}}/$')
                puts = [key for op,key in self.client.calls if op == 'put']
                gets = [key for op,key in self.client.calls if op == 'get']
                self.assertEqual(len(puts), 6)
                self.assertEqual(puts, gets)
                self.assertTrue(puts[-1].endswith('/manifest.json'))
                self.assertEqual({key.rsplit('/',1)[1] for key in puts}, s3.TARGET_FILES|{'manifest.json'})

    def test_wrong_target_or_unexpected_manifest_data_never_access_network(self):
        for change in ({'target': 'source'}, {'created_utc': '20261114T120000Z'},
                {'storage_objects': True}, {'private_data': 'synthetic'}):
            with self.subTest(change=change):
                original = self.manifest.copy()
                self.manifest.update(change)
                self.save_manifest()
                with self.assertRaises(s3.BackupError):
                    s3.upload_target(self.path, {}, self.client)
                self.assertEqual(self.client.calls, [])
                self.manifest = original

    def test_only_allowlisted_public_metadata_can_be_uploaded(self):
        self.manifest.update(metadata={'postgres_version_num':170011,
            'database_image':'sha256:'+'a'*64, 'snapshot':'00000003-0000001A-1',
            'encryption_recipient':'age1'+'a'*58, 'db_config_included':True,
            'storage_consistency':'stable_before_after'}, missing=sorted(s3.TARGET_MISSING))
        self.save_manifest()
        result = s3.upload_target(self.path, {}, self.client)
        self.assertEqual(result['status'], 'TARGET_UPLOAD_READBACK_VERIFIED')
        self.client = FakeS3()
        self.manifest['metadata']['unreviewed_config'] = 'synthetic-secret-placeholder'
        self.save_manifest()
        with self.assertRaisesRegex(s3.BackupError, 'METADATA_WHITELIST'):
            s3.upload_target(self.path, {}, self.client)
        self.assertEqual(self.client.calls, [])
        del self.manifest['metadata']['unreviewed_config']
        self.manifest['missing'] = ['unexpected free text']
        self.save_manifest()
        with self.assertRaisesRegex(s3.BackupError, 'METADATA_WHITELIST'):
            s3.upload_target(self.path, {}, self.client)
        self.assertEqual(self.client.calls, [])

    def test_plaintext_tamper_and_extra_files_are_rejected_before_network(self):
        target = self.directory/'roles.sql.zst.age'
        original = target.read_bytes()
        for data in (b'plaintext-secret-placeholder'*8, b'x'+original[1:]):
            target.write_bytes(data)
            with self.assertRaises(s3.BackupError):
                s3.upload_target(self.path, {}, self.client)
            self.assertEqual(self.client.calls, [])
        target.write_bytes(original)
        (self.directory/'unrelated.txt').write_text('synthetic')
        with self.assertRaises(s3.BackupError):
            s3.upload_target(self.path, {}, self.client)
        self.assertEqual(self.client.calls, [])

    def test_rejects_unsafe_permissions_and_symlinks(self):
        path = self.directory/'roles.sql.zst.age'
        path.chmod(0o644)
        with self.assertRaises(s3.BackupError):
            s3.upload_target(self.path, {}, self.client)
        path.chmod(0o600)
        moved = self.root/'outside.age'
        path.rename(moved)
        path.symlink_to(moved)
        with self.assertRaises(OSError):
            s3.upload_target(self.path, {}, self.client)
        self.assertEqual(self.client.calls, [])

    def test_versioning_or_bucket_capacity_prevents_any_put(self):
        for status in ('Enabled', 'Suspended', 'unexpected'):
            with self.subTest(status=status):
                self.client.versioning = {'Status': status}
                with self.assertRaisesRegex(s3.BackupError, 'UNVERSIONED'):
                    s3.upload_target(self.path, {}, self.client)
        self.client.versioning = {}
        self.client.used = s3.BUCKET_BUDGET
        with self.assertRaisesRegex(s3.BackupError, 'BUDGET_EXCEEDED'):
            s3.upload_target(self.path, {}, self.client)
        self.assertFalse(any(op == 'put' for op,_ in self.client.calls))

    def test_bad_readback_does_not_publish_remote_manifest(self):
        self.client.corrupt = True
        with self.assertRaisesRegex(s3.BackupError, 'SHA256_MISMATCH'):
            s3.upload_target(self.path, {}, self.client)
        self.assertFalse(any(key.endswith('/manifest.json') for key in self.client.objects))

    def test_source_mode_guard_is_not_broadened_and_target_never_deletes(self):
        key = 'hourly/target-20261113T120000Z-'+'a'*32+'/database.dump.zst.age'
        request = SimpleNamespace(url=f'{s3.ENDPOINT}/{s3.BUCKET}/{key}', method='PUT')
        with self.assertRaises(s3.BackupError):
            s3.guard_request(request)
        s3.guard_request(request, allow_target=True)
        for key in ('hourly/arbitrary', 'hourly/target-20261113T120000Z-'+'a'*32+'/unknown.age',
                'hourly/target-20261113T120000Z-'+'a'*32+'/../secret'):
            request.url = f'{s3.ENDPOINT}/{s3.BUCKET}/{key}'
            with self.subTest(key=key), self.assertRaises(s3.BackupError):
                s3.guard_request(request, allow_target=True)
        request.url = f'{s3.ENDPOINT}/{s3.BUCKET}/hourly/target-20261113T120000Z-'+'a'*32+'/manifest.json'
        request.method = 'DELETE'
        with self.assertRaises(s3.BackupError):
            s3.guard_request(request, allow_probe_delete=True, allow_target=True)

    def test_target_period_flag_is_rejected_for_source_and_probe_modes(self):
        for args in (['--probe'], ['--upload','--manifest',str(self.path)]):
            with self.subTest(args=args), mock.patch.object(s3.sys, 'argv',
                    ['backup-s3.py',*args,'--period','daily']), mock.patch.object(s3, 'runtime_guard') as guard:
                with self.assertRaisesRegex(s3.BackupError, 'INVALID_MODE_ARGUMENTS'):
                    s3.main()
                guard.assert_not_called()


if __name__ == '__main__':
    unittest.main()
