import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'docs/runbooks/payloads' / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


OP = module('t64_update', 't64a-access-hotfix.py')


def catalog(gap=False):
    functions = [{'signature': ('caller_' + str(i) if i < 8 else 'fixture_8'),
                  'exists': True, 'owner': 'postgres'} for i in range(9)]
    edges = [{'caller': 'caller_' + str(i), 'callee': 'callee_' + str(i),
              'callerOwnerCanExecute': not (gap and i == 0)} for i in range(11)]
    return {'kind': 'T64A_STAFF_CATALOG_ONLY', 'functions': functions, 'edges': edges}


class T64AProductUpdateTests(unittest.TestCase):
    def test_single_acl_migration_and_no_t63_reexecution(self):
        self.assertEqual(OP.MIGRATIONS, ('20261116040000_staff_helper_execute.sql',))
        self.assertTrue(all(name not in OP.MIGRATIONS for name in OP.PREREQUISITES))
        manifest = {'format': 1, 'task': 'T64A', 'migrations': [
            {'name': name, 'sha256': 'a' * 64} for name in OP.PREREQUISITES]}
        with mock.patch.object(OP, 'checked_file', return_value=json.dumps(manifest).encode()):
            with self.assertRaisesRegex(OP.Blocked, 'MIGRATION_ALLOWLIST'):
                OP.migration_bundle('/root/private/manifest.json')

    def test_single_transaction_contains_exact_prerequisites_and_notify_before_commit(self):
        query = OP.migration_sql([({'name': OP.MIGRATIONS[0], 'sha256': 'a' * 64}, 'SELECT 17;')])
        self.assertTrue(query.startswith('BEGIN;'))
        for name, digest in OP.PREREQUISITES.items():
            self.assertIn("('%s','%s')" % (name, digest), query)
        self.assertLess(query.index('T64A_T63_PREREQUISITE_MISMATCH'), query.index('SELECT 17;'))
        self.assertLess(query.index("NOTIFY pgrst, 'reload schema';"), query.index('COMMIT;'))
        self.assertEqual(query.count('COMMIT;'), 1)
        self.assertIn('\\gset\n\\if :apply_0\n', query)
        self.assertNotIn('\\\\gset', query)
        self.assertTrue(query.endswith("SELECT 'T64A_MIGRATIONS_COMMITTED';\n"))

    def test_catalog_never_selects_auth_or_business_rows(self):
        query = OP.CATALOG_SQL.lower()
        for forbidden in ('auth.users', 'auth.sessions', 'staff_member ', 'daily_revenue ',
                          'encrypted_password', 'select *'):
            self.assertNotIn(forbidden, query)
        self.assertIn('repeatable read read only', query)
        self.assertTrue(query.rstrip().endswith('rollback;'))
        with mock.patch.object(OP, 'sql', return_value=json.dumps(catalog(True)).encode()):
            result = OP.catalog()
        self.assertEqual(OP.gaps(result), [{'caller': 'caller_0', 'callee': 'callee_0'}])

    def test_unverified_catalog_edge_stops_before_mutation(self):
        value = catalog()
        value['edges'][0]['callerOwnerCanExecute'] = None
        with mock.patch.object(OP, 'sql', return_value=json.dumps(value).encode()):
            with self.assertRaisesRegex(OP.Blocked, 'CATALOG_EDGE_UNVERIFIED'):
                OP.catalog()

    def test_private_repeat_guard_prevents_any_target_command(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            (base / 'migration-intent.json').write_text('{}')
            with mock.patch.object(OP, 'target_ready') as target, mock.patch.object(OP, 'sql') as sql:
                with self.assertRaisesRegex(OP.Blocked, 'OUTPUT_ALREADY_EXISTS_NO_REPEAT'):
                    OP.perform(base, '/root/private/manifest.json')
                target.assert_not_called()
                sql.assert_not_called()

    def perform_fixture(self, post):
        records = {}
        scripts = [({'name': OP.MIGRATIONS[0], 'sha256': 'a' * 64}, 'SELECT 17;')]
        outcomes = [json.dumps(catalog(True)).encode(), b'T64A_MIGRATIONS_COMMITTED\n', post]
        with tempfile.TemporaryDirectory() as folder, \
                mock.patch.object(OP, 'migration_bundle', return_value=scripts), \
                mock.patch.object(OP, 'target_ready'), \
                mock.patch.object(OP, 'checked_file', return_value=b'live manifest'), \
                mock.patch.object(OP, 'PREVIOUS_MANIFEST_SHA', OP.sha(b'live manifest')), \
                mock.patch.object(OP, 'freshness', return_value={'backupAgeSeconds': 120, 'healthAgeSeconds': 15}), \
                mock.patch.object(OP, 'sql', side_effect=outcomes), \
                mock.patch.object(OP, 'private_write', side_effect=lambda path, data: records.__setitem__(Path(path).name, data)):
            result = OP.perform(Path(folder), '/root/private/manifest.json')
        return result, records

    def test_commit_is_durable_before_catalog_postcheck_and_grants_are_reported(self):
        result, records = self.perform_fixture(json.dumps(catalog()).encode())
        self.assertEqual(result['status'], 'MIGRATIONS_COMMITTED')
        self.assertTrue(result['aclGapObservedBefore'])
        self.assertEqual(len(result['missingExecuteBefore']), 1)
        self.assertEqual(result['missingExecuteAfter'], [])
        self.assertEqual(result['neededExecuteGrantsBefore'], [{'databaseRole': 'postgres', 'function': 'callee_0'}])
        self.assertEqual(result['neededExecuteGrantsAfter'], [])
        self.assertLess(list(records).index('migration-commit.json'), list(records).index('catalog-after.json'))
        for field in ('sourceQueries', 'authRowsRead', 'passwordsReset', 'roleAssignmentsChanged', 'actualPhoneChanges'):
            self.assertEqual(result[field], 0)

    def test_failed_postcheck_keeps_committed_outcome_and_stops_publication(self):
        result, records = self.perform_fixture(OP.Blocked('POST_CATALOG_FAILED'))
        self.assertEqual(result['status'], 'COMMITTED_POSTCHECK_BLOCKED')
        self.assertEqual(result['postcheckCode'], 'POST_CATALOG_FAILED')
        self.assertEqual(json.loads(records['migration-commit.json'])['status'], 'MIGRATIONS_COMMITTED')
        self.assertFalse(result['staticPublished'])

    def test_remaining_execute_gap_is_not_a_false_pass(self):
        result, unused = self.perform_fixture(json.dumps(catalog(True)).encode())
        self.assertEqual(result['status'], 'COMMITTED_POSTCHECK_BLOCKED')
        self.assertEqual(result['aclCatalogPostcheck'], 'BLOCKED')

    def test_native_sql_prerequisite_guard_accepts_only_exact_complete_t63_ledger(self):
        node = '/tmp/bron-node22-tls-g26skisz/node'
        if not Path(node).is_file():
            node = shutil.which('node')
        if not node:
            self.skipTest('node unavailable')
        script = """
import { PGlite } from '@electric-sql/pglite';
let text='';for await(const piece of process.stdin)text+=piece;
const {query,entries}=JSON.parse(text);const db=new PGlite();
try{
 await db.exec('create schema app_private; create table app_private.schema_migration(name text primary key,checksum text not null)');
 let missing=false;try{await db.exec(query);}catch(e){missing=e.message.includes('T64A_T63_PREREQUISITE_MISMATCH');}
 if(!missing)throw Error('MISSING_PREREQ_NOT_REJECTED');
 for(const [name,hash] of entries)await db.query('insert into app_private.schema_migration values($1,$2)',[name,hash]);
 await db.exec(query);
 await db.query('update app_private.schema_migration set checksum=$1 where name=$2',['stale',entries[0][0]]);
 let stale=false;try{await db.exec('begin;'+query+'create table public.must_not_exist(id int);commit;');}catch(e){stale=e.message.includes('T64A_T63_PREREQUISITE_MISMATCH');await db.exec('rollback');}
 if(!stale)throw Error('STALE_PREREQ_NOT_REJECTED');
 if((await db.query("select to_regclass('public.must_not_exist') v")).rows[0].v!==null)throw Error('MUTATION_ESCAPED');
 console.log('PREREQUISITE_SQL_PASS');
}finally{await db.close();}
"""
        result = subprocess.run([node, '--input-type=module', '-e', script],
                                input=json.dumps({'query': OP.prerequisite_sql(), 'entries': list(OP.PREREQUISITES.items())}),
                                text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, cwd=ROOT, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('PREREQUISITE_SQL_PASS', result.stdout)


if __name__ == '__main__':
    unittest.main()
