// Fixed compact Auth capture; exact SQL shared with the reviewed T30 planner.
export const authRowsSql=`SELECT u.id::text AS private_id,u.updated_at::text AS private_stamp,
 (extract(epoch FROM u.updated_at)*1000000)::numeric(30,0)::text AS private_micros,
 encode(pg_catalog.sha256(convert_to((to_jsonb(u)-'updated_at')::text,'UTF8')),'hex') AS private_other FROM auth.users u ORDER BY u.id LIMIT 17`;
