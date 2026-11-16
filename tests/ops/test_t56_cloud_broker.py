import base64
from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('t56_broker', ROOT / 'docs/runbooks/payloads/t56-cloud-broker-io.py')
m = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(m)
PIN = 'a' * 64
START = 1794716000000
BASE = (ROOT / 'docs/runbooks/payloads/t50-verify-fenced.sql').read_bytes()


def context(stage='ready', started=START, nonce='b'):
    first = stage == 'ready'
    request, ack = m.vps_paths(stage)
    return {'format': 1, 'protocol': 'T56.preflight_nonce' if first else 'BRON_COORDINATOR_FENCE_REQUEST_V1',
        'actionId': 'T56.coordinator_ready' if first else 'T56.final_https_window',
        'manifestSha256': PIN, 'sourceProject': m.PROJECT, 'sourceBarrierActionId': m.BARRIER_ACTION,
        'sourceBarrierReceiptSha256': m.BARRIER_SHA, 'verifyFencedSqlSha256': m.VERIFY_SHA,
        'stage': stage, 'nonceSha256': nonce * 64, 'createdEpochMs': started,
        'expiresEpochMs': started + 60000, 'requestPath': request, 'ackPath': ack,
        'requestSha256': 'c' * 64, 'storageUid': 0, 'storageGid': 0, 'storageMode': 384}


def envelope(c):
    return {'format': 1, 'task': 'T56', 'protocol': 'BRON_GITHUB_FENCE_WINDOW_V1',
        'manifestSha256': PIN, 'stage': c['stage'], 'contextSha256': m.sha(m.canonical(c)), 'context': c}


