const ID = /^[A-Za-z0-9_-]{20,100}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERMISSION_ID = /^[A-Za-z0-9_-]{1,160}$/;
const OWNER = 'bron-finance-export';
const TYPES = {
  plan: 'План', revenue: 'Выручка', day_off: 'Выходной', payroll: 'Зарплата',
  expense: 'Расход', royalty: 'Роялти по ставке', royalty_adjustment: 'Корректировка роялти',
  royalty_payment: 'Оплата роялти', royalty_past_debt: 'Прошлый долг по роялти', return: 'Возврат покупателю',
};

export function validateReportBooks(books) {
  if (!Array.isArray(books) || books.length === 0 || books.length > 100) throw new Error('Invalid report destinations');
  const ids = new Set();
  const scopes = new Set();
  for (const book of books) {
    if (!book || typeof book.spreadsheetId !== 'string' || !ID.test(book.spreadsheetId)
      || (book.partnerId !== undefined && (typeof book.partnerId !== 'string' || !UUID.test(book.partnerId)))) {
      throw new Error('Invalid report destination');
    }
    if (!Array.isArray(book.permissions) || !book.permissions.length || book.permissions.length > 100
      || book.permissions.some(p => !p || typeof p.id !== 'string' || !PERMISSION_ID.test(p.id)
        || !['owner', 'writer', 'reader', 'commenter'].includes(p.role))
      || new Set(book.permissions.map(p => p.id)).size !== book.permissions.length
      || !book.permissions.some(p => p.role === 'owner')) throw new Error('Invalid report recipients');
    const scope = book.partnerId?.toLowerCase() ?? 'internal';
    if (ids.has(book.spreadsheetId) || scopes.has(scope)) throw new Error('Duplicate report destination');
    ids.add(book.spreadsheetId);
    scopes.add(scope);
  }
}

export function checkReportPermissions(allowed, actual) {
  const expected = new Map(allowed.map(permission => [permission.id, permission.role]));
  if (!Array.isArray(actual) || actual.length !== expected.size || actual.some(permission => {
    if (permission?.type !== 'user' || expected.get(permission.id) !== permission.role) return true;
    expected.delete(permission.id);
    return false;
  }) || expected.size) throw new Error('Report workbook recipients do not match the approved list');
}

function amountCell(amount, units) {
  if (amount == null) return null;
  if (amount < -999999999999999n || amount > 999999999999999n) {
    throw new Error('Amount exceeds Google Sheets precision');
  }
  return Number(amount) / 10 ** units;
}

function reportMonth(month) {
  return month === null ? 'Без периода' : month.slice(0, 7);
}

function monthRows(records) {
  const groups = new Map();
  for (const row of records) {
    const period = reportMonth(row.month);
    const key = [period, row.partner_id, row.currency].join('|');
    if (!groups.has(key)) groups.set(key, { period, row, totals: new Map(), pendingPayroll: false });
    const group = groups.get(key);
    const { totals } = group;
    if (row.kind === 'payroll' && row.category) group.pendingPayroll = true;
    if (row.amount != null) totals.set(row.kind, (totals.get(row.kind) ?? 0n) + BigInt(row.amount));
  }
  return [...groups.values()].map(({ period, row, totals, pendingPayroll }) => {
    const amount = (key) => amountCell(totals.get(key), row.minor_unit);
    const sum = (key) => totals.get(key) ?? 0n;
    const net = totals.has('revenue') ? sum('revenue') - sum('return') - sum('payroll') - sum('expense') - sum('royalty') : null;
    return [period, row.partner, row.currency, amount('plan'), amount('revenue'), amount('payroll'),
      amount('expense'), amount('royalty'), amount('royalty_adjustment'), amount('royalty_payment'), amountCell(net, row.minor_unit),
      amount('return'), amount('royalty_past_debt'), pendingPayroll ? 'Зарплата рассчитана частично' : null];
  });
}

