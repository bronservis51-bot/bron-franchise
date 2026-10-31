export function normalizeProfitRows(rows) {
  const seen = new Set();
  return rows.map(r => {
    const href = r.counterparty?.meta?.href ?? '';
    const match = /^https:\/\/api\.moysklad\.ru\/api\/remap\/1\.2\/entity\/counterparty\/([a-f0-9-]{36})$/.exec(href);
    if (!match || seen.has(match[1]) || !r.counterparty?.name) throw new Error('Invalid or duplicate counterparty');
    seen.add(match[1]);
    for (const key of ['sellSum', 'sellCostSum', 'returnSum', 'returnCostSum', 'profit']) {
      if (!Number.isSafeInteger(r[key])) throw new Error(`Invalid amount: ${key}`);
    }
    const sales_minor = r.sellSum-r.returnSum, cost_minor = r.sellCostSum-r.returnCostSum;
    if (Math.abs(sales_minor-cost_minor-r.profit)>1) throw new Error('Profit does not reconcile');
    return { counterparty_id:match[1], name:r.counterparty.name, sales_minor, cost_minor, profit_minor:r.profit };
  });
}