class BrokerTests(unittest.TestCase):
    def test_all_five_contexts_derive_bound_query_and_exact_response_contract(self):
        query_hashes = set()
        for index, stage in enumerate(m.STAGES):
            c = context(stage, START + index * 1000, 'bcdef'[index])
            now = c['createdEpochMs'] + 1200
            self.assertEqual(m.validate_envelope(m.canonical(envelope(c)), PIN, stage, now), c)
            query = m.query_for(c, BASE)
            self.assertTrue(query.endswith(BASE))
            comment = json.loads(query.split(b'\n', 1)[0].split(b' ', 2)[2])
            self.assertEqual(comment['contextSha256'], m.sha(m.canonical(c)))
            self.assertEqual(comment['nonceSha256'], c['nonceSha256'])
            query_hashes.add(m.sha(query))
            response = m.build_response(c, PIN, str(now * 1000), now)
            if stage == 'ready':
                self.assertEqual(len(response), 15)
                self.assertEqual(response['protocol'], 'BRON_T56_READY_RESPONSE_V1')
                self.assertEqual(response['workerId'], m.WORKER)
            else:
                self.assertEqual(set(response), {'ackJson', 'rootAckSha256'})
                self.assertEqual(response['rootAckSha256'], m.sha(response['ackJson'].encode()))
                ack = json.loads(response['ackJson'])
                self.assertEqual(ack['stage'], stage)
                self.assertEqual(ack['nonceSha256'], c['nonceSha256'])
                self.assertEqual(m.canonical(ack).decode(), response['ackJson'])
                self.assertTrue(ack['normalConnectDenied'] and ack['existingClientsDrained'])
        self.assertEqual(len(query_hashes), 5)

    def test_wrong_stage_hash_storage_path_nonce_and_raw_nonce_rejected(self):
        original = context('start')
        mutations = [('stage', 'end'), ('manifestSha256', 'f' * 64),
            ('sourceProject', 'other'), ('sourceBarrierReceiptSha256', 'f' * 64),
            ('storageUid', True), ('storageMode', 420), ('nonceSha256', 'bad'),
            ('requestPath', m.VPS_DIR + '/unapproved.json')]
        for key, value in mutations:
            with self.subTest(key=key), self.assertRaises(m.BrokerError):
                m.validate_context({**original, key: value}, PIN, 'start', START + 1000)
        with self.assertRaises(m.BrokerError):
            m.validate_context({**original, 'nonce': 'forbidden'}, PIN, 'start', START + 1000)
        bad = {**envelope(original), 'contextSha256': 'f' * 64}
        with self.assertRaises(m.BrokerError):
            m.validate_envelope(m.canonical(bad), PIN, 'start', START + 1000)

    def test_stale_and_wrong_source_clock_cannot_become_response(self):
        c = context('ready')
        for now in [START - 5001, START + 20000]:
            with self.subTest(now=now), self.assertRaises(m.BrokerError):
                m.validate_envelope(m.canonical(envelope(c)), PIN, 'ready', now)
        for clock in [str((START - 5001) * 1000), str((START + 7001) * 1000), 1794716000000000]:
            with self.subTest(clock=clock), self.assertRaises(m.BrokerError):
                m.build_response(c, PIN, clock, START + 2000)
        with self.assertRaises(m.BrokerError):
            m.build_response(c, PIN, str((START + 27000) * 1000), START + 27000)
        ack = context('end')
        with self.assertRaises(m.BrokerError):
            m.build_response(ack, PIN, str((START + 57000) * 1000), START + 57000)

    def test_stage_order_requires_published_previous_and_no_existing_claim(self):
        with tempfile.TemporaryDirectory() as d:
            job = Path(d)
            with self.assertRaises(FileNotFoundError):
                m.require_stage_order(job, 'start', PIN)
            m.durable_new(job / 'result-ready.json', m.canonical({'status': 'RESPONSE_PUBLISHED',
                'stage': 'ready', 'manifestSha256': PIN}))
            m.require_stage_order(job, 'start', PIN)
            m.durable_new(job / 'claim-start.json', b'{"claimed":true}\n')
            with self.assertRaises(m.BrokerError):
                m.require_stage_order(job, 'start', PIN)

    def test_failed_state_blocks_later_ack_or_publication(self):
        with tempfile.TemporaryDirectory() as d:
            job = Path(d)
            m.record_failure(job, 'MCP_FENCE_PROVIDER_ERROR', 'before-target-write')
            with self.assertRaises(m.BrokerError):
                m.assert_healthy(job)
            with mock.patch.object(m.subprocess, 'run') as network:
                with self.assertRaises(m.BrokerError):
                    m.github_publish(job, 'end', b'{"not":"sent"}\n')
                network.assert_not_called()

    def test_actual_raw_is_private_before_decoder_and_error_never_published(self):
        with tempfile.TemporaryDirectory() as d:
            job = Path(d); c = context('start')
            query = m.query_for(c, BASE)
            m.durable_new(job / 'context-start.json', m.canonical(c))
            m.durable_new(job / 'claim-start.json', m.canonical({'manifestSha256': PIN,
                'stage': 'start', 'contextSha256': m.sha(m.canonical(c)), 'querySha256': m.sha(query)}))
            def reject(raw):
                self.assertEqual((job / 'mcp-raw-start.json').read_bytes(), raw)
                self.assertEqual((job / 'mcp-raw-start.json').stat().st_mode & 0o777, 0o600)
                raise m.BrokerError('MCP_FENCE_PROVIDER_ERROR')
            argv = ['broker', '--manifest', '/unused', '--sha256', PIN, '--job-directory', d,
                    '--stage', 'start', '--receive-raw-json', '{"isError":true}']
            with mock.patch.object(m.sys, 'argv', argv), \
                 mock.patch.object(m, 'load_scope', return_value=(types.SimpleNamespace(decode=reject), BASE)), \
                 mock.patch.object(m, 'github_publish') as publish, redirect_stdout(io.StringIO()):
                self.assertEqual(m.main(), 2)
                publish.assert_not_called()
            self.assertTrue((job / 'broker-failure.json').exists())
            self.assertFalse((job / 'response-start.json').exists())

    def test_github_put_has_no_overwrite_sha_and_contains_only_selected_response(self):
        with tempfile.TemporaryDirectory() as d:
            job = Path(d); raw = b'{"technical":"only"}\n'
            path = m.PREFIX + 'ready.response.json'
            wanted = m.hashlib.sha1(b'blob ' + str(len(raw)).encode() + b'\0' + raw).hexdigest()
            def send(args, **kwargs):
                value = json.loads((job / 'github-upload-ready.json').read_bytes())
                self.assertNotIn('sha', value)
                self.assertIn('[skip ci]', value['message'])
                self.assertEqual(base64.b64decode(value['content']), raw)
                return types.SimpleNamespace(returncode=0,
                    stdout=m.canonical({'content': {'path': path, 'sha': wanted}}))
            with mock.patch.object(m.subprocess, 'run', side_effect=send):
                self.assertEqual(m.github_publish(job, 'ready', raw), wanted)


if __name__ == '__main__':
    unittest.main()