export function buildGoogleReports(books, records, observedAt) {
  validateReportBooks(books);
  const keys = new Set();
  for (const row of records) {
    if (!Object.hasOwn(TYPES, row.kind) || keys.has(row.key) || !/^[A-Z]{3}$/.test(row.currency)
      || !Number.isInteger(row.minor_unit) || row.minor_unit < 0 || row.minor_unit > 4) {
      throw new Error('Invalid financial snapshot');
    }
    keys.add(row.key);
  }
  return books.map((book) => {
    const partnerId = book.partnerId?.toLowerCase();
    const recordsForBook = partnerId ? records.filter(row => row.partner_id === partnerId) : records;
    const scope = partnerId ? `partner:${partnerId}` : 'internal';
    return {
      spreadsheetId: book.spreadsheetId,
      permissions: book.permissions,
      sheets: [{
        title: 'Кабинет — сводка', owner: `summary:${scope}`, headers: 3,
        rows: [
          ['Обновлено из кабинета', observedAt],
          ['Периоды календарные. Остаток рассчитан по внесённым данным. Оплаты показаны отдельно.'],
          ['Месяц', 'Партнёр', 'Валюта', 'Планы по внесённым точкам', 'Выручка', 'Зарплата', 'Прочие расходы', 'Роялти по ставке',
            'Корректировки роялти', 'Оплаты роялти по месяцу начисления', 'Остаток по внесённым данным', 'Возвраты покупателям', 'Прошлый долг по роялти', 'Статус расчёта'],
          ...monthRows(recordsForBook),
        ],
      }, {
        title: 'Кабинет — операции', owner: `entries:${scope}`, headers: 1,
        rows: [
          ['Месяц начисления', 'Дата операции', 'Партнёр', 'Точка', 'Валюта', 'Тип', 'Статья', 'Сумма', 'Наличные', 'Карта', 'ID записи'],
          ...recordsForBook.map(row => [
            reportMonth(row.month), row.day, row.partner, row.point, row.currency, TYPES[row.kind], row.category,
            amountCell(row.amount == null ? null : BigInt(row.amount), row.minor_unit),
            amountCell(row.cash == null ? null : BigInt(row.cash), row.minor_unit),
            amountCell(row.card == null ? null : BigInt(row.card), row.minor_unit), row.key,
          ]),
        ],
      }],
    };
  });
}

function enteredValue(value) {
  if (value == null) return {};
  return { userEnteredValue: typeof value === 'number' ? { numberValue: value } : { stringValue: value } };
}

export function reportSheetRequests(report, existing) {
  const requests = [];
  let nextId = Math.max(0, ...existing.map(sheet => sheet.properties.sheetId)) + 1;
  const owned = existing.filter(item => item.developerMetadata?.some(entry => entry.metadataKey === OWNER));
  const allowed = new Set(report.sheets.map(sheet => sheet.owner));
  if (owned.some(item => item.developerMetadata.some(entry => entry.metadataKey === OWNER && !allowed.has(entry.metadataValue)))) {
    throw new Error('Report workbook belongs to a different scope');
  }
  for (const sheet of report.sheets) {
    const width = sheet.rows.reduce((largest, row) => Math.max(largest, row.length), 0);
    const matches = owned.filter(item => item.developerMetadata.some(entry => entry.metadataKey === OWNER && entry.metadataValue === sheet.owner));
    const named = existing.find(item => item.properties.title === sheet.title);
    if (matches.length > 1 || (named && named !== matches[0]) || (matches[0] && named !== matches[0])) {
      throw new Error('Report sheet ownership or title does not match configuration');
    }
    const current = matches[0]?.properties;
    const sheetId = current?.sheetId ?? nextId++;
    const rowCount = Math.max(current?.gridProperties?.rowCount ?? 100, sheet.rows.length);
    const columnCount = Math.max(current?.gridProperties?.columnCount ?? 0, width);
    const gridProperties = { rowCount, columnCount, frozenRowCount: sheet.headers };
    if (!current) {
      requests.push({ addSheet: { properties: { sheetId, title: sheet.title, gridProperties } } });
      requests.push({ createDeveloperMetadata: { developerMetadata: {
        metadataKey: OWNER, metadataValue: sheet.owner, visibility: 'DOCUMENT', location: { sheetId },
      } } });
    } else if (rowCount > current.gridProperties.rowCount || columnCount > current.gridProperties.columnCount) {
      requests.push({ updateSheetProperties: { properties: { sheetId, gridProperties }, fields: 'gridProperties' } });
    }
    requests.push({ updateCells: {
      range: { sheetId, startRowIndex: 0, endRowIndex: rowCount, startColumnIndex: 0, endColumnIndex: width },
      rows: sheet.rows.map(row => ({ values: row.map(enteredValue) })), fields: 'userEnteredValue',
    } });
  }
  return requests;
}
