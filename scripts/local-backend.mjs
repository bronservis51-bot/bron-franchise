// Локальный бэкенд РАЗРАБОТКИ И ДИАГНОСТИКИ (не демонстрация и не production; COST-04).
// Эмулирует нужное клиенту подмножество Supabase (Auth, PostgREST, Storage) поверх PGlite с теми же
// миграциями, RLS и командами. Данные — local/pgdata, файлы — local/files, пароли — local/demo-users.local.md.
// Запуск: npm run local:backend, затем VITE_SUPABASE_URL=http://localhost:54321 npm run dev
import http from 'node:http';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createDb, readContract, root } from './db-lib.mjs';

const PORT = Number(process.env.PORT ?? 54321);
const LOCAL = join(root, 'local');
const DATA = join(LOCAL, 'pgdata');
const FILES = join(LOCAL, 'files');
mkdirSync(FILES, { recursive: true });
const secretFile = join(LOCAL, 'secret');
if (!existsSync(secretFile)) writeFileSync(secretFile, randomBytes(32).toString('hex'));
const SECRET = readFileSync(secretFile, 'utf8');

const fresh = !existsSync(DATA);
const passwords = [];
console.log(fresh ? 'Создаю локальную БД (миграции + seed)…' : 'Открываю локальную БД…');
const db = fresh
  ? await createDb({
      dataDir: DATA,
      onUser: async (d, u, id) => {
        // Общий пароль быстрого входа (как на демо-стенде), иначе — случайный для каждого пользователя
        const pw = process.env.VITE_DEMO_QUICK_PASSWORD || `Demo-${randomBytes(3).toString('hex')}-${randomBytes(3).toString('hex')}`;
        await d.exec('create schema if not exists local_dev');
        await d.exec('create table if not exists local_dev.password(email text primary key, user_id uuid not null, password text not null)');
        await d.query('insert into local_dev.password values ($1, $2, $3)', [u.email, id, pw]);
        passwords.push({ ...u, password: pw });
      },
    })
  : await (async () => {
      const { PGlite } = await import('@electric-sql/pglite');
      const { pg_trgm } = await import('@electric-sql/pglite/contrib/pg_trgm');
      return new PGlite(DATA, { extensions: { pg_trgm } });
    })();
if (fresh) {
  const md = ['# Локальные демо-пользователи (не коммитить)', '', '| Роль | Email | Пароль |', '| --- | --- | --- |',
    ...passwords.map((p) => `| ${p.name} | ${p.email} | ${p.password} |`)].join('\n');
  writeFileSync(join(LOCAL, 'demo-users.local.md'), md + '\n');
  console.log('Пароли записаны в local/demo-users.local.md');
}

const contract = Object.fromEntries((await readContract(db)).map((c) => [c.name, c]));

// ---------- JWT (HS256, локальный секрет) ----------
const b64u = (s) => Buffer.from(s).toString('base64url');
function sign(payload) {
  const h = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const p = b64u(JSON.stringify(payload));
  const s = createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}
