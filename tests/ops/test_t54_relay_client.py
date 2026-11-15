import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('relay_client', ROOT / 'docs/runbooks/payloads/t54-relay-client.py')
m = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(m)
START = 1794716000000
SSH = ['ssh', '-o', 'StrictHostKeyChecking=yes', m.HOST]
REQUEST = {'format': 1, 'task': 'T54', 'actionId': 'T54.mcp_readiness',
           'sourceProject': 'vkkqffvmztpzgygzfxhq',
           'verifyFencedSqlSha256': 'fe7da8192bc58f7a95ca40851e4af15d1a7023d8b405bea08ca1da279c6e6782',
           'sourceBarrierReceiptSha256': '0231b2ad09cb0a4fb11ff285c41b66a1274a3666ffe2889e37a49cd8ec41a1a6',
           'nonceSha256': 'a' * 64, 'createdEpochMs': START, 'expiresEpochMs': START + 60000}
REQUEST_RAW = m.encode(REQUEST)
RESPONSE = {**{k: REQUEST[k] for k in ['format', 'task', 'actionId', 'sourceProject',
             'verifyFencedSqlSha256', 'sourceBarrierReceiptSha256', 'nonceSha256']},
            'requestSha256': m.sha(REQUEST_RAW), 'status': 'SOURCE_FENCE_VERIFIED',
            'sourceCheckedMicros': str((START + 1000) * 1000),
            'workerId': m.RELAY['workerId'], 'observedUtc': '2026-11-15T03:33:21.000Z'}
RESPONSE_RAW = m.encode(RESPONSE)


def completed(args, raw, code=0, stderr=b''):
    return subprocess.CompletedProcess(args, code, raw, stderr)


