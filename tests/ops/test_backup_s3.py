"""S3 migration safety checks; no network or real credentials."""
import hashlib
import importlib.util
import io
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / 'deploy/timeweb/backup-s3.py'
SPEC = importlib.util.spec_from_file_location('backup_s3', SCRIPT)
s3 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(s3)


class ServiceError(Exception):
    def __init__(self, status, code='AccessDenied'):
        self.response = {'ResponseMetadata': {'HTTPStatusCode': status}, 'Error': {'Code': code}}


class S3SafetyTests(unittest.TestCase):
    def test_request_guard_never_deletes_backup_even_in_probe_mode(self):
        for key in ('migration/source-run/data.sql.zst.age', 'hourly/a', 'migration/probe-invalid/permission-probe.txt'):
            with self.subTest(key=key), self.assertRaises(s3.BackupError):
                s3.guard_request(SimpleNamespace(url=f'{s3.ENDPOINT}/{s3.BUCKET}/{key}', method='DELETE'), True)
        probe = 'migration/probe-20261112T180000Z-' + 'a'*32 + '/permission-probe.txt'
        request = SimpleNamespace(url=f'{s3.ENDPOINT}/{s3.BUCKET}/{probe}', method='DELETE')
        s3.guard_request(request, True)
        with self.assertRaises(s3.BackupError):
            s3.guard_request(request, False)

    def test_tls_endpoint_and_redirect_guards(self):
        for base in ('http://s3.twcstorage.ru', 'https://wrong.invalid', 'https://s3.twcstorage.ru:444'):
            with self.subTest(base=base), self.assertRaises(s3.BackupError):
                s3.guard_request(SimpleNamespace(url=f'{base}/{s3.BUCKET}/migration/a', method='PUT'))
        with self.assertRaises(s3.BackupError):
            s3.no_redirect((SimpleNamespace(status_code=307), {}))

    def test_hidden_hex_input_decodes_and_rejects_bad_encoding(self):
        with mock.patch.object(s3.getpass, 'getpass', return_value='6162632b2f3d'):
            self.assertEqual(s3.hidden_prompt('hidden', True), 'abc+/=')
        for value in ('', 'a', 'GG', 'ff', '6162\n63'):
            with self.subTest(value=value), mock.patch.object(s3.getpass, 'getpass', return_value=value), self.assertRaises(s3.BackupError):
                s3.hidden_prompt('hidden', True)

    def test_lost_put_response_is_not_retried(self):
        client = mock.Mock()
        client.put_object.side_effect = TimeoutError('synthetic network error')
        with mock.patch.object(s3, 'readback') as readback:
            s3.put_once(client, 'migration/a', io.BytesIO(b'a'), 1, 'hash')
        self.assertEqual(client.put_object.call_count, 1)
        readback.assert_called_once_with(client, 'migration/a', 1, 'hash')

    def test_conditional_put_collision_is_not_read_as_success(self):
        client = mock.Mock()
        client.put_object.side_effect = ServiceError(412)
        with mock.patch.object(s3, 'readback') as readback, self.assertRaisesRegex(s3.BackupError, 'ALREADY_EXISTS'):
            s3.put_once(client, 'migration/a', io.BytesIO(b'a'), 1, 'hash')
        readback.assert_not_called()

    def test_readback_checks_stream_size_and_sha_and_closes(self):
        data = b'encrypted fixture'
        for actual, length, digest, valid in ((data, len(data), hashlib.sha256(data).hexdigest(), True),
                (data, len(data), '0'*64, False), (data+b'x', len(data), hashlib.sha256(data).hexdigest(), False)):
            body = io.BytesIO(actual)
            client = mock.Mock()
            client.get_object.return_value = {'Body': body, 'ContentLength': length}
            if valid:
                s3.readback(client, 'migration/a', length, digest)
            else:
                with self.assertRaises(s3.BackupError):
                    s3.readback(client, 'migration/a', length, digest)
            self.assertTrue(body.closed)

    def test_bucket_usage_reads_all_pages_and_rejects_repeated_token(self):
        client = mock.Mock()
        client.list_objects_v2.side_effect = [
            {'Contents': [{'Size': 11}], 'IsTruncated': True, 'NextContinuationToken': 'next'},
            {'Contents': [{'Size': 22}], 'IsTruncated': False}]
        self.assertEqual(s3.bucket_usage(client), (33, 2))
        self.assertEqual(client.list_objects_v2.call_args.kwargs['ContinuationToken'], 'next')
        client.list_objects_v2.side_effect = [
            {'Contents': [], 'IsTruncated': True, 'NextContinuationToken': 'same'},
            {'Contents': [], 'IsTruncated': True, 'NextContinuationToken': 'same'}]
        with self.assertRaises(s3.BackupError): s3.bucket_usage(client)

    def test_probe_requires_actual_delete_denial_and_retains_marker(self):
        client = mock.Mock()
        client.delete_object.side_effect = ServiceError(403)
        with mock.patch.object(s3.os.path, 'lexists', return_value=False), \
                mock.patch.object(s3, 'bucket_usage', return_value=(0,0)), \
                mock.patch.object(s3, 'absent'), mock.patch.object(s3, 'put_once'), \
                mock.patch.object(s3, 'readback') as readback, mock.patch.object(s3, 'save_private_once') as save:
            result = s3.probe({'access_key_id':'synthetic', 'secret_access_key':'synthetic'}, client)
            self.assertEqual(result['status'], 'LIMITED_PUT_GET_VERIFIED_DELETE_DENIED')
            self.assertTrue(save.call_args.args[1]['delete_denied_403'])
            self.assertEqual(readback.call_count, 1)
            self.assertRegex(client.delete_object.call_args.kwargs['Key'], s3.PROBE_PATTERN)
        client.delete_object.side_effect = None
        with mock.patch.object(s3.os.path, 'lexists', return_value=False), \
                mock.patch.object(s3, 'bucket_usage', return_value=(0,0)), \
                mock.patch.object(s3, 'absent'), mock.patch.object(s3, 'put_once'), \
                mock.patch.object(s3, 'save_private_once') as save, self.assertRaisesRegex(s3.BackupError, 'CAN_DELETE'):
            s3.probe({'access_key_id':'synthetic', 'secret_access_key':'synthetic'}, client)
        save.assert_not_called()

    def test_upload_requires_matching_probe_before_artifact_or_network_access(self):
        client = mock.Mock()
        with mock.patch.object(s3, 'read_private_json', return_value={}), self.assertRaisesRegex(s3.BackupError, 'PROBE_REQUIRED'):
            s3.upload(Path('/var/backups/bron-franchise/source-20261112T161139Z-0f8917c7/manifest.json'), {}, client)
        client.put_object.assert_not_called()


if __name__ == '__main__':
    unittest.main()
