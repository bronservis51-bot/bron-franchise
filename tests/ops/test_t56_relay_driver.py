"""Offline control-plane fixtures; never contact GitHub, VPS or Source."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import types
import unittest
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('t56_driver_fixture', REPO / 'docs/runbooks/payloads/t56-relay-driver.py')
d = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(d)
PIN = 'a' * 64
NOW = 1794729000000


def context(stage, created=NOW - 100):
    request, ack = d.paths(stage)
    return {'format': 1, 'protocol': 'T56.preflight_nonce' if stage == 'ready' else 'BRON_COORDINATOR_FENCE_REQUEST_V1',
        'actionId': 'T56.coordinator_ready' if stage == 'ready' else 'T56.final_https_window',
        'manifestSha256': PIN, 'sourceProject': d.PROJECT, 'sourceBarrierActionId': d.BARRIER_ACTION,
        'sourceBarrierReceiptSha256': d.BARRIER, 'verifyFencedSqlSha256': d.VERIFY,
        'stage': stage, 'nonceSha256': d.sha(('fixture-' + stage).encode()),
        'createdEpochMs': created, 'expiresEpochMs': created + 60000,
        'requestPath': request, 'ackPath': ack, 'requestSha256': d.sha(('request-' + stage).encode()),
        'storageUid': 0, 'storageGid': 0, 'storageMode': 384}


def response(c):
    if c['stage'] == 'ready':
        return {'format': 1, 'protocol': 'BRON_T56_READY_RESPONSE_V1', 'task': 'T56',
            'actionId': 'T56.coordinator_ready', 'manifestSha256': PIN, 'sourceProject': d.PROJECT,
            'sourceBarrierActionId': d.BARRIER_ACTION, 'sourceBarrierReceiptSha256': d.BARRIER,
            'verifyFencedSqlSha256': d.VERIFY, 'requestSha256': c['requestSha256'],
            'contextSha256': d.sha(d.encode(c)), 'nonceSha256': c['nonceSha256'],
            'sourceCheckedMicros': str((c['createdEpochMs'] + 50) * 1000),
            'workerId': d.RELAY['workerId'], 'connector': 'Supabase MCP'}
    ack = {key: c[key] for key in ('format', 'actionId', 'manifestSha256', 'sourceProject',
        'sourceBarrierActionId', 'sourceBarrierReceiptSha256', 'verifyFencedSqlSha256',
        'stage', 'nonceSha256', 'expiresEpochMs')}
    ack.update(protocol='BRON_COORDINATOR_FENCE_ACK_V1',
        sourceCheckedMicros=str((c['createdEpochMs'] + 50) * 1000),
        normalConnectDenied=True, existingClientsDrained=True, providerBoundaryReviewed=True)
    raw = d.encode(ack)
    return {'ackJson': raw.decode(), 'rootAckSha256': d.sha(raw)}


def passed():
    return {'task': 'T56', 'actionId': 'T56.final_https_window', 'status': 'PASS',
        'targetWriteOutcome': 'COMMITTED', 'sourceMustRemainClosed': True, 'macDataTransit': False,
        'finalFreezeAudit': True, 'strictMismatchGroups': [], 'sourceFrameAttempts': 2,
        'authBudgetUsed': 3, 'changedAuthTimestampRows': 1, 'sourceUnchangedUnderFence': True,
        'targetRolesAndDatabaseUnchanged': True, 'oldT45Unchanged': True, 'oldT53Unchanged': True}


class Child:
    def __init__(self, lines, code=0, stderr=b''):
        self.stdout = io.BytesIO(b''.join(lines)); self.stderr = io.BytesIO(stderr)
        self.code = code; self.waited = False
    def wait(self, timeout=None):
        self.waited = True; return self.code
    def poll(self):
        return self.code


class DriverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='t56-OFFLINE-driver-')
        self.job = Path(self.temp.name).resolve(); self.job.chmod(0o700)
    def tearDown(self):
        self.temp.cleanup()

    def test_five_public_contexts_accept_no_raw_nonce_or_arbitrary_path(self):
        for stage in d.STAGES:
            c = context(stage)
            self.assertIs(d.validate_context(c, stage, PIN, NOW), c)
            for key, value in (('ackPath', '/root/.ssh/authorized_keys'), ('storageMode', 0o666),
                               ('format', True), ('manifestSha256', 'b' * 64), ('stage', 'end/..')):
                bad = copy.deepcopy(c); bad[key] = value
                with self.assertRaises(d.DriverError):
                    d.validate_context(bad, stage, PIN, NOW)
            bad = copy.deepcopy(c); bad['nonce'] = 'raw-nonce-must-not-leave-vps'
            with self.assertRaisesRegex(d.DriverError, 'CONTEXT_SHAPE'):
                d.validate_context(bad, stage, PIN, NOW)

    def test_source_clock_and_actual_challenge_deadlines_are_enforced(self):
        c = context('start'); r = response(c)
        self.assertEqual(d.validate_response(d.encode(r), c, PIN, NOW), r)
        for now in (c['expiresEpochMs'], c['createdEpochMs'] - 5001):
            with self.assertRaises(d.DriverError):
                d.validate_response(d.encode(r), c, PIN, now)
        ack = json.loads(r['ackJson']); ack['sourceCheckedMicros'] = str((NOW + 5001) * 1000)
        raw = d.encode(ack); r = {'ackJson': raw.decode(), 'rootAckSha256': d.sha(raw)}
        with self.assertRaisesRegex(d.DriverError, 'SOURCE_CLOCK'):
            d.validate_response(d.encode(r), c, PIN, NOW)

    def test_ready_exact_root_actor_and_canonical_ack_required(self):
        c = context('ready'); r = response(c)
        self.assertEqual(len(r), 15)
        self.assertEqual(d.validate_response(d.encode(r), c, PIN, NOW), r)
        for key, value in (('workerId', 'manual-chat'), ('contextSha256', 'b' * 64), ('connector', 'CLI')):
            bad = copy.deepcopy(r); bad[key] = value
            with self.assertRaises(d.DriverError):
                d.validate_response(d.encode(bad), c, PIN, NOW)
        with self.assertRaisesRegex(d.DriverError, 'NONCANONICAL'):
            d.validate_response(json.dumps(r).encode(), c, PIN, NOW)

    def test_actual_broker_builder_outputs_match_driver_for_all_five_stages(self):
        spec = importlib.util.spec_from_file_location('offline_t56_broker',
            REPO / 'docs/runbooks/payloads/t56-cloud-broker-io.py')
        broker = importlib.util.module_from_spec(spec); spec.loader.exec_module(broker)
        for stage in d.STAGES:
            c = context(stage)
            envelope = d.encode({'format': 1, 'task': 'T56', 'protocol': 'BRON_GITHUB_FENCE_WINDOW_V1',
                'manifestSha256': PIN, 'stage': stage, 'contextSha256': d.sha(d.encode(c)), 'context': c})
            self.assertEqual(broker.validate_envelope(envelope, PIN, stage, NOW), c)
            actual = broker.build_response(c, PIN, str((NOW - 50) * 1000), NOW)
            self.assertEqual(d.validate_response(broker.canonical(actual), c, PIN, NOW), actual)

    def test_ack_inner_hash_false_flags_and_extra_fields_fail(self):
        c = context('before-target-write'); r = response(c)
        for mutation in ('sha', 'flag', 'nonce', 'extra', 'notcanonical'):
            bad = copy.deepcopy(r); ack = json.loads(bad['ackJson'])
            if mutation == 'sha':
                bad['rootAckSha256'] = 'b' * 64
            else:
                if mutation == 'flag': ack['normalConnectDenied'] = False
                if mutation == 'nonce': ack['nonceSha256'] = 'b' * 64
                if mutation == 'extra': ack['rawNonce'] = 'not-permitted'
                raw = json.dumps(ack).encode() if mutation == 'notcanonical' else d.encode(ack)
                bad = {'ackJson': raw.decode(), 'rootAckSha256': d.sha(raw)}
            with self.assertRaises(d.DriverError):
                d.validate_response(d.encode(bad), c, PIN, NOW)

    def test_exclusive_local_guard_preserves_prior_attempt_and_symlink_rejected(self):
        target = self.job / 'guard.json'; d.write_new(target, b'{"guard":1}\n')
        with self.assertRaises(FileExistsError): d.write_new(target, b'{"guard":2}\n')
        self.assertEqual(d.read(target, True), b'{"guard":1}\n')
        link = self.job / 'link'; link.symlink_to(target)
        with self.assertRaises(OSError): d.read(link, True)
        target.chmod(0o644)
        with self.assertRaises(d.DriverError): d.read(target, True)

    def test_existing_strict_ssh_only_no_controlmaster_creation(self):
        args = ['ssh', '-o', 'StrictHostKeyChecking=yes', '-o', 'IdentityFile=/private/existing', d.HOST]
        self.assertEqual(d.ssh_argv(d.encode({'argv': args})), args)
        for bad in (args[:-1] + ['root@other'], args[:-1] + ['-n', d.HOST],
                    args[:-1] + ['-oStrictHostKeyChecking=no', d.HOST],
                    args[:-1] + ['-M', d.HOST]):
            with self.assertRaises(d.DriverError): d.ssh_argv(d.encode({'argv': bad}))

    def test_github_creation_has_no_overwrite_sha_and_uses_skip_ci(self):
        result = types.SimpleNamespace(returncode=0, stdout=b'{}', stderr=b'')
        with mock.patch.object(d, 'process', return_value=result) as proc:
            d.gh_publish('start', b'{"public":true}\n')
        call = proc.call_args
        body = json.loads(call.args[1])
        self.assertNotIn('sha', body); self.assertIn('[skip ci]', body['message'])
        self.assertEqual(body['branch'], 'ops/t56-final-relay-20261115')
        self.assertTrue(call.args[0][4].endswith('.release-control/t56/start.request.json'))

    def test_exchange_one_request_one_root_response_no_generated_ack(self):
        c = context('start'); raw = d.encode(response(c)); actions = {'events': []}
        with mock.patch.object(d.time, 'time_ns', return_value=NOW * 1000000), \
             mock.patch.object(d, 'gh_publish') as publish, \
             mock.patch.object(d, 'gh_read', return_value=raw), \
             mock.patch.object(d, 'deliver_ack', return_value={'status': 'ACK_DURABLE'}) as deliver:
            self.assertEqual(d.exchange(c, PIN, self.job, actions, ['ssh']), raw)
        publish.assert_called_once(); deliver.assert_called_once()
        envelope = json.loads(publish.call_args.args[1])
        self.assertEqual(envelope['contextSha256'], d.sha(d.encode(c)))
        self.assertNotIn('nonce', envelope['context'])
        self.assertEqual(deliver.call_args.args[2], json.loads(raw))
        self.assertTrue(actions['events'][0]['delivered'])

    def test_ready_exchange_does_not_write_ack_directly(self):
        c = context('ready'); raw = d.encode(response(c)); actions = {'events': []}
        with mock.patch.object(d.time, 'time_ns', return_value=NOW * 1000000), \
             mock.patch.object(d, 'gh_publish'), mock.patch.object(d, 'gh_read', return_value=raw), \
             mock.patch.object(d, 'deliver_ack') as deliver:
            self.assertEqual(d.exchange(c, PIN, self.job, actions, ['ssh']), raw)
        deliver.assert_not_called()

    def test_continuous_drain_four_real_challenges_then_final(self):
        lines = [b'COORDINATOR_FENCE_CHALLENGE ' + d.encode(context(stage)) for stage in d.STAGES[1:]]
        lines.append(b'T56_RESULT ' + d.encode(passed()))
        child = Child(lines, stderr=b'technical stderr\n' * 4096)
        actions = {'targetWriteOutcome': 'UNKNOWN'}; observed = []
        with mock.patch.object(d.time, 'time_ns', return_value=NOW * 1000000):
            result = d.drain_final(child, PIN, self.job, actions, lambda c: observed.append(c['stage']))
        self.assertEqual(result['status'], 'PASS'); self.assertEqual(observed, list(d.STAGES[1:]))
        self.assertTrue(child.waited); self.assertEqual(actions['targetWriteOutcome'], 'COMMITTED')
        self.assertEqual(actions['opaqueOutputBytes'], len(b'technical stderr\n' * 4096))

    def test_relay_failure_keeps_draining_and_preserves_committed_outcome(self):
        lines = [b'COORDINATOR_FENCE_CHALLENGE ' + d.encode(context('start')),
                 b'T56_RESULT ' + d.encode(passed())]
        actions = {'targetWriteOutcome': 'UNKNOWN'}; child = Child(lines)
        def fail(_): raise d.DriverError('T56_FIXTURE_RELAY_FAILED')
        with mock.patch.object(d.time, 'time_ns', return_value=NOW * 1000000), \
             self.assertRaisesRegex(d.DriverError, 'FIXTURE_RELAY_FAILED'):
            d.drain_final(child, PIN, self.job, actions, fail)
        self.assertTrue(child.waited)
        self.assertEqual(actions['targetWriteOutcome'], 'COMMITTED')
        self.assertTrue((self.job / 'vps-final-result.json').exists())

    def test_zero_delta_strict_pass_is_unchanged_not_a_fictitious_commit(self):
        result = passed(); result.update(changedAuthTimestampRows=0, targetWriteOutcome='UNCHANGED')
        self.assertEqual(d.final_result(result, PIN)['status'], 'PASS')
        result['targetWriteOutcome'] = 'COMMITTED'
        with self.assertRaisesRegex(d.DriverError, 'FINAL_NOT_PASS'):
            d.final_result(result, PIN)
        result.update(changedAuthTimestampRows=1, targetWriteOutcome='UNCHANGED')
        with self.assertRaisesRegex(d.DriverError, 'FINAL_NOT_PASS'):
            d.final_result(result, PIN)

    def test_ssh_eof_without_result_does_not_claim_unchanged_or_retry(self):
        actions = {'targetWriteOutcome': 'UNKNOWN'}; child = Child([], code=255)
        with self.assertRaisesRegex(d.DriverError, 'FINAL_RESULT_MISSING'):
            d.drain_final(child, PIN, self.job, actions, lambda _: self.fail('unexpected challenge'))
        self.assertEqual(actions['targetWriteOutcome'], 'UNKNOWN'); self.assertTrue(child.waited)

    def test_receipt_failure_cannot_erase_observed_commit(self):
        actions = {'targetWriteOutcome': 'UNKNOWN'}
        child = Child([b'T56_RESULT ' + d.encode(passed())])
        with mock.patch.object(d, 'write_new', side_effect=OSError('fixture disk failure')), \
             self.assertRaises(d.DriverError):
            d.drain_final(child, PIN, self.job, actions, lambda _: None)
        self.assertEqual(actions['targetWriteOutcome'], 'COMMITTED'); self.assertTrue(child.waited)

    def test_out_of_order_stage_blocks_further_actions_but_drains_final(self):
        blocked = {'task': 'T56', 'actionId': 'T56.final_https_window', 'status': 'BLOCKED',
            'targetWriteOutcome': 'UNCHANGED', 'sourceMustRemainClosed': True, 'macDataTransit': False}
        child = Child([b'COORDINATOR_FENCE_CHALLENGE ' + d.encode(context('end')),
                       b'T56_RESULT ' + d.encode(blocked)], code=2)
        actions = {'targetWriteOutcome': 'UNKNOWN'}
        with mock.patch.object(d.time, 'time_ns', return_value=NOW * 1000000), \
             self.assertRaises(d.DriverError):
            d.drain_final(child, PIN, self.job, actions, lambda _: self.fail('out-of-order delivery'))
        self.assertEqual(actions['targetWriteOutcome'], 'UNCHANGED'); self.assertTrue(child.waited)

    def test_unexpected_stdout_is_never_returned_in_public_error(self):
        secret = b'NOT_ALLOWED_PRIVATE_VALUE'
        actions = {'targetWriteOutcome': 'UNKNOWN'}; child = Child([secret + b'\n'])
        with self.assertRaises(d.DriverError) as raised:
            d.drain_final(child, PIN, self.job, actions, lambda _: None)
        self.assertNotIn(secret.decode(), str(raised.exception))
        self.assertNotIn(secret.decode(), json.dumps(actions))

    def test_actual_health_gate_allows_503_but_rejects_stale_backup(self):
        def iso(milliseconds):
            return d.datetime.fromtimestamp(milliseconds / 1000, tz=__import__('datetime').timezone.utc).isoformat().replace('+00:00', 'Z')
        class Reply(io.BytesIO):
            code = 503
            def geturl(self): return 'https://api.bronservis.ru/.well-known/bron-health.json'
        def body(age):
            return Reply(d.encode({'healthy': True, 'checked_at': iso(NOW - 1000),
                                   'last_backup_utc': iso(NOW - age)}))
        with mock.patch.object(d.urllib.request, 'urlopen', return_value=body(4199999)):
            self.assertEqual(d.health_check(NOW)['httpStatus'], 503)
        with mock.patch.object(d.urllib.request, 'urlopen', return_value=body(4200001)), \
             self.assertRaisesRegex(d.DriverError, 'BACKUP_STALE'):
            d.health_check(NOW)
        opened = body(1000); opened.code = 200
        with mock.patch.object(d.urllib.request, 'urlopen', return_value=opened), \
             self.assertRaisesRegex(d.DriverError, 'HEALTH_ENDPOINT'):
            d.health_check(NOW)

    def test_remote_writer_is_pinned_inline_code_not_shell_payload_interpolation(self):
        c = context('start'); r = response(c)
        result = types.SimpleNamespace(returncode=0,
            stdout=d.encode({'status': 'ACK_DURABLE', 'stage': 'start', 'sha256': d.sha(d.encode(r))}), stderr=b'')
        compile(d.ACK_WRITER, '<offline-remote-writer>', 'exec')
        with mock.patch.object(d, 'process', return_value=result) as proc:
            d.deliver_ack(['ssh', d.HOST], c, r, 8)
        self.assertEqual(json.loads(proc.call_args.args[1]), {'context': c, 'response': r})
        self.assertNotIn(c['nonceSha256'], proc.call_args.args[0][-1])
        self.assertIn('O_EXCL', d.ACK_WRITER); self.assertIn('O_NOFOLLOW', d.ACK_WRITER)

    def test_remote_writer_algorithm_durable_then_refuses_overwrite_in_isolated_fixture(self):
        # Exact writer code with ONLY deployment identity/path checks relocated for a
        # non-root temporary fixture. Production constants/code are not modified.
        remote = self.job / 'root'; remote.mkdir(mode=0o700)
        secrets = remote / 'bron-secrets'; secrets.mkdir(mode=0o700)
        release = secrets / 't56-release'; release.mkdir(mode=0o700)
        script = d.ACK_WRITER.replace("root='/root/bron-secrets/t56-release'", 'root=' + repr(str(release)))
        script = script.replace("('/root','/root/bron-secrets',root)", repr((str(remote), str(secrets), str(release))))
        script = script.replace('os.getuid()==0 and os.getgid()==0',
                                'os.getuid()==' + str(os.getuid()) + ' and os.getgid()==' + str(os.getgid()))
        script = script.replace('s.st_uid==0 and s.st_gid==0',
                                's.st_uid==' + str(os.getuid()) + ' and s.st_gid==' + str(os.getgid()))
        now = time.time_ns() // 1000000
        c = context('start', now); c['requestPath'] = str(release / 'fence-check-start.request.json')
        c['ackPath'] = str(release / 'fence-check-start.ack.json')
        request = {k: v for k, v in c.items() if k not in ('requestPath', 'ackPath', 'requestSha256',
                                                         'storageUid', 'storageGid', 'storageMode')}
        request['nonce'] = 'offline-fixture-only'; request['nonceSha256'] = d.sha(request['nonce'].encode())
        raw = d.encode(request); c.update(requestSha256=d.sha(raw), nonceSha256=request['nonceSha256'])
        d.write_new(Path(c['requestPath']), raw)
        body = d.encode({'context': c, 'response': response(c)})
        first = subprocess.run([d.sys.executable, '-I', '-c', script], input=body, capture_output=True)
        self.assertEqual(first.returncode, 0, first.stderr.decode())
        saved = Path(c['ackPath']).read_bytes(); self.assertEqual(saved, d.encode(response(c)))
        second = subprocess.run([d.sys.executable, '-I', '-c', script], input=body, capture_output=True)
        self.assertNotEqual(second.returncode, 0); self.assertEqual(Path(c['ackPath']).read_bytes(), saved)

    def test_transport_appendix_is_bound_to_unchanged_main_hash_and_self(self):
        fixture = self.job / 'repo'; payloads = fixture / 'docs/runbooks/payloads'; payloads.mkdir(parents=True)
        launcher = payloads / 't56-final-window.mjs'; launcher.write_bytes(b'offline launcher fixture\n')
        driver = payloads / 't56-relay-driver.py'; driver.write_bytes(Path(d.__file__).read_bytes())
        main = {'task': 'T56', 'actionId': 'T56.release_window', 'execution_authorized': True,
            'maxSuccessorWindows': 1, 'mcpRelay': d.RELAY, 't55ReceiptSha256': 'd' * 64,
            'files': {d.LAUNCHER: d.sha(launcher.read_bytes())}}
        main_path = payloads / 'main.json'; main_path.write_bytes(d.encode(main)); main_pin = d.sha(main_path.read_bytes())
        appendix = {'task': 'T56', 'protocol': 'BRON_T56_TRANSPORT_APPENDIX_V1', 'manifestSha256': main_pin,
            'execution_authorized': True, 'mcpRelay': d.RELAY, 'files': {d.SELF: d.sha(driver.read_bytes())}}
        appendix_path = payloads / 'appendix.json'; appendix_path.write_bytes(d.encode(appendix))
        self.assertEqual(d.load(main_path, main_pin, 'd' * 64, appendix_path,
                                d.sha(appendix_path.read_bytes())), main)
        appendix['manifestSha256'] = 'b' * 64; appendix_path.write_bytes(d.encode(appendix))
        with self.assertRaisesRegex(d.DriverError, 'APPENDIX_SCOPE'):
            d.load(main_path, main_pin, 'd' * 64, appendix_path, d.sha(appendix_path.read_bytes()))

    def test_run_ready_acceptance_immediately_starts_final_without_new_gh_probe(self):
        args = types.SimpleNamespace(prepared_sha256='b' * 64, deployment_proof_sha256='c' * 64,
                                    t55_receipt_sha256='d' * 64)
        ssh = ['ssh', d.HOST]
        saved = {'task': 'T56', 'status': 'T56_CLIENT_READY_NO_NONCE', 'manifestSha256': PIN,
            'sshArgvSha256': d.sha(d.encode(ssh)), 'preparedSha256': args.prepared_sha256,
            'deploymentProofSha256': args.deployment_proof_sha256, 't55ReceiptSha256': args.t55_receipt_sha256,
            'observedEpochMs': NOW - 1000}
        d.write_new(self.job / 'client-preflight.json', d.encode(saved))
        ready = context('ready'); calls = []
        prepared = types.SimpleNamespace(returncode=0, stdout=b'COORDINATOR_READY_CHALLENGE ' +
            d.encode(ready) + b'T56_RESULT ' + d.encode({'status': 'READY_CHALLENGE_PREPARED'}))
        accepted = types.SimpleNamespace(returncode=0, stdout=b'T56_RESULT ' +
            d.encode({'status': 'COORDINATOR_READY', 'readySha256': 'e' * 64}))
        def process(*argv, **kwargs):
            calls.append('accept' if '--accept-ready' in argv[0][-1] else 'prepare')
            return accepted if calls[-1] == 'accept' else prepared
        def spawn(*argv, **kwargs): calls.append('spawn'); return object()
        actions = {'events': []}
        final = passed()
        def drain(*argv, **kwargs):
            actions['vpsFinalResultSha256'] = d.sha(d.encode(final)); return final
        with mock.patch.object(d.time, 'time_ns', return_value=NOW * 1000000), \
             mock.patch.object(d, 'health_check', return_value={'healthy': True}), \
             mock.patch.object(d, 'process', side_effect=process), \
             mock.patch.object(d, 'exchange', return_value=d.encode(response(ready))), \
             mock.patch.object(d.subprocess, 'Popen', side_effect=spawn), \
             mock.patch.object(d, 'drain_final', side_effect=drain), \
             mock.patch.object(d, 'gh_unused') as unused:
            result = d.run(PIN, ssh, self.job, args, actions)
        self.assertEqual(calls, ['prepare', 'accept', 'spawn']); unused.assert_not_called()
        self.assertEqual(result['targetWriteOutcome'], 'COMMITTED')


if __name__ == '__main__':
    unittest.main()