class ClientTests(unittest.TestCase):
    def helper(self):
        def request(raw):
            self.assertEqual(raw, REQUEST_RAW)
            return dict(REQUEST)
        def response(raw, request_raw, now):
            self.assertEqual(request_raw, REQUEST_RAW)
            value = m.parse(raw)
            m.need(value == RESPONSE and now == START + 2000, 'T54_FIXTURE_RESPONSE_BINDING')
            return REQUEST, value
        return types.SimpleNamespace(validate_request=request, validate_response=response)

    def outcome(self, code='PASS'):
        return {'task': 'T54', 'status': code, 'code': m.PASS_CODE if code == 'PASS' else 'T54_CLOCK_FAILED',
                'sourceVerifyPassed': code == 'PASS', 'roundTripMs': 2000,
                'monotonicRoundTripMs': 2000, 'snapshotAttemptsUsed': 0, 'targetWrites': 0,
                'macDataTransit': False, 'requestSha256': m.sha(REQUEST_RAW),
                'responseSha256': m.sha(RESPONSE_RAW), 'nonceSha256': REQUEST['nonceSha256']}

    def test_ssh_preserves_strict_baseline_and_rejects_weakening_or_new_master(self):
        self.assertEqual(m.ssh_argv(m.encode({'argv': SSH})), SSH)
        for args in [SSH[:-1] + ['root@other'], ['ssh', m.HOST],
                     ['ssh', '-o', 'StrictHostKeyChecking=no', m.HOST],
                     SSH[:-1] + ['-M', m.HOST], SSH[:-1] + ['-n', m.HOST],
                     SSH[:-1] + ['-o', 'ControlPersist=180', m.HOST]]:
            with self.subTest(args=args), self.assertRaises(m.ClientError):
                m.ssh_argv(m.encode({'argv': args}))
        mac_args = SSH[:-1] + ['-m', 'hmac-sha2-256', m.HOST]
        self.assertEqual(m.ssh_argv(m.encode({'argv': mac_args})), mac_args)

    def test_github_request_create_never_supplies_overwrite_sha_or_credentials(self):
        body = m.encode({'technical': True})
        with mock.patch.object(m, 'process', return_value=completed([], b'{}')) as run:
            m.gh_publish_request(body)
        args, posted = run.call_args.args
        self.assertEqual(args[-2:], ['--input', '-'])
        value = m.parse(posted)
        self.assertEqual(set(value), {'message', 'branch', 'content'})
        self.assertEqual(value['branch'], m.RELAY['branch'])
        self.assertEqual(base64.b64decode(value['content']), body)
        self.assertNotIn('token', json.dumps(value))

    def test_github_content_requires_exact_path_type_and_bounded_base64(self):
        item = {'type': 'file', 'path': m.RELAY['responsePath'], 'encoding': 'base64',
                'content': base64.b64encode(RESPONSE_RAW).decode()}
        with mock.patch.object(m, 'process', return_value=completed([], m.encode(item))):
            self.assertEqual(m.gh_read(m.RELAY['responsePath']), RESPONSE_RAW)
        with mock.patch.object(m, 'process', return_value=completed([], b'{}', 1, b'gh: Not Found (HTTP 404)')):
            self.assertIsNone(m.gh_read(m.RELAY['responsePath']))
        for change in [{'path': 'other'}, {'content': '!!'}, {'type': 'dir'}]:
            with self.subTest(change=change), mock.patch.object(m, 'process',
                    return_value=completed([], m.encode({**item, **change}))), self.assertRaises(m.ClientError):
                m.gh_read(m.RELAY['responsePath'])

    def run_fixture(self, response=RESPONSE_RAW, remote_code=0, outcome=None):
        saved, calls, posted, actions = {}, [], [], {}
        job = Path('/private-fixture/T54')
        def save(path, raw):
            if path in saved:
                raise FileExistsError()
            saved[path] = raw
        def execute(args, data=None, timeout=None):
            calls.append((args, data))
            if args[-1] == 'printf T54_RELAY_SSH_READY':
                return completed(args, b'T54_RELAY_SSH_READY')
            if args[-1].endswith('--prepare'):
                return completed(args, REQUEST_RAW)
            self.assertTrue(args[-1].endswith('--complete'))
            self.assertEqual(data, response)
            return completed(args, m.encode(outcome or self.outcome()), remote_code)
        with mock.patch.object(m, 'directory'), mock.patch.object(m, 'gh_branch_exists'), \
             mock.patch.object(m, 'gh_read', side_effect=[None, None, response]), \
             mock.patch.object(m, 'gh_publish_request', side_effect=posted.append), \
             mock.patch.object(m, 'process', side_effect=execute), \
             mock.patch.object(m, 'write_new', side_effect=save), \
             mock.patch.object(m.time, 'monotonic', return_value=10), \
             mock.patch.object(m.time, 'time_ns', return_value=(START + 2000) * 1000000):
            try:
                result = m.run_proof(self.helper(), 'b' * 64, SSH, job, actions)
                return result, saved, calls, posted, actions
            except Exception as e:
                return e, saved, calls, posted, actions

    def test_one_full_proof_posts_only_bound_technical_metadata_then_complete_stdin(self):
        result, saved, calls, posted, actions = self.run_fixture()
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(posted), 1)
        bundle = m.parse(posted[0])
        self.assertEqual(set(bundle), {'format', 'task', 'protocol', 'manifestSha256', 'requestSha256', 'request'})
        self.assertEqual(bundle['request'], REQUEST)
        self.assertEqual(bundle['requestSha256'], m.sha(REQUEST_RAW))
        self.assertEqual(bundle['protocol'], 'BRON_GITHUB_FENCE_PROOF_V1')
        self.assertEqual(len(saved), 4)
        self.assertTrue(actions['completeValidated'])

    def test_wrong_response_never_reaches_complete(self):
        wrong = m.encode({**RESPONSE, 'nonceSha256': 'c' * 64})
        result, saved, calls, posted, actions = self.run_fixture(response=wrong)
        self.assertIsInstance(result, m.ClientError)
        self.assertEqual(len(calls), 2)
        self.assertFalse(actions.get('completeAttempted', False))
        self.assertNotIn(Path('/private-fixture/T54/response.json'), saved)

    def test_failed_remote_reply_is_preserved_before_failure_is_reported(self):
        result, saved, calls, posted, actions = self.run_fixture(remote_code=2, outcome=self.outcome('BLOCKED'))
        self.assertIsInstance(result, m.ClientError)
        self.assertEqual(str(result), 'T54_CLIENT_COMPLETE_FAILED')
        self.assertEqual(m.parse(saved[Path('/private-fixture/T54/vps-proof-result.json')])['status'], 'BLOCKED')
        self.assertTrue(actions['completeAttempted'])

    def test_old_success_different_nonce_cannot_be_claimed(self):
        result, _, _, _, _ = self.run_fixture(outcome={**self.outcome(), 'nonceSha256': 'f' * 64})
        self.assertIsInstance(result, m.ClientError)
        self.assertEqual(str(result), 'T54_CLIENT_PROOF_NOT_PASS')

    def test_existing_github_request_blocks_before_any_ssh_or_prepare(self):
        with mock.patch.object(m, 'directory'), mock.patch.object(m, 'gh_branch_exists'), \
             mock.patch.object(m, 'gh_read', return_value=b'existing'), \
             mock.patch.object(m, 'process') as run, self.assertRaises(m.ClientError):
            m.run_proof(self.helper(), 'b' * 64, SSH, Path('/private-fixture/T54'))
        run.assert_not_called()

    def test_preflight_has_no_guard_prepare_or_source_effect(self):
        with mock.patch.object(m, 'directory'), mock.patch.object(m, 'gh_branch_exists'), \
             mock.patch.object(m, 'gh_read', return_value=None), \
             mock.patch.object(m, 'process', return_value=completed([], b'T54_RELAY_SSH_READY')) as run, \
             mock.patch.object(m, 'write_new') as write, \
             mock.patch.object(m.time, 'time_ns', return_value=START * 1000000):
            value = m.preflight('b' * 64, SSH, Path('/private-fixture/T54'))
        self.assertEqual(value['status'], 'T54_CLIENT_READY_NO_PREPARE')
        self.assertFalse(value['prepareAttempted'])
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0][-1], 'printf T54_RELAY_SSH_READY')
        write.assert_not_called()
        m.validate_preflight(value, 'b' * 64, SSH, START + 1000)
        for changed in [{**value, 'observedEpochMs': START - 900001},
                        {**value, 'manifestSha256': 'c' * 64},
                        {**value, 'sshArgvSha256': 'c' * 64},
                        {**value, 'prepareAttempted': True}]:
            with self.subTest(changed=changed), self.assertRaises(m.ClientError):
                m.validate_preflight(changed, 'b' * 64, SSH, START)

    def test_missing_branch_stops_before_prepare_even_when_contents_return_404(self):
        with mock.patch.object(m, 'process', return_value=completed([], b'{}', 1)), \
             self.assertRaisesRegex(m.ClientError, 'RELAY_BRANCH_MISSING'):
            m.gh_branch_exists()

    def test_private_files_are_exclusive_and_symlinks_are_not_read(self):
        with tempfile.TemporaryDirectory() as name:
            job = Path(name); job.chmod(0o700); p = job / 'proof.json'
            m.write_new(p, b'{}\n'); self.assertEqual(m.read(p, True), b'{}\n')
            with self.assertRaises(FileExistsError):m.write_new(p, b'overwrite')
            link = job / 'alias'; link.symlink_to(p)
            with self.assertRaises(OSError):m.read(link, True)
        with self.assertRaises(m.ClientError):m.parse(b'{"key":1,"key":2}')


if __name__ == '__main__':
    unittest.main()
