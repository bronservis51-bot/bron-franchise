"""Offline R1 GitHub request-read fixtures; no Source, GitHub or VPS calls."""
from contextlib import redirect_stdout
import ast
import importlib.util
import io
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
FILE = ROOT / 'docs/runbooks/payloads/t60-root-relay-r1.py'
SPEC = importlib.util.spec_from_file_location('t60_root_r1', FILE)
m = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(m)

def result(code=1, stdout=b'', stderr=b''):
    return types.SimpleNamespace(returncode=code, stdout=stdout, stderr=stderr)

class RootRelayTests(unittest.TestCase):
    def test_nonjson_failure_then_404_both_wait_without_inner_retry(self):
        with mock.patch.object(m.subprocess, 'run', side_effect=[result(stdout=b'upstream reset'), result(stdout=b'{"status":404}')]) as run:
            self.assertIsNone(m.github_read('ready')); self.assertIsNone(m.github_read('ready'))
        self.assertEqual(run.call_count, 2)
        self.assertTrue(all(c.kwargs['timeout'] == 8 for c in run.call_args_list))

    def test_timeout_and_server_error_wait(self):
        for failure in (subprocess.TimeoutExpired('gh', 8), result(stdout=b'{"status":502}'), result(stderr=b'dial tcp: network unreachable')):
            with self.subTest(failure=type(failure).__name__), mock.patch.object(m.subprocess, 'run') as run:
                if isinstance(failure, Exception): run.side_effect = failure
                else: run.return_value = failure
                self.assertIsNone(m.github_read('ready')); run.assert_called_once()

    def test_auth_failure_never_waits(self):
        for failure in (result(stdout=b'{"status":401}'), result(stdout=b'not-json', stderr=b'gh: HTTP 403'), result(stdout=b'{"status":422}')):
            with self.subTest(failure=failure), mock.patch.object(m.subprocess, 'run', return_value=failure):
                with self.assertRaises(m.BrokerError): m.github_read('ready')

    def test_success_malformed_or_wrong_file_fails(self):
        for raw in (b'not-json', b'{"type":"file","encoding":"base64","path":"wrong"}'):
            with self.subTest(raw=raw), mock.patch.object(m.subprocess, 'run', return_value=result(0, raw)):
                with self.assertRaises(m.BrokerError): m.github_read('ready')

    def test_wait_does_not_create_claim_context_or_query(self):
        with tempfile.TemporaryDirectory() as folder:
            job = Path(folder); job.chmod(0o700)
            argv = ['broker', '--manifest', 'unused', '--sha256', 'a'*64, '--job-directory', str(job), '--stage', 'ready', '--poll-and-claim']
            with mock.patch.object(m.sys, 'argv', argv), mock.patch.object(m, 'load_scope', return_value=(None, b'fixedSQL')), \
                 mock.patch.object(m.subprocess, 'run', return_value=result(stdout=b'network failure')), \
                 mock.patch.object(m, 'query_for') as query, mock.patch.object(m, 'durable_new') as write, redirect_stdout(io.StringIO()) as out:
                self.assertEqual(m.main(), 0)
            self.assertIn('WAITING', out.getvalue()); query.assert_not_called(); write.assert_not_called()
            self.assertEqual(list(job.iterdir()), [])

    def test_only_read_function_differs_python_and_only_local_route_differs_js(self):
        old = (FILE.parent/'t60-cloud-broker-io.py').read_text(); new = FILE.read_text()
        def outside_read(s):
            return s[:s.index('def github_read(stage):')] + s[s.index('\n\ndef github_publish'):]
        self.assertEqual(outside_read(old), outside_read(new))
        expected = (FILE.parent/'t60-cloud-broker.js').read_text().replace('runT60CloudBroker', 'runT60RootRelayR1').replace('/workspace/artifacts/t60-final-relay', '/workspace/artifacts/t60-final-relay-r1').replace('t60-cloud-broker-io.py', 't60-root-relay-r1.py')
        self.assertEqual((FILE.parent/'t60-root-relay-r1.js').read_text(), expected)
        ast.parse(new)

if __name__ == '__main__': unittest.main()