function verify(token) {
  const [h, p, s] = String(token ?? '').split('.');
  if (!h || !p || !s) return null;
  if (createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url') !== s) return null;
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  return claims.exp > Date.now() / 1000 ? claims : null;
}
async function session(userId, email) {
  const now = Math.floor(Date.now() / 1000);
  const user = { id: userId, aud: 'authenticated', role: 'authenticated', email, app_metadata: { provider: 'email' }, user_metadata: {}, created_at: new Date().toISOString() };
  return {
    access_token: sign({ sub: userId, email, role: 'authenticated', aud: 'authenticated', iat: now, exp: now + 3600, typ: 'access' }),
    refresh_token: sign({ sub: userId, email, iat: now, exp: now + 30 * 86400, typ: 'refresh' }),
    token_type: 'bearer', expires_in: 3600, expires_at: now + 3600, user,
  };
}

// ---------- Выполнение от имени пользователя (как PostgREST: роль + claims + заголовки) ----------
async function asUser(claims, headers, fn) {
  return db.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true), set_config('request.headers', $2, true)`,
      [claims ? JSON.stringify(claims) : '', JSON.stringify(headers)]);
    await tx.exec(claims ? 'set local role authenticated' : 'set local role anon');
    return fn(tx);
  });
}

function pgError(e) {
  const status = e.code === '42501' ? 403 : e.code === 'P0001' ? 400 : e.code === '42883' || e.code === '42P01' ? 404 : 400;
  return [status, { code: e.code ?? 'PGRST000', message: e.message, details: e.detail ?? null, hint: e.hint ?? null }];
}

// ---------- RPC ----------
function arrayLiteral(v) {
  return `{${v.map((x) => (x === null ? 'NULL' : `"${String(x).replace(/["\\]/g, '\\$&')}"`)).join(',')}}`;
}
async function rpc(name, body, claims, headers) {
  const c = contract[name];
  if (!c) return [404, { code: 'PGRST202', message: `Could not find the function public.${name}`, details: null, hint: null }];
  const args = [];
  const params = [];
  for (const [k, v] of Object.entries(body ?? {})) {
    const i = c.args.indexOf(k);
    if (i < 0) return [404, { code: 'PGRST202', message: `Unknown argument ${k} for ${name}`, details: null, hint: null }];
    const type = c.types[i];
    params.push(v === null || v === undefined ? null : /json/.test(type) ? JSON.stringify(v) : type.endsWith('[]') ? arrayLiteral(v) : String(v));
    args.push(`${k} => $${params.length}::${type}`);
  }
  const call = `public.${name}(${args.join(', ')})`;
  const sql = c.returns === 'set' ? `select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb) as v from ${call} r`
    : c.returns === 'single' ? `select to_jsonb(r) as v from ${call} r`
    : c.returns === 'void' ? `select ${call}, null::jsonb as v`
    : `select to_jsonb(${call}) as v`;
  try {
    const r = await asUser(claims, headers, (tx) => tx.query(sql, params));
    let v = r.rows[0]?.v ?? null;
    if (c.returns === 'single' && v && Object.values(v).every((x) => x === null)) v = null;
    return [200, v];
  } catch (e) {
    return pgError(e);
  }
}

// ---------- Чтение таблиц (подмножество PostgREST) ----------
const fkCache = (await db.query(`
  select c.conname, replace(c.conrelid::regclass::text, 'public.', '') as child, replace(c.confrelid::regclass::text, 'public.', '') as parent,
    (select array_agg(a.attname order by k.o) from unnest(c.conkey) with ordinality k(att, o) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.att) as child_cols,
    (select array_agg(a.attname order by k.o) from unnest(c.confkey) with ordinality k(att, o) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.att) as parent_cols
  from pg_constraint c join pg_namespace n on n.oid = c.connamespace where c.contype = 'f' and n.nspname = 'public'`)).rows;
const colTypes = new Map();
async function types(table) {
  if (!colTypes.has(table)) {
    const r = await db.query(`select attname, format_type(atttypid, atttypmod) as t from pg_attribute where attrelid = $1::regclass and attnum > 0 and not attisdropped`, [`public.${table}`]);
    colTypes.set(table, Object.fromEntries(r.rows.map((x) => [x.attname, x.t])));
  }
  return colTypes.get(table);
}
const ident = (s) => { if (!/^[a-z_][a-z0-9_]*$/.test(s)) throw new Error(`bad identifier ${s}`); return `"${s}"`; };

function splitTop(s) {
  const out = []; let depth = 0; let cur = ''; let q = false;
  for (const ch of s) {
    if (ch === '"') q = !q;
    if (!q && ch === '(') depth++;
    if (!q && ch === ')') depth--;
    if (!q && ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
function parseSelect(s) {
  return splitTop(s || '*').map((item) => {
    const m = /^(?:(\w+):)?(\w+)(?:!(\w+))?\((.*)\)$/s.exec(item);
    if (m) return { embed: true, alias: m[1] ?? m[2], table: m[2], hint: m[3], select: parseSelect(m[4]) };
    return { embed: false, col: item };
  });
}
async function selectExpr(table, alias, items, params, depth = 0) {
  const t = await types(table);
  const cols = items.filter((i) => !i.embed);
  let base = cols.some((c) => c.col === '*') ? `to_jsonb(${alias})` : `jsonb_build_object(${cols.map((c) => { if (!(c.col in t)) throw new Error(`column ${table}.${c.col} does not exist`); return `'${c.col}', ${alias}.${ident(c.col)}`; }).join(', ') || "'_', null"})`;
  for (const e of items.filter((i) => i.embed)) {
    const fk = fkCache.find((f) => (!e.hint || f.conname === e.hint) && ((f.child === e.table && f.parent === table) || (f.child === table && f.parent === e.table)));
    if (!fk) throw new Error(`no relationship ${table} → ${e.table}`);
    const a2 = `e${depth}_${e.alias}`;
    const inner = await selectExpr(e.table, a2, e.select, params, depth + 1);
    const oneToMany = fk.child === e.table && fk.parent === table;
    const join = fk.child_cols.map((c, i) => oneToMany ? `${a2}.${ident(c)} = ${alias}.${ident(fk.parent_cols[i])}` : `${a2}.${ident(fk.parent_cols[i])} = ${alias}.${ident(c)}`).join(' and ');
    const sub = oneToMany
      ? `(select coalesce(jsonb_agg(${inner}), '[]'::jsonb) from public.${ident(e.table)} ${a2} where ${join})`
      : `(select ${inner} from public.${ident(e.table)} ${a2} where ${join})`;
    base = `${base} || jsonb_build_object('${e.alias}', ${sub})`;
  }
  return base;
}
function parseList(v) {
  return splitTop(v.replace(/^\(|\)$/g, '')).map((x) => x.replace(/^"|"$/g, ''));
}
function condition(t, col, expr, params, alias = 't0') {
  if (!(col in t)) throw new Error(`column ${col} does not exist`);
  let neg = false;
  let rest = expr;
  if (rest.startsWith('not.')) { neg = true; rest = rest.slice(4); }
  const dot = rest.indexOf('.');
  const op = rest.slice(0, dot);
  const val = rest.slice(dot + 1);
  const c = `${alias}.${ident(col)}`;
  let sql;
  if (op === 'is') sql = `${c} is ${val === 'null' ? 'null' : val === 'true' ? 'true' : 'false'}`;
  else if (op === 'in') { params.push(arrayLiteral(parseList(val))); sql = `${c} = any($${params.length}::${t[col]}[])`; }
  else {
    const ops = { eq: '=', neq: '<>', lt: '<', lte: '<=', gt: '>', gte: '>=', like: 'like', ilike: 'ilike' };
    if (!ops[op]) throw new Error(`operator ${op} not supported`);
    params.push(op.includes('like') ? val.replace(/\*/g, '%') : val);
    sql = `${c} ${ops[op]} $${params.length}::${op.includes('like') ? 'text' : t[col]}`;
  }
  return neg ? `not (${sql})` : sql;
}
async function readTable(table, query, claims, headers) {
  try {
    const t = await types(table);
    const params = [];
    const where = [];
    let order = '';
    let limit = '';
    for (const [k, v] of query) {
      if (k === 'select' || k === 'offset') continue;
      if (k === 'order') {
        order = 'order by ' + v.split(',').map((o) => { const [col, dir, nulls] = o.split('.'); if (!(col in t)) throw new Error(`column ${col}`); return `t0.${ident(col)} ${dir === 'desc' ? 'desc' : 'asc'}${nulls === 'nullsfirst' ? ' nulls first' : nulls === 'nullslast' ? ' nulls last' : ''}`; }).join(', ');
      } else if (k === 'limit') limit = `limit ${Number(v)}`;
      else if (k === 'or') {
        where.push(`(${splitTop(v.replace(/^\(|\)$/g, '')).map((p) => { const i = p.indexOf('.'); return condition(t, p.slice(0, i), p.slice(i + 1), params); }).join(' or ')})`);
      } else where.push(condition(t, k, v, params));
    }
    const expr = await selectExpr(table, 't0', parseSelect(query.get('select')), params);
    const sql = `select ${expr} as j from public.${ident(table)} t0 ${where.length ? 'where ' + where.join(' and ') : ''} ${order} ${limit}`;
    const r = await asUser(claims, headers, (tx) => tx.query(sql, params));
    return [200, r.rows.map((x) => x.j)];
  } catch (e) {
    return e.code ? pgError(e) : [400, { code: 'PGRST100', message: e.message, details: null, hint: null }];
  }
}

// ---------- Storage ----------
function parseMultipart(buf, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType ?? '')?.[1];
  if (!boundary) return buf;
  const sep = Buffer.from(`--${boundary}`);
  let start = buf.indexOf(sep);
  while (start >= 0) {
    const next = buf.indexOf(sep, start + sep.length);
    if (next < 0) break;
    const part = buf.subarray(start + sep.length + 2, next - 2);
    const headEnd = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, headEnd).toString();
    if (/filename=|name=""/.test(head) || /Content-Type/i.test(head)) return part.subarray(headEnd + 4);
    start = next;
  }
  return buf;
}
const signToken = (path, exp) => createHmac('sha256', SECRET).update(`${path}:${exp}`).digest('base64url');

// ---------- HTTP ----------
function send(res, status, body, extra = {}) {
  const data = body === undefined ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extra });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', req.headers.origin ?? '*');
  res.setHeader('access-control-allow-headers', 'authorization, apikey, content-type, x-client-info, x-request-id, prefer, accept-profile, content-profile, x-upsert, range, x-supabase-api-version');
  res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS, HEAD');
  res.setHeader('access-control-expose-headers', 'content-range, x-supabase-api-version');
  if (req.method === 'OPTIONS') return send(res, 204);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks);
  const json = () => { try { return raw.length ? JSON.parse(raw.toString()) : {}; } catch { return {}; } };
  const claims = verify((req.headers.authorization ?? '').replace(/^Bearer /i, ''));
  const headers = { 'x-request-id': req.headers['x-request-id'] ?? null };
  const p = url.pathname;
  try {
    // Auth
    if (p === '/auth/v1/token' && req.method === 'POST') {
      const body = json();
      if (url.searchParams.get('grant_type') === 'password') {
        const r = await db.query('select user_id, password from local_dev.password where lower(email) = lower($1)', [body.email ?? '']);
        if (!r.rows[0] || r.rows[0].password !== body.password) return send(res, 400, { code: 400, error_code: 'invalid_credentials', msg: 'Invalid login credentials' });
        return send(res, 200, await session(r.rows[0].user_id, body.email));
      }
      if (url.searchParams.get('grant_type') === 'refresh_token') {
        const c = verify(body.refresh_token);
        if (!c || c.typ !== 'refresh') return send(res, 400, { code: 400, error_code: 'refresh_token_not_found', msg: 'Invalid Refresh Token' });
        return send(res, 200, await session(c.sub, c.email));
      }
    }
    if (p === '/auth/v1/user' && req.method === 'GET') {
      if (!claims) return send(res, 401, { code: 401, msg: 'invalid JWT' });
      return send(res, 200, { id: claims.sub, aud: 'authenticated', role: 'authenticated', email: claims.email, app_metadata: {}, user_metadata: {} });
    }
    if (p === '/auth/v1/logout') return send(res, 204);
    if (p.startsWith('/auth/v1/signup')) return send(res, 422, { code: 422, error_code: 'signup_disabled', msg: 'Signups not allowed for this instance' });

    // PostgREST
    if (p.startsWith('/rest/v1/rpc/') && req.method === 'POST') {
      const [status, body] = await rpc(p.slice('/rest/v1/rpc/'.length), json(), claims, headers);
      return send(res, status, body);
    }
    if (p.startsWith('/rest/v1/') && req.method === 'GET') {
      const [status, body] = await readTable(p.slice('/rest/v1/'.length), url.searchParams, claims, headers);
      return send(res, status, body);
    }
    if (p.startsWith('/rest/v1/')) return send(res, 403, { code: '42501', message: 'permission denied (клиент пишет только через команды)', details: null, hint: null });

    // Storage
    const up = /^\/storage\/v1\/object\/private-files\/(.+)$/.exec(p);
    if (up && req.method === 'POST' && !p.includes('/sign/')) {
      const name = decodeURIComponent(up[1]);
      try {
        await asUser(claims, headers, (tx) => tx.query(`insert into storage.objects(bucket_id, name, owner) values ('private-files', $1, auth.uid())`, [name]));
      } catch (e) {
        return send(res, 403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
      }
      const file = join(FILES, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, parseMultipart(raw, req.headers['content-type']));
      return send(res, 200, { Key: `private-files/${name}`, Id: randomUUID() });
    }
    const sg = /^\/storage\/v1\/object\/sign\/private-files\/(.+)$/.exec(p);
    if (sg && req.method === 'POST') {
      const name = decodeURIComponent(sg[1]);
      const r = await asUser(claims, headers, (tx) => tx.query(`select 1 from storage.objects where bucket_id = 'private-files' and name = $1`, [name]));
      if (!r.rows.length) return send(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      const exp = Math.floor(Date.now() / 1000) + Number(json().expiresIn ?? 60);
      return send(res, 200, { signedURL: `/object/sign/private-files/${encodeURIComponent(name).replace(/%2F/g, '/')}?token=${signToken(name, exp)}&exp=${exp}` });
    }
    if (sg && req.method === 'GET') {
      const name = decodeURIComponent(sg[1]);
      const exp = Number(url.searchParams.get('exp'));
      if (exp < Date.now() / 1000 || url.searchParams.get('token') !== signToken(name, exp)) return send(res, 400, { message: 'Invalid or expired signature' });
      const file = join(FILES, name);
      if (!existsSync(file)) return send(res, 404, { message: 'not found' });
      return send(res, 200, readFileSync(file), { 'content-type': 'application/octet-stream' });
    }
    return send(res, 404, { message: `Not found: ${req.method} ${p}` });
  } catch (e) {
    console.error(e);
    return send(res, 500, { code: 'PGRST500', message: e.message, details: null, hint: null });
  }
});

server.listen(PORT, () => {
  console.log(`Локальный бэкенд разработки: http://localhost:${PORT}  (НЕ демо-стенд и не production)`);
  console.log('Клиент: VITE_SUPABASE_URL=http://localhost:' + PORT + ' VITE_SUPABASE_PUBLISHABLE_KEY=local-dev-publishable-key-0000 npm run dev');
});

// Фоновая обработка выполняется сервером, как pg_cron в Supabase (ADR-0005)
setInterval(() => { db.query(`select app_private.run_jobs('cron')`).catch((e) => console.error('jobs:', e.message)); }, 5 * 60_000);
