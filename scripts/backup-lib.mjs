// Логический экспорт и восстановление бизнес-данных (COST-13, OPS-06, AT-15).
// Работает с любым клиентом с методом query(sql, params) → { rows } (node-postgres или PGlite).
// Пользователи переносятся по email: в новой установке их создают заново (seed-users / консоль), id сопоставляются.

/** Таблицы public в порядке зависимостей (циклические ссылки восстанавливаются вторым проходом). */
async function tablesInOrder(db) {
  const tables = (await db.query(`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r' order by c.relname`)).rows.map((r) => r.name);
  const fks = (await db.query(`select replace(c.conrelid::regclass::text, 'public.', '') as child, replace(c.confrelid::regclass::text, 'public.', '') as parent,
      bool_and(not a.attnotnull) as nullable
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.contype = 'f' and n.nspname = 'public' group by 1, 2, c.oid`)).rows;
  const order = [];
  const left = new Set(tables);
  const pending = (t, onlyRequired) => fks.filter((f) => f.child === t && f.parent !== t && left.has(f.parent) && (!onlyRequired || !f.nullable));
  while (left.size) {
    let progressed = false;
    for (const t of [...left]) {
      if (!pending(t, false).length) { order.push(t); left.delete(t); progressed = true; }
    }
    if (!progressed) {
      // Цикл: берём таблицу, у которой незакрытые ссылки только необязательные (восстанавливаются вторым проходом)
      const t = [...left].find((x) => !pending(x, true).length) ?? [...left][0];
      order.push(t);
      left.delete(t);
    }
  }
  return order;
}

async function columns(db, table) {
  return (await db.query(`select a.attname as name, format_type(a.atttypid, a.atttypmod) as type, a.attgenerated <> '' as generated,
      a.attidentity <> '' as identity
    from pg_attribute a where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`, [`public.${table}`])).rows;
}

export async function exportData(db) {
  const tables = await tablesInOrder(db);
  const data = {};
  for (const t of tables) {
    data[t] = (await db.query(`select coalesce(jsonb_agg(to_jsonb(x)), '[]'::jsonb) as rows from public.${JSON.stringify(t)} x`)).rows[0].rows;
  }
  const users = (await db.query(`select u.id, u.email, u.full_name, u.locale, u.status, u.is_demo from public.app_user u order by u.email`)).rows;
  const migrations = await db.query(`select coalesce(jsonb_agg(name order by name), '[]'::jsonb) as m from app_private.schema_migration`).catch(() => ({ rows: [{ m: [] }] }));
  return { format: 'bron-backup', version: 1, exported_at: new Date().toISOString(), migrations: migrations.rows[0].m, users, tables: data };
}

/**
 * Восстановление в установку с применёнными миграциями и созданными пользователями (по email).
 * Справочники миграций (роли, валюты…) не дублируются: строки с существующим первичным ключом пропускаются.
 */
