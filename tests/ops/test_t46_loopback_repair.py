import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('t46', ROOT / 'docs/runbooks/payloads/t46-loopback-repair.py')
m = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(m)


def records():
    return [{'name': '/' + name, 'id': m.DB_ID if name == 'supabase-db' else ('a' * 63 + str(n)),
             'image': m.DB_IMAGE if name == 'supabase-db' else 'sha256:' + 'b' * 64,
             'running': True, 'health': 'healthy',
             'networks': {'supabase_default': {'IPAddress': '172.18.0.3'}}}
            for n, name in enumerate(m.NODE_NAMES)]


class RepairTests(unittest.TestCase):
    def test_units_are_only_loopback_and_fixed_unprivileged_stock_proxy(self):
        units = m.render_units('172.18.0.3')
        self.assertEqual(set(units), {m.SOCKET, m.SERVICE})
        socket, service = units[m.SOCKET].decode(), units[m.SERVICE].decode()
        self.assertIn('ListenStream=127.0.0.1:15433\n', socket)
        self.assertEqual(socket.count('ListenStream='), 1)
        self.assertIn('Accept=no\n', socket)
        self.assertIn('User=nobody\nGroup=nogroup\nNoNewPrivileges=yes\n', service)
        self.assertIn('ExecStart=/usr/lib/systemd/systemd-socket-proxyd 172.18.0.3:5432\n', service)
        for term in ['ExecStartPre', 'ExecStartPost', 'Restart=', '[Install]', 'WantedBy=', '/bin/sh', '15432']:
            self.assertNotIn(term, socket + service)

    def test_render_rejects_external_ipv6_injection_and_loopback_destinations(self):
        for value in ['8.8.8.8', '127.0.0.1', '0.0.0.0', '::1', '172.18.0.3\nExecStart=/bin/sh', None]:
            with self.subTest(value=value), self.assertRaises(m.RepairError):
                m.render_units(value)

    def test_inventory_pins_actual_db_and_never_requests_environment(self):
        before, ip = m.inventory('\n'.join(json.dumps(r) for r in records()))
        self.assertEqual(ip, '172.18.0.3')
        self.assertEqual(before['supabase-db']['id'], m.DB_ID)
        self.assertNotIn('Env', m.INSPECT)
        self.assertNotIn('Config', m.INSPECT)

    def test_inventory_rejects_wrong_target_id_image_network_or_health(self):
        for field, value in [('id', 'a' * 64), ('image', 'sha256:' + 'c' * 64), ('health', 'starting'),
                             ('networks', {'unrelated': {'IPAddress': '172.18.0.3'}})]:
            rows = records(); rows[0][field] = value
            with self.subTest(field=field), self.assertRaises(m.RepairError):
                m.inventory('\n'.join(json.dumps(r) for r in rows))

    def test_listener_rejects_wildcard_ipv6_duplicates_and_preexisting_port(self):
        m.listener('', False)
        m.listener('LISTEN 0 4096 127.0.0.1:15433 0.0.0.0:*\n', True)
        for value in ['LISTEN 0 4096 0.0.0.0:15433 0.0.0.0:*',
                      'LISTEN 0 4096 [::]:15433 [::]:*',
                      'LISTEN 0 4096 127.0.0.1:15433 0.0.0.0:*\n' * 2]:
            with self.assertRaises(m.RepairError):
                m.listener(value, True)
        with self.assertRaises(m.RepairError):
            m.listener('LISTEN 0 4096 127.0.0.1:15433 0.0.0.0:*', False)

    def test_manifest_requires_exact_route_task_and_one_start(self):
        good = {'task': 'T46', 'actionId': m.ACTION, 'execution_authorized': True, 'maxStartAttempts': 1,
                'listen': '127.0.0.1:15433', 'runtimeUnitDirectory': str(m.UNIT_DIR),
                'target': {'container_id': m.DB_ID, 'image_id': m.DB_IMAGE},
                'files': {m.SELF_REL: 'a' * 64}}
        raw = m.encode(good)
        m.validate_manifest(raw, m.sha(raw), 'a' * 64)
        for field, value in [('listen', '0.0.0.0:15433'), ('maxStartAttempts', 2), ('task', 'T45')]:
            bad = {**good, field: value}; raw = m.encode(bad)
            with self.assertRaises(m.RepairError):
                m.validate_manifest(raw, m.sha(raw), 'a' * 64)

    def run_fixture(self, start_timeout=False, dropin=False, existing=False, changed=False):
        saved, calls = {}, []
        def save(path, raw, mode=0o600, claim=None):
            self.assertNotIn(str(path), saved)
            if claim: claim()
            saved[str(path)] = (raw, mode)
        inventory_calls = 0
        def command(args, record, **kwargs):
            nonlocal inventory_calls
            calls.append(args); record.append({'argv': args, 'status': 'EXITED', 'exit': 0})
            if args[0] == '/usr/bin/ss':
                return 'LISTEN 0 4096 127.0.0.1:15433 0.0.0.0:*\n' if len([x for x in calls if x[0] == '/usr/bin/ss']) > 1 else ''
            if args[0] == '/usr/bin/docker':
                inventory_calls += 1
                rows = records()
                if changed and inventory_calls > 1: rows[1]['id'] = 'c' * 64
                return '\n'.join(json.dumps(row) for row in rows)
            if '--property=LoadState' in args: return 'not-found\nnot-found\n'
            if '--property=Id,LoadState,FragmentPath,DropInPaths' in args:
                return 'Id=' + args[-1] + '\nLoadState=loaded\nFragmentPath=' + str(m.UNIT_DIR / args[-1]) + '\nDropInPaths=' + ('/etc/foreign.conf' if dropin else '') + '\n'
            if args[1] == 'start' and start_timeout: raise m.RepairError('T46_COMMAND_TIMEOUT_UNKNOWN')
            if '--property=ActiveState,SubState,Listen,Triggers' in args:
                return 'ActiveState=active\nSubState=listening\nListen=127.0.0.1:15433 (Stream)\nTriggers=' + m.SERVICE + '\n'
            return ''
        def absent(path):
            if existing: raise m.RepairError('T46_PREEXISTING_PATH')
        with mock.patch.object(m, 'directory'), mock.patch.object(m, 'absent', side_effect=absent), \
             mock.patch.object(m, 'verify_proxy'), mock.patch.object(m, 'save_new', side_effect=save), \
             mock.patch.object(m, 'read_unit', side_effect=lambda path: saved[str(path)][0]), \
             mock.patch.object(m, 'run_command', side_effect=command):
            result = m.repair({}, 'a' * 64)
        return result, saved, calls

    def test_exact_one_start_with_guard_before_units_and_no_backend_commands(self):
        result, saved, calls = self.run_fixture()
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['startAttempts'], 1)
        self.assertEqual(list(saved)[0], str(m.STATE / 'guard.json'))
        self.assertEqual(len([x for x in calls if x[0] == '/usr/bin/systemctl' and x[1] == 'start']), 1)
        self.assertEqual(len([x for x in calls if x[0] == '/usr/bin/systemctl' and x[1] == 'daemon-reload']), 1)
        self.assertEqual(saved[str(m.UNIT_DIR / m.SOCKET)][1], 0o644)
        self.assertTrue(result['backendUnchanged'])
        self.assertEqual(result['databaseQueries'], 0)
        self.assertFalse(any('restart' in x or 'enable' in x for x in calls))

    def test_start_timeout_is_observed_once_never_retried_and_remains_honest(self):
        result, _, calls = self.run_fixture(start_timeout=True)
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['startCommandOutcome'], 'TIMEOUT_UNKNOWN')
        self.assertEqual(result['startOutcome'], 'ACTIVE_VERIFIED')
        self.assertEqual(result['startAttempts'], 1)
        self.assertEqual(len([x for x in calls if x[0] == '/usr/bin/systemctl' and x[1] == 'start']), 1)

    def test_preexisting_path_stops_before_guard_or_command(self):
        result, saved, calls = self.run_fixture(existing=True)
        self.assertEqual(result['status'], 'BLOCKED')
        self.assertEqual(result['startAttempts'], 0)
        self.assertFalse(saved); self.assertFalse(calls)

    def test_dropin_blocks_before_start_and_preserves_created_guard_units(self):
        result, saved, calls = self.run_fixture(dropin=True)
        self.assertEqual(result['code'], 'T46_EFFECTIVE_UNIT_MISMATCH')
        self.assertEqual(result['startAttempts'], 0)
        self.assertIn(str(m.STATE / 'guard.json'), saved)
        self.assertIn(str(m.UNIT_DIR / m.SERVICE), saved)
        self.assertFalse(any(x[1] == 'start' for x in calls))

    def test_backend_change_blocks_after_single_start(self):
        result, saved, _ = self.run_fixture(changed=True)
        self.assertEqual(result['code'], 'T46_BACKEND_CHANGED')
        self.assertEqual(result['startAttempts'], 1)
        self.assertIn(str(m.STATE / 'result.json'), saved)

    def test_command_timeout_records_unknown_without_raw_error(self):
        record = []
        with mock.patch.object(m.subprocess, 'run', side_effect=subprocess.TimeoutExpired('PRIVATE', 15)):
            with self.assertRaisesRegex(m.RepairError, '^T46_COMMAND_TIMEOUT_UNKNOWN$'):
                m.run_command(['/usr/bin/systemctl', 'start', m.SOCKET], record)
        self.assertEqual(record[0]['status'], 'TIMEOUT_UNKNOWN')
        self.assertNotIn('PRIVATE', json.dumps(record))


if __name__ == '__main__':
    unittest.main()
