"""Run against cached, isolated PG17: python tests/db/shift_concurrency_pg17.py."""
import importlib.util
import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('native', ROOT / 'tests/ops/restore-native-pg17.py')
native = importlib.util.module_from_spec(spec)
spec.loader.exec_module(native)


def commands(user):
    claims = json.dumps({'sub': user, 'role': 'authenticated'})
    return f"select set_config('request.jwt.claims','{claims}',true); set local role authenticated;"


def verify(fixture):
    psql = ['psql', '-XqAt', '-U', 'supabase_admin', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1']

    def query(sql):
        return fixture.execute(psql, input=sql, check=False)

    def ok(sql):
        result = query(sql)
        assert result.returncode == 0, result.stderr
        return result.stdout.strip().splitlines()[-1] if result.stdout.strip() else ''

    ok('create role postgres noinherit;' + (ROOT / 'supabase/tests-shim/00_supabase_shim.sql').read_text())
    for migration in sorted((ROOT / 'supabase/migrations').glob('*.sql')):
        ok(migration.read_text())
    ok((ROOT / 'supabase/seed/seed.sql').read_text())
    for user in json.loads((ROOT / 'supabase/seed/demo-users.json').read_text()):
        meta = json.dumps({'full_name': user['name']}).replace("'", "''")
        ok(f"insert into auth.users(email,raw_user_meta_data) values('{user['email']}','{meta}')")
    ok((ROOT / 'supabase/seed/seed_after_users.sql').read_text())
    owner = ok("select id from app_user where email='alpha.owner@demo.example.com'")
    partner = ok("select id from partner where code='ALPHA'")
    point = ok(f"""insert into location(code,name,partner_id,city,timezone,currency,opened_on)
        values('RACE','Проверка','{partner}','Тест','Europe/Moscow','RUB',current_date-7) returning id""")
    day = ok(f"select app_private.local_today('{point}')")

    def compete(first_user, first_command, second_user, second_command):
        marker = 'shift-' + uuid.uuid4().hex
        holder = subprocess.Popen(
            [fixture.docker, '--host', native.SOCKET, 'exec', '-i', fixture.container, *psql],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=fixture.environment)
        try:
            holder.stdin.write(f"begin; select app_private.revenue_day_lock('{point}','{day}');\n\\echo ready\n")
            holder.stdin.flush()
            while holder.stdout.readline().strip() != 'ready':
                assert holder.poll() is None, 'lock holder exited'
            with ThreadPoolExecutor() as pool:
                waiter = pool.submit(query, f"begin; set application_name='{marker}'; {commands(second_user)} {second_command}; commit;")
                deadline = time.monotonic() + 10
                while ok(f"select count(*) from pg_stat_activity where application_name='{marker}' and wait_event='advisory'") != '1':
                    assert time.monotonic() < deadline, 'second writer did not wait on the day lock'
                    time.sleep(0.03)
                _, err = holder.communicate(f"{commands(first_user)} {first_command}; commit;\n", timeout=15)
                second = waiter.result()
                assert holder.returncode == 0 and second.returncode != 0 and 'version-conflict' in second.stderr, (err, second.stderr)
        finally:
            if holder.poll() is None:
                holder.kill()
                holder.wait()

    for first in ('employee', 'supervisor', 'legacy checked revenue'):
        login = 'race.' + uuid.uuid4().hex[:8]
        employee = ok(f"begin;{commands(owner)} select staff_account_create('{partner}','Тест','{login}','test-only-password',array['{point}'::uuid],false);commit;")
        shift = ok(f"begin;{commands(employee)} select shift_submit('{point}','{day}',10000,0,gen_random_uuid())->'shift'->>'id';commit;")
        edit = f"select shift_close_versioned('{shift}',16000,0,1,gen_random_uuid(),null)"
        correction = f"select staff_shift_correct('{shift}',19000,0,1,'Сверили кассу',gen_random_uuid())"
        if first == 'employee':
            compete(employee, edit, owner, correction)
        elif first == 'supervisor':
            compete(owner, correction, employee, edit)
        else:
            revision = ok(f"select revision from daily_revenue where employee_id='{employee}' and day='{day}'")
            old = f"select revenue_save_checked('{point}','{day}',23000,0,{revision},gen_random_uuid(),'Старая очередь','{employee}')"
            compete(owner, correction, owner, old)
        total = 16000 if first == 'employee' else 19000
        assert ok(f"select count(*)||':'||sum(total_minor) from daily_revenue where employee_id='{employee}'") == f'1:{total}'
        assert ok(f"select revision||':'||total_minor from work_shift where id='{shift}'") == f'2:{total}'
        print('PASS', first, flush=True)

    other = ok(f"""insert into location(code,name,partner_id,city,timezone,currency,opened_on)
        values('RACE2','Вторая точка','{partner}','Тест','Europe/Moscow','RUB',current_date-7) returning id""")
    employee = ok(f"""begin;{commands(owner)} select staff_account_create('{partner}','Две точки','twopoints','test-only-password',
        array['{point}'::uuid,'{other}'::uuid],false);commit;""")
    # Supervisor writers on different points do not share the point/day lock.
    # Hold the first posting uncommitted while the second waits on its daily claim.
    holder = subprocess.Popen(
        [fixture.docker, '--host', native.SOCKET, 'exec', '-i', fixture.container, *psql],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=fixture.environment)
    try:
        holder.stdin.write(f"begin;{commands(owner)} select revenue_save('{point}','{day}',0,0,null,'{employee}');\n\\echo ready\n")
        holder.stdin.flush()
        while holder.stdout.readline().strip() != 'ready':
            assert holder.poll() is None, 'first point writer exited'
        with ThreadPoolExecutor() as pool:
            pending = pool.submit(query, f"begin;set application_name='second-pay-point';{commands(owner)} select revenue_save('{other}','{day}',0,0,null,'{employee}');commit;")
            deadline = time.monotonic() + 10
            while ok("select count(*) from pg_stat_activity where application_name='second-pay-point' and wait_event_type='Lock'") != '1':
                assert time.monotonic() < deadline, 'second payroll writer did not encounter the pending first claim'
                time.sleep(.03)
            holder.communicate('commit;\n',timeout=15)
            second = pending.result()
            assert holder.returncode == 0 and second.returncode == 0, second.stderr
    finally:
        if holder.poll() is None:
            holder.kill()
            holder.wait()
    assert ok(f"select count(*)||':'||count(*) filter(where counts_as_exit)||':'||sum(earned_minor) from work_shift where employee_id='{employee}'") == '2:1:100000'
    print('PASS concurrent payroll at two points', flush=True)


if __name__ == '__main__':
    with tempfile.TemporaryDirectory() as config:
        fixture = native.Fixture(shutil.which('docker'), config)
        try:
            fixture.create()
            verify(fixture)
        finally:
            fixture.cleanup()
