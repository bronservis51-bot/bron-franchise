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
SPEC = importlib.util.spec_from_file_location('t60_driver_fixture', REPO / 'docs/runbooks/payloads/t60-relay-driver.py')
d = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(d)
PIN = 'a' * 64
NOW = 1794729000000


def context(stage, created=NOW - 100):
    request, ack = d.paths(stage)
    return {'format': 1, 'protocol': 'T60.preflight_nonce' if stage == 'ready' else 'BRON_COORDINATOR_FENCE_REQUEST_V1',
        'actionId': 'T60.coordinator_ready' if stage == 'ready' else 'T60.final_https_window',
        'manifestSha256': PIN, 'sourceProject': d.PROJECT, 'sourceBarrierActionId': d.BARRIER_ACTION,
        'sourceBarrierReceiptSha256': d.BARRIER, 'verifyFencedSqlSha256': d.VERIFY,
        'stage': stage, 'nonceSha256': d.sha(('fixture-' + stage).encode()),
        'createdEpochMs': created, 'expiresEpochMs': created + 60000,
        'requestPath': request, 'ackPath': ack, 'requestSha256': d.sha(('request-' + stage).encode()),
        'storageUid': 0, 'storageGid': 0, 'storageMode': 384}


def response(c):
    if c['stage'] == 'ready':
        return {'format': 1, 'protocol': 'BRON_T60_READY_RESPONSE_V1', 'task': 'T60',
            'actionId': 'T60.coordinator_ready', 'manifestSha256': PIN, 'sourceProject': d.PROJECT,
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
    return {'task': 'T60', 'actionId': 'T60.final_https_window', 'status': 'PASS',
        'targetWriteOutcome': 'COMMITTED', 'sourceMustRemainClosed': True, 'macDataTransit': False,
        'finalFreezeAudit': True, 'strictMismatchGroups': [], 'sourceFrameAttempts': 2,
        'authBudgetUsed': 6, 'changedAuthTimestampRows': 1, 'sourceUnchangedUnderFence': True,
        'targetRolesAndDatabaseUnchanged': True, 'oldT45Unchanged': True, 'oldT53Unchanged': True, 'oldT56Unchanged': True, 'oldT58Unchanged': True}


class DriverTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='t60-OFFLINE-driver-')
        self.job = Path(self.temp.name).resolve(); self.job.chmod(0o700)
    def tearDown(self):
        self.temp.cleanup()

    def test_only_namespace_response_get_timeout_and_budget_changed(self):
        base = REPO / 'docs/runbooks/payloads'
        expected = (base / 't59-relay-driver.py').read_text().replace('T59', 'T60').replace('t59', 't60')
        expected = expected.replace("response = gh_read(relay_path(stage, 'response'), min(5, left()))",
                                    "response = gh_read(relay_path(stage, 'response'), min(20, left()))")
        expected = expected.replace("value.get('authBudgetUsed') == 5", "value.get('authBudgetUsed') == 6")
        expected = expected.replace("(5 if key == 'authBudgetUsed' else 16)", "(6 if key == 'authBudgetUsed' else 16)")
        self.assertEqual((base / 't60-relay-driver.py').read_text(), expected)

    def exchange(self, c, clock, raw=None, error=None):
        actions = {'events': []}
        if raw is None: raw = d.encode(response(c))
        with mock.patch.object(d.time, 'time_ns', side_effect=clock), \
             mock.patch.object(d, 'gh_publish') as publish, \
             mock.patch.object(d, 'gh_read', return_value=raw, side_effect=error) as read, \
             mock.patch.object(d, 'deliver_ack') as deliver:
            result = d.exchange(c, PIN, self.job, actions, ['ssh'])
        return result, actions, publish, read, deliver

    def test_response_get_has_20_seconds_only_one_publish_one_delivery(self):
        c = context('before-target-write')
        result, actions, publish, read, deliver = self.exchange(c, lambda: NOW * 1000000)
        self.assertEqual(result, d.encode(response(c)))
        self.assertEqual(read.call_args.args[1], 20)
        self.assertEqual(publish.call_args.args[2], 5)
        self.assertEqual(deliver.call_args.args[3], 8)
        publish.assert_called_once(); read.assert_called_once(); deliver.assert_called_once()
        self.assertTrue(actions['events'][0]['delivered'])

    def test_get_still_bounded_by_original_stage_absolute_deadline(self):
        c = context('before-target-write', NOW - 50000)
        _, _, publish, read, deliver = self.exchange(c, lambda: NOW * 1000000)
        self.assertEqual(read.call_args.args[1], 7)
        self.assertEqual(deliver.call_args.args[3], 7)
        publish.assert_called_once(); read.assert_called_once(); deliver.assert_called_once()

    def test_ready_retains_26_second_absolute_deadline_and_no_ack_write(self):
        c = context('ready', NOW - 10000)
        _, _, publish, read, deliver = self.exchange(c, lambda: NOW * 1000000)
        self.assertEqual(read.call_args.args[1], 16)
        publish.assert_called_once(); read.assert_called_once(); deliver.assert_not_called()

    def test_per_call_timeout_does_not_retry_or_republish(self):
        c = context('before-target-write'); actions = {'events': []}
        with mock.patch.object(d.time, 'time_ns', return_value=NOW * 1000000), \
             mock.patch.object(d, 'gh_publish') as publish, \
             mock.patch.object(d, 'gh_read', side_effect=d.DriverError('T60_DRIVER_PROCESS_TIMEOUT')) as read, \
             mock.patch.object(d, 'deliver_ack') as deliver:
            with self.assertRaisesRegex(d.DriverError, 'T60_DRIVER_PROCESS_TIMEOUT'):
                d.exchange(c, PIN, self.job, actions, ['ssh'])
        publish.assert_called_once(); read.assert_called_once(); deliver.assert_not_called()
        self.assertFalse((self.job / 'before-target-write.response.json').exists())

    def test_expired_context_does_not_publish(self):
        c = context('start', NOW - 61000)
        with mock.patch.object(d.time, 'time_ns', return_value=NOW * 1000000), \
             mock.patch.object(d, 'gh_publish') as publish, mock.patch.object(d, 'gh_read') as read:
            with self.assertRaises(d.DriverError): d.exchange(c, PIN, self.job, {'events': []}, ['ssh'])
        publish.assert_not_called(); read.assert_not_called()

    def test_late_response_cannot_weaken_nonce_expiry(self):
        c = context('before-target-write')
        times = iter([NOW, NOW, NOW, c['expiresEpochMs'] + 1])
        with mock.patch.object(d.time, 'time_ns', side_effect=lambda: next(times) * 1000000), \
             mock.patch.object(d, 'gh_publish') as publish, \
             mock.patch.object(d, 'gh_read', return_value=d.encode(response(c))) as read, \
             mock.patch.object(d, 'deliver_ack') as deliver:
            with self.assertRaises(d.DriverError):
                d.exchange(c, PIN, self.job, {'events': []}, ['ssh'])
        publish.assert_called_once(); read.assert_called_once(); deliver.assert_not_called()

    def test_ack_hash_binding_source_clock_and_flags_still_required(self):
        c = context('before-target-write')
        valid = response(c)
        self.assertEqual(d.validate_response(d.encode(valid), c, PIN, NOW), valid)
        for mutate in ('hash', 'nonce', 'source-clock', 'flag'):
            value = copy.deepcopy(valid); ack = json.loads(value['ackJson'])
            if mutate == 'hash': value['rootAckSha256'] = 'b' * 64
            else:
                if mutate == 'nonce': ack['nonceSha256'] = 'b' * 64
                if mutate == 'source-clock': ack['sourceCheckedMicros'] = str((c['createdEpochMs'] - 5001) * 1000)
                if mutate == 'flag': ack['normalConnectDenied'] = False
                value.update(ackJson=d.encode(ack).decode(), rootAckSha256=d.sha(d.encode(ack)))
            with self.subTest(mutate=mutate), self.assertRaises(d.DriverError):
                d.validate_response(d.encode(value), c, PIN, NOW)

    def test_pass_requires_actual_six_snapshot_total_and_preserves_row_bound(self):
        self.assertEqual(d.final_result(passed(), PIN)['status'], 'PASS')
        for count in (3, 4, 5, 7):
            with self.subTest(count=count), self.assertRaises(d.DriverError):
                d.final_result({**passed(), 'authBudgetUsed': count}, PIN)
        self.assertEqual(d.window_metadata(passed())['authBudgetUsed'], 6)
        with self.assertRaises(d.DriverError):
            d.final_result({**passed(), 'changedAuthTimestampRows': 3}, PIN)

if __name__ == '__main__':
    unittest.main()
