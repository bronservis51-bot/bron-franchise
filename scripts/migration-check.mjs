// Read-only reconciliation before switching the cabinet and the lead receiver.
import pg from 'pg';
import { loadEnv, need } from './env.mjs';
loadEnv();
async function state(url) {
  const db = new pg.Client({ connectionString:url });
  await db.connect();
  try {
    const sql = `select jsonb_build_object(
      'users',(select md5(coalesce(string_agg(id::text||coalesce(email,'')||coalesce(encrypted_password,''),'|' order by id),'')) from auth.users),
      'partners',(select count(*) from public.partner),
      'locations',(select count(*) from public.location),
      'assignments',(select md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by id),'')) from public.role_assignment x),
      'revenue',(select md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by id),'')) from public.daily_revenue x),
      'leads',(select md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by id),'')) from public.franchise_lead x),
      'royalty_payment',(select md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by id),'')) from public.royalty_payment x),
      'royalty_manual',(select md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by id),'')) from public.royalty_manual x),
      'supply',(select md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by month),'')) from app_private.supply_snapshot x),
      'documents',(select md5(coalesce(string_agg(to_jsonb(x)::text,'|' order by id),'')) from public.partner_document x)
    ) as state`;
    return (await db.query(sql)).rows[0].state;
  } finally { await db.end(); }
}
const source = await state(need('SOURCE_DATABASE_URL'));
const target = await state(need('TARGET_DATABASE_URL'));
const mismatch = Object.keys(source).filter(k => source[k]!==target[k]);
if (mismatch.length) { console.error('Mismatch:',mismatch.join(', ')); process.exitCode=1; }
else console.log('Matched: user IDs/password hashes, access, revenue, leads, royalties, supplies, document metadata. Verify storage bytes separately before switching.');