export async function restoreData(db, dump, { log = () => {}, wipe = false } = {}) {
  if (dump.format !== 'bron-backup') throw new Error('Неизвестный формат резервной копии');
  if (!wipe) throw new Error('Восстановление заменяет бизнес-данные целевой установки: передайте wipe: true (CLI: --confirm-wipe)');
  const current = new Map((await db.query('select id, email from public.app_user')).rows.map((r) => [r.email, r.id]));
  const userMap = new Map();
  const missing = [];
  for (const u of dump.users) {
    if (current.has(u.email)) userMap.set(u.id, current.get(u.email));
    else missing.push(u.email);
  }
  if (missing.length) throw new Error(`В целевой установке нет пользователей: ${missing.join(', ')}. Создайте их (npm run seed:users) и повторите.`);

  const userCols = (await db.query(`select replace(c.conrelid::regclass::text, 'public.', '') as tbl, a.attname as col
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
    where c.contype = 'f' and c.confrelid in ('public.app_user'::regclass, 'auth.users'::regclass)`)).rows;
  const isUserCol = (t, c) => userCols.some((x) => x.tbl === t && x.col === c);
  const pk = async (t) => (await db.query(`select a.attname from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
    where i.indrelid = $1::regclass and i.indisprimary`, [`public.${t}`])).rows.map((r) => r.attname);
  const fkCols = (await db.query(`select replace(conrelid::regclass::text, 'public.', '') as child, replace(confrelid::regclass::text, 'public.', '') as parent, a.attname as col
    from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey) join pg_namespace n on n.oid = c.connamespace
    where c.contype = 'f' and n.nspname = 'public'`)).rows;

  const order = await tablesInOrder(db);
  // Целевая установка очищается (кроме профилей пользователей, созданных заново): справочники тоже берутся из копии
  const wipeList = order.filter((t) => t !== 'app_user').map((t) => `public.${JSON.stringify(t)}`).join(', ');
  await db.query(`truncate table ${wipeList} restart identity`);
  // Ссылка откладывается, если указывает на эту же или ещё не восстановленную таблицу (цикл)
  const later = (t, col) => fkCols.some((f) => f.child === t && f.col === col && (f.parent === t || order.indexOf(f.parent) > order.indexOf(t)));
  const deferred = [];
  const inserted = {};
  for (const t of order) {
    const rows = dump.tables[t] ?? [];
    if (t === 'app_user' || !rows.length) continue; // пользователи уже созданы в целевой установке
    const cols = (await columns(db, t)).filter((c) => !c.generated);
    const keys = await pk(t);
    const identity = cols.some((c) => c.identity);
    await db.query(`alter table public.${JSON.stringify(t)} disable trigger user`);
    let n = 0;
    for (const row of rows) {
      const values = cols.map((c) => {
        let v = row[c.name];
        if (v !== null && v !== undefined && isUserCol(t, c.name)) v = userMap.get(v) ?? null;
        // ссылки на ещё не восстановленные строки (циклы) — вторым проходом
        if (v !== null && v !== undefined && later(t, c.name) && !isUserCol(t, c.name)) {
          deferred.push({ t, keys, row, col: c.name, value: v });
          return null;
        }
        if (Array.isArray(v) && c.type.endsWith('[]')) return `{${v.map((x) => (x === null ? 'NULL' : `"${String(x).replace(/["\\]/g, '\\$&')}"`)).join(',')}}`;
        if (v !== null && typeof v === 'object') return JSON.stringify(v);
        return v ?? null;
      });
      const sql = `insert into public.${JSON.stringify(t)} (${cols.map((c) => JSON.stringify(c.name)).join(', ')})
        ${identity ? 'overriding system value' : ''} values (${cols.map((c, i) => `$${i + 1}::${c.type}`).join(', ')})
        ${keys.length ? `on conflict (${keys.map((k) => JSON.stringify(k)).join(', ')}) do nothing` : ''}`;
      const r = await db.query(sql, values);
      n += r.affectedRows ?? r.rowCount ?? 0;
    }
    await db.query(`alter table public.${JSON.stringify(t)} enable trigger user`);
    inserted[t] = n;
    log(`  ${t}: ${n}/${rows.length}`);
  }
  // второй проход: восстановить отложенные ссылки
  for (const d of deferred) {
    await db.query(`alter table public.${JSON.stringify(d.t)} disable trigger user`);
    await db.query(`update public.${JSON.stringify(d.t)} set ${JSON.stringify(d.col)} = $1 where ${d.keys.map((k, i) => `${JSON.stringify(k)}::text = $${i + 2}`).join(' and ')}`,
      [d.value, ...d.keys.map((k) => String(d.row[k]))]);
    await db.query(`alter table public.${JSON.stringify(d.t)} enable trigger user`);
  }
  // идентификационные последовательности — после максимальных значений
  for (const t of order) {
    for (const c of (await columns(db, t)).filter((x) => x.identity)) {
      await db.query(`select setval(pg_get_serial_sequence('public.${t}', '${c.name}'), greatest((select max(${JSON.stringify(c.name)}) from public.${JSON.stringify(t)}), 1))`);
    }
  }
  return inserted;
}
