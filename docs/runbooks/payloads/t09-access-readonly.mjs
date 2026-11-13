// Temporary migration diagnostic. Call only with the already-probed target admin client.
// Existing user/session identifiers stay in memory. No Auth, business or fixture writes.
// This verifies database authorization, not HTTP routing or a password login.
export async function runTargetAccessChecks(db) {
  const groups = {};
  const one = async (sql, params = []) => (await db.query(sql, params)).rows[0];
  async function as(user, session, fn) {
    await db.query('SAVEPOINT access_context');
    try {
      await db.query("SELECT set_config('request.jwt.claims',$1,true)",
        [JSON.stringify(user ? { sub:user,role:'authenticated',session_id:session } : { role:'anon' })]);
      await db.query(user ? 'SET LOCAL ROLE authenticated' : 'SET LOCAL ROLE anon');
      return await fn();
    } finally {
      await db.query('ROLLBACK TO SAVEPOINT access_context');
      await db.query('RELEASE SAVEPOINT access_context');
    }
  }
  async function denied(sql, params, code, message) {
    await db.query('SAVEPOINT access_denial');
    try { await db.query(sql, params); return false; }
    catch (error) { return error.code === code && (!message || error.message === message); }
    finally {
      await db.query('ROLLBACK TO SAVEPOINT access_denial');
      await db.query('RELEASE SAVEPOINT access_denial');
    }
  }
  async function group(name, available, fn) {
    if (!available) { groups[name] = { status:'BLOCKED',reason:'EXISTING_COHORT_OR_SCOPE_MISSING' }; return; }
    try {
      const checks = await fn();
      groups[name] = { status:Object.values(checks).every(x => x === true) ? 'PASS' : 'FAIL',checks };
    } catch (error) {
      groups[name] = { status:'FAIL',code:/^[A-Z0-9_]{3,60}$/.test(error.code ?? '') ? error.code : 'ACCESS_QUERY_FAILED' };
    }
  }
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const identity = await one(`SELECT current_database()='postgres' AND current_user='supabase_admin'
      AND session_user='supabase_admin' AND current_setting('transaction_read_only')='on' AS ok`);
    if (!identity?.ok) throw Object.assign(new Error('TARGET_ACCESS_IDENTITY_MISMATCH'),{ code:'TARGET_ACCESS_IDENTITY_MISMATCH' });
    await db.query("SET LOCAL statement_timeout='30s'");
    const cohorts = {};
    for (const role of ['franchise_manager','franchisee','franchisee_manager','franchisee_staff']) {
      cohorts[role] = await one(`SELECT u.id AS uid,s.id AS sid,a.scope_id AS partner_id,
        EXISTS(SELECT 1 FROM public.role_assignment z JOIN public.role_permission rp ON rp.role=z.role
          WHERE z.user_id=u.id AND z.revoked_at IS NULL AND rp.permission='revenue.read') AS can_revenue,
        (SELECT l.id FROM public.location l WHERE l.partner_id=a.scope_id AND l.status='active' ORDER BY l.id LIMIT 1) AS location_id
        FROM public.app_user u JOIN public.role_assignment a ON a.user_id=u.id AND a.revoked_at IS NULL
        JOIN auth.sessions s ON s.user_id=u.id
        WHERE u.status='active' AND a.role=$1
          AND ($1='franchise_manager' OR NOT EXISTS(SELECT 1 FROM public.role_assignment z
            WHERE z.user_id=u.id AND z.revoked_at IS NULL AND z.scope_type='company'))
          AND ($1<>'franchisee_staff' OR (EXISTS(SELECT 1 FROM public.staff_member sm WHERE sm.user_id=u.id AND sm.active)
            AND NOT EXISTS(SELECT 1 FROM public.role_assignment z JOIN public.role_permission rp ON rp.role=z.role
              WHERE z.user_id=u.id AND z.revoked_at IS NULL AND rp.permission='revenue.read')))
        ORDER BY u.id,s.id LIMIT 1`,[role]);
    }
    const adminCounts = await one(`SELECT count(*)::int AS partners FROM public.partner`);
    const manager = cohorts.franchise_manager;
    await group('company_manager',manager,() => as(manager.uid,manager.sid,async () => ({
      self: (await one(`SELECT public.me()->'user'->>'id'=$1::text AS ok`,[manager.uid])).ok,
      partners: (await one('SELECT count(*)::int=$1::int AS ok FROM public.partner',[adminCounts.partners])).ok,
      revenue_rpc: (await one(`SELECT jsonb_typeof(public.revenue_overview(current_date)->'rows')='array' AS ok`)).ok,
    })));
    for (const role of ['franchisee','franchisee_manager']) {
      const actor = cohorts[role];
      const foreign = actor && await one(`SELECT l.id AS location_id,l.partner_id FROM public.location l
        WHERE l.status='active' AND NOT EXISTS(SELECT 1 FROM public.role_assignment a
          WHERE a.user_id=$1 AND a.revoked_at IS NULL AND (a.scope_type='company' OR a.scope_id=l.partner_id))
        ORDER BY l.id LIMIT 1`,[actor.uid]);
      await group(role,actor?.location_id && foreign,() => as(actor.uid,actor.sid,async () => ({
        self: (await one(`SELECT public.me()->'user'->>'id'=$1::text AS ok`,[actor.uid])).ok,
        own_partner: (await one('SELECT EXISTS(SELECT 1 FROM public.partner WHERE id=$1) AS ok',[actor.partner_id])).ok,
        own_location: (await one('SELECT EXISTS(SELECT 1 FROM public.location WHERE id=$1) AS ok',[actor.location_id])).ok,
        foreign_partner_hidden: (await one('SELECT NOT EXISTS(SELECT 1 FROM public.partner WHERE id=$1) AS ok',[foreign.partner_id])).ok,
        foreign_location_hidden: (await one('SELECT NOT EXISTS(SELECT 1 FROM public.location WHERE id=$1) AS ok',[foreign.location_id])).ok,
        own_staff_rpc: (await one(`SELECT jsonb_typeof(public.staff_list($1,current_date))='array' AS ok`,[actor.partner_id])).ok,
        foreign_staff_rpc_denied: await denied('SELECT public.staff_list($1,current_date)',[foreign.partner_id],'P0001','forbidden'),
        financial_rpc_matches_grants: actor.can_revenue
          ? (await one(`SELECT public.revenue_month($1,current_date)->>'location_id'=$1::text AS ok`,[actor.location_id])).ok
          : await denied('SELECT public.revenue_overview(current_date)',[],'P0001','forbidden'),
        foreign_revenue_rpc_denied: await denied('SELECT public.revenue_month($1,current_date)',[foreign.location_id],'P0001','not-found'),
      })));
    }
    const staff = cohorts.franchisee_staff;
    await group('staff',staff,() => as(staff.uid,staff.sid,async () => ({
      self: (await one(`SELECT public.me()->'user'->>'id'=$1::text AS ok`,[staff.uid])).ok,
      staff_rpc: (await one(`SELECT jsonb_typeof(public.staff_home(current_date)->'locations')='array' AS ok`)).ok,
      other_staff_hidden: (await one('SELECT NOT EXISTS(SELECT 1 FROM public.staff_member WHERE user_id<>$1) AS ok',[staff.uid])).ok,
      other_shifts_hidden: (await one('SELECT NOT EXISTS(SELECT 1 FROM public.work_shift WHERE employee_id<>$1) AS ok',[staff.uid])).ok,
      finance_rpc_denied: await denied('SELECT public.revenue_overview(current_date)',[],'P0001','forbidden'),
    })));
    await group('anonymous',true,() => as(null,null,async () => ({
      lead_submit_grant: (await one(`SELECT has_function_privilege(current_user,'public.lead_submit(jsonb)','execute') AS ok`)).ok,
      no_lead_read_grant: (await one(`SELECT NOT has_table_privilege(current_user,'public.franchise_lead','select') AS ok`)).ok,
      lead_read_denied: await denied('SELECT id FROM public.franchise_lead LIMIT 1',[],'42501'),
    })));
    const actor = cohorts.franchisee ?? cohorts.franchisee_manager ?? manager;
    const nonexistent = await one('SELECT gen_random_uuid() AS sid');
    const nonexistentVerified = !(await one('SELECT EXISTS(SELECT 1 FROM auth.sessions WHERE id=$1) AS found',[nonexistent.sid])).found;
    const foreignSession = actor && await one('SELECT id AS sid FROM auth.sessions WHERE user_id<>$1 ORDER BY id LIMIT 1',[actor.uid]);
    for (const [name,sid,available] of [['nonexistent_session',nonexistent.sid,actor && nonexistentVerified],
      ['foreign_session',foreignSession?.sid,actor && foreignSession]]) {
      await group(name,available,() => as(actor.uid,sid,async () => ({
        me_hidden: (await one(`SELECT public.me()->'user'='null'::jsonb AS ok`)).ok,
        partners_hidden: (await one('SELECT NOT EXISTS(SELECT 1 FROM public.partner) AS ok')).ok,
        locations_hidden: (await one('SELECT NOT EXISTS(SELECT 1 FROM public.location) AS ok')).ok,
        rpc_denied: await denied('SELECT public.revenue_overview(current_date)',[],'P0001','unauthenticated'),
      })));
    }
    const statuses = Object.values(groups).map(x=>x.status);
    return { scope:'DB_RLS_ONLY',status:statuses.includes('FAIL')?'FAIL':statuses.includes('BLOCKED')?'BLOCKED':'PASS',groups };
  } finally { await db.query('ROLLBACK'); }
}
