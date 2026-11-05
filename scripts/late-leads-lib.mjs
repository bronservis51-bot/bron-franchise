// Temporary, insert-only reconciliation for questionnaires opened before cutover.
// Never uses lead_submit: that would create new UUIDs and re-run phone deduplication.
const shapeSql = `select a.attname as name,format_type(a.atttypid,a.atttypmod) as type,
  a.attnotnull as required,a.attidentity as identity,a.attgenerated as generated
  from pg_attribute a where a.attrelid='public.franchise_lead'::regclass
  and a.attnum>0 and not a.attisdropped order by a.attnum`;
const quote = name => `"${name.replaceAll('"', '""')}"`;

export class LeadBridgeError extends Error {
  constructor(code) { super(code); this.code = code; }
}

async function shape(db) {
  const columns = (await db.query(shapeSql)).rows;
  const required = ['id','created_at','updated_at','status','note','updated_by',
    'instagram','pipeline_column','budget','timing','manage','experience','place'];
  if (required.some(name => !columns.some(c => c.name === name)) ||
      columns.some(c => c.identity || c.generated)) throw new LeadBridgeError('lead-schema-unsupported');
  return columns;
}

export async function readSourceLeads(db) {
  await db.query('begin isolation level repeatable read read only');
  try {
    await db.query("set local timezone='UTC'");
    await db.query("set local statement_timeout='30s'");
    const columns = await shape(db);
    // JSON text preserves Postgres microseconds; node-postgres Date conversion does not.
    const rows = (await db.query(`select id,to_jsonb(l)::text as payload
      from public.franchise_lead l order by created_at,id limit 10001`)).rows;
    if (rows.length > 10000) throw new LeadBridgeError('lead-bridge-size-limit');
    await db.query('commit');
    return { columns, rows };
  } catch (error) { await db.query('rollback'); throw error; }
}

function untouchedQuestionnaire(payload) {
  const l = JSON.parse(payload);
  return l.status === 'new' && l.note === null && l.updated_by === null &&
    l.instagram === null && l.pipeline_column === null && l.created_at === l.updated_at &&
    ['full','partial','none'].includes(l.budget) &&
    ['month','quarter','half','research'].includes(l.timing) &&
    ['self','manager','undecided'].includes(l.manage) &&
    ['business','some','none'].includes(l.experience) && ['has','options','help'].includes(l.place);
}

export async function reconcileLateLeads(db, snapshot, { apply = false } = {}) {
  await db.query(apply ? 'begin' : 'begin read only');
  try {
    await db.query("set local timezone='UTC'");
    await db.query("set local statement_timeout='30s'");
    await db.query("set local lock_timeout='5s'");
    const columns = await shape(db);
    if (JSON.stringify(columns) !== JSON.stringify(snapshot.columns)) throw new LeadBridgeError('lead-schema-mismatch');
    const ids = snapshot.rows.map(l => l.id);
    const existing = new Set((await db.query('select id from public.franchise_lead where id=any($1::uuid[])', [ids])).rows.map(l => l.id));
    const pending = snapshot.rows.filter(l => !existing.has(l.id));
    // A source-side manager edit/manual entry after the freeze needs explicit reconciliation.
    // Refuse the entire batch rather than silently treating it as an anonymous questionnaire.
    if (pending.some(l => !untouchedQuestionnaire(l.payload))) throw new LeadBridgeError('source-lead-needs-review');
    let inserted = 0;
    if (apply) {
      const names = columns.map(c => quote(c.name)).join(',');
      for (const row of pending) {
        const added = await db.query(`insert into public.franchise_lead(${names})
          select ${names} from jsonb_populate_record(null::public.franchise_lead,$1::jsonb)
          on conflict(id) do nothing returning id`, [row.payload]);
        if (added.rows.length) {
          inserted++;
          const verified = (await db.query('select to_jsonb(l)=$2::jsonb as matched from public.franchise_lead l where id=$1', [row.id,row.payload])).rows[0];
          if (!verified?.matched) throw new LeadBridgeError('lead-copy-mismatch');
        }
      }
      const present = (await db.query('select id from public.franchise_lead where id=any($1::uuid[])', [ids])).rows.length;
      if (present !== ids.length) throw new LeadBridgeError('lead-copy-incomplete');
    }
    await db.query('commit');
    return { source: ids.length, existing: existing.size, pending: pending.length, inserted, mode: apply ? 'apply' : 'dry-run' };
  } catch (error) { await db.query('rollback'); throw error; }
}
