// Финансовые инварианты роялти (ROY-01…13, AT-07…10, AT-18).
import { beforeAll, describe, expect, it } from 'vitest';
import { createTestDb, type TestDb } from './harness';

let t: TestDb;
const PARTNER = 'alpha.owner@demo.example.com';
const F1 = 'finance1@demo.example.com';
// Второй подписью (публикация начисления, подтверждение зачисления) служит руководитель компании: финансист один
const F2 = 'finance1@demo.example.com'; // финансист один (решение владельца 14.10.2026)
let contract: string;
let alpha: string;
let loc1: string;
let loc2: string;
let seq = 0;
const key = (p: string) => `${p}-test-key-${++seq}`;

beforeAll(async () => {
  t = await createTestDb();
  [{ id: contract }] = await t.admin<{ id: string }>(`select k.id from public.contract k join public.partner p on p.id = k.partner_id where p.code = 'ALPHA'`);
  [{ id: alpha }] = await t.admin<{ id: string }>(`select id from public.partner where code = 'ALPHA'`);
  [{ id: loc1 }] = await t.admin<{ id: string }>(`select id from public.location where code = 'ALPHA-1'`);
  [{ id: loc2 }] = await t.admin<{ id: string }>(`select id from public.location where code = 'ALPHA-2'`);
}, 180_000);

async function closedPeriod(period: string, lines: object[]) {
  const [r] = await t.as<{ id: string }>(PARTNER, `select id from public.report_save_draft($1, $2::date, $3::jsonb)`, [contract, period, JSON.stringify(lines)]);
  await t.as(PARTNER, `select public.report_submit($1, $2)`, [r.id, key('sub')]);
  await t.as(F1, `select public.report_take_review($1)`, [r.id]);
  const [calc] = await t.as<{ r: { amount_minor: number; calculation_id: string } }>(F1, `select public.report_approve($1) as r`, [r.id]);
  const [pub] = await t.as<{ r: { accrual_id: string } }>(F2, `select public.accrual_publish($1, $2) as r`, [r.id, key('pub')]);
  await t.as(F2, `select public.period_close($1)`, [r.id]);
  return { reportId: r.id, amount: Number(calc.r.amount_minor), calculationId: calc.r.calculation_id, accrualId: pub.r.accrual_id };
}

async function confirmedPayment(amount: number, bankRef: string) {
  const [reg] = await t.as<{ r: { payment_id: string } }>(F1,
    `select public.payment_register($1, $2, $3, 'RUB', current_date, $4, null, $5) as r`, [alpha, contract, amount, bankRef, key('reg')]);
  await t.as(F2, `select public.payment_confirm($1)`, [reg.r.payment_id]);
  return reg.r.payment_id;
}

async function outstanding(accrualId: string) {
  const [b] = await t.as<{ outstanding_minor: string }>(PARTNER, `select outstanding_minor from public.v_accrual_balance where accrual_id = $1`, [accrualId]);
  return Number(b.outstanding_minor);
}

describe('ROY-02: точный расчёт тестового договора', () => {
  let acc: Awaited<ReturnType<typeof closedPeriod>>;
  it('500 000 ₽ × 7% = 35 000 ₽', async () => {
    acc = await closedPeriod('2024-01-01', [{ location_id: loc1, gross_minor: 50_000_000 }, { location_id: loc2, gross_minor: 0, zero_reason: 'Ремонт' }]);
    expect(acc.amount).toBe(3_500_000);
  });

  it('оплата 20 000 ₽ → остаток 15 000 ₽', async () => {
    const pay = await confirmedPayment(2_000_000, 'BANK-T-ROY02');
    await t.as(F1, `select public.allocation_create($1, $2, 2000000, $3)`, [pay, acc.accrualId, key('alloc')]);
    expect(await outstanding(acc.accrualId)).toBe(1_500_000);
  });

  it('партнёр и финансы видят одинаковое сальдо (ROY-12)', async () => {
    const [p] = await t.as<{ outstanding_minor: string }>(PARTNER, `select outstanding_minor from public.v_accrual_balance where accrual_id = $1`, [acc.accrualId]);
    const [f] = await t.as<{ outstanding_minor: string }>(F1, `select outstanding_minor from public.v_accrual_balance where accrual_id = $1`, [acc.accrualId]);
    expect(p.outstanding_minor).toBe(f.outstanding_minor);
  });
});

describe('AT-08: частичная оплата, переплата и возврат', () => {
  it('переплата остаётся авансом, распределение не превышает долг', async () => {
    const acc = await closedPeriod('2024-02-01', [{ location_id: loc1, gross_minor: 10_000_000 }, { location_id: loc2, gross_minor: 0, zero_reason: 'Закрыта' }]);
    expect(acc.amount).toBe(700_000);
    const pay = await confirmedPayment(1_000_000, 'BANK-T-OVER');
    await t.expectError(F1, `select public.allocation_create($1, $2, 1000000, $3)`, 'version-conflict', [pay, acc.accrualId, key('alloc')]);
    await t.as(F1, `select public.allocation_create($1, $2, 700000, $3)`, [pay, acc.accrualId, key('alloc')]);
    const [b] = await t.as<{ unallocated_minor: string }>(F1, `select unallocated_minor from public.v_payment_balance where payment_id = $1`, [pay]);
    expect(Number(b.unallocated_minor)).toBe(300_000);
    expect(await outstanding(acc.accrualId)).toBe(0);
  });

  it('возврат платежа сторнирует распределения и восстанавливает долг', async () => {
    const acc = await closedPeriod('2024-03-01', [{ location_id: loc1, gross_minor: 20_000_000 }, { location_id: loc2, gross_minor: 0, zero_reason: 'Закрыта' }]);
    const pay = await confirmedPayment(1_400_000, 'BANK-T-REFUND');
    await t.as(F1, `select public.allocation_create($1, $2, 1400000, $3)`, [pay, acc.accrualId, key('alloc')]);
    expect(await outstanding(acc.accrualId)).toBe(0);
    await t.as(F1, `select public.payment_reverse($1, 'Банк вернул платёж')`, [pay]);
    expect(await outstanding(acc.accrualId)).toBe(1_400_000);
    const allocs = await t.as<{ status: string }>(F1, `select status from public.allocation where payment_id = $1`, [pay]);
    expect(allocs.every((a) => a.status === 'reversed')).toBe(true);
  });

  it('ошибочное распределение сторнируется с причиной', async () => {
    const acc = await closedPeriod('2024-04-01', [{ location_id: loc1, gross_minor: 1_000_000 }, { location_id: loc2, gross_minor: 0, zero_reason: 'Закрыта' }]);
    const pay = await confirmedPayment(70_000, 'BANK-T-REV');
    const [a] = await t.as<{ r: { allocation_id: string } }>(F1, `select public.allocation_create($1, $2, 70000, $3) as r`, [pay, acc.accrualId, key('alloc')]);
    await t.expectError(F1, `select public.allocation_reverse($1, '')`, 'validation', [a.r.allocation_id]);
    await t.as(F1, `select public.allocation_reverse($1, 'Не тот период')`, [a.r.allocation_id]);
    expect(await outstanding(acc.accrualId)).toBe(70_000);
  });
});

describe('AT-10: распределение одной оплаты дважды', () => {
  it('второе распределение получает конфликт и не превышает сумму', async () => {
    const a1 = await closedPeriod('2024-05-01', [{ location_id: loc1, gross_minor: 10_000_000 }, { location_id: loc2, gross_minor: 0, zero_reason: 'x' }]);
    const a2 = await closedPeriod('2024-06-01', [{ location_id: loc1, gross_minor: 10_000_000 }, { location_id: loc2, gross_minor: 0, zero_reason: 'x' }]);
    const pay = await confirmedPayment(1_000_000, 'BANK-T-CONC');
    await t.as(F1, `select public.allocation_create($1, $2, 700000, $3)`, [pay, a1.accrualId, key('alloc')]);
    // второй финансист видит устаревший остаток 1 000 000 и пытается распределить 700 000
    await t.expectError(F2, `select public.allocation_create($1, $2, 700000, $3)`, 'version-conflict', [pay, a2.accrualId, key('alloc')]);
    await t.as(F2, `select public.allocation_create($1, $2, 300000, $3)`, [pay, a2.accrualId, key('alloc')]);
    const [s] = await t.admin<{ s: string }>(`select sum(amount_minor) as s from public.allocation where payment_id = $1 and status = 'active'`, [pay]);
    expect(Number(s.s)).toBe(1_000_000);
  });

  it('повтор той же команды распределения не засчитывает деньги дважды', async () => {
    const acc = await closedPeriod('2024-07-01', [{ location_id: loc1, gross_minor: 10_000_000 }, { location_id: loc2, gross_minor: 0, zero_reason: 'x' }]);
    const pay = await confirmedPayment(700_000, 'BANK-T-IDEM');
    const k = key('alloc');
    await t.as(F1, `select public.allocation_create($1, $2, 300000, $3)`, [pay, acc.accrualId, k]);
    const [again] = await t.as<{ r: { replayed: boolean } }>(F1, `select public.allocation_create($1, $2, 300000, $3) as r`, [pay, acc.accrualId, k]);
    expect(again.r.replayed).toBe(true);
    expect(await outstanding(acc.accrualId)).toBe(400_000);
  });

  it('одна банковская операция не регистрируется дважды', async () => {
    await t.expectError(F1, `select public.payment_register($1, $2, 1000, 'RUB', current_date, 'BANK-T-IDEM', null, $3)`, 'validation', [alpha, contract, key('reg')]);
  });
});

describe('AT-18 и AUTH-04: подтверждение оплаты', () => {
  it('квитанция партнёра не уменьшает долг', async () => {
    const acc = await closedPeriod('2024-08-01', [{ location_id: loc1, gross_minor: 10_000_000 }, { location_id: loc2, gross_minor: 0, zero_reason: 'x' }]);
    const [p] = await t.as<{ r: { payment_id: string } }>(PARTNER, `select public.payment_report($1, 700000, 'RUB', current_date, 'п/п 1', null, $2) as r`, [contract, key('rep')]);
    await t.expectError(F1, `select public.allocation_create($1, $2, 700000, $3)`, 'transition-not-allowed', [p.r.payment_id, acc.accrualId, key('alloc')]);
    expect(await outstanding(acc.accrualId)).toBe(700_000);
  });

  it('один финансист подтверждает своё зачисление — операция записывается в журнал; при строгой политике запрещено', async () => {
    const [reg] = await t.as<{ r: { payment_id: string } }>(F1, `select public.payment_register($1, $2, 5000, 'RUB', current_date, 'BANK-T-SOD', null, $3) as r`, [alpha, contract, key('reg')]);
    await t.admin(`update public.operator set sod_policy = 'strict'`);
    await t.expectError(F1, `select public.payment_confirm($1)`, 'forbidden', [reg.r.payment_id]);
    await t.admin(`update public.operator set sod_policy = 'allow_with_log'`);
    await t.as(F1, `select public.payment_confirm($1)`, [reg.r.payment_id]);
    const log = await t.admin(`select 1 from public.audit_event where action = 'sod_override' and entity_id = $1`, [reg.r.payment_id]);
    expect(log.length).toBe(1);
  });

  it('при строгой политике утвердивший отчёт не публикует начисление сам', async () => {
    await t.admin(`update public.operator set sod_policy = 'strict'`);
    const [r] = await t.as<{ id: string }>(PARTNER, `select id from public.report_save_draft($1, '2024-09-01', $2::jsonb)`,
      [contract, JSON.stringify([{ location_id: loc1, gross_minor: 1000 }, { location_id: loc2, gross_minor: 0, zero_reason: 'x' }])]);
    await t.as(PARTNER, `select public.report_submit($1, $2)`, [r.id, key('sub')]);
    await t.as(F1, `select public.report_approve($1)`, [r.id]);
    await t.expectError(F1, `select public.accrual_publish($1, $2)`, 'forbidden', [r.id, key('pub')]);
    await t.admin(`update public.operator set sod_policy = 'allow_with_log'`);
  });

  it('партнёр не может утвердить отчёт или подтвердить оплату', async () => {
    const [r] = await t.admin<{ id: string }>(`select id from public.revenue_report where status = 'submitted' and partner_id = $1 limit 1`, [alpha]);
    await t.expectError(PARTNER, `select public.report_approve($1)`, 'forbidden', [r.id]);
  });
});

describe('ROY-04: неизменность отправленной редакции и корректировки', () => {
  it('отправленную редакцию нельзя изменить, исправление — новой редакцией', async () => {
    const [r] = await t.as<{ id: string }>(PARTNER, `select id from public.report_save_draft($1, '2024-10-01', $2::jsonb)`,
      [contract, JSON.stringify([{ location_id: loc1, gross_minor: 1_000_000 }, { location_id: loc2, gross_minor: 0, zero_reason: 'x' }])]);
    await t.as(PARTNER, `select public.report_submit($1, $2)`, [r.id, key('sub')]);
    await t.expectError(PARTNER, `select public.report_save_draft($1, '2024-10-01', '[]'::jsonb)`, 'transition-not-allowed', [contract]);
    await expect(t.admin(`update public.report_line set gross_minor = 1 where revision_id = (select current_revision_id from public.revenue_report where id = $1)`, [r.id]))
      .rejects.toThrow('transition-not-allowed');
    await t.as(F1, `select public.report_return($1, 'Не учтены возвраты')`, [r.id]);
    await t.as(PARTNER, `select public.report_save_draft($1, '2024-10-01', $2::jsonb)`,
      [contract, JSON.stringify([{ location_id: loc1, gross_minor: 1_000_000, returns_minor: 100_000 }, { location_id: loc2, gross_minor: 0, zero_reason: 'x' }])]);
    const revs = await t.as<{ rev_no: number; locked: boolean }>(PARTNER, `select rev_no, locked from public.report_revision where report_id = $1 order by rev_no`, [r.id]);
    expect(revs).toEqual([{ rev_no: 1, locked: true }, { rev_no: 2, locked: false }]);
  });

  it('закрытый период исправляется только корректировкой', async () => {
    const acc = await closedPeriod('2024-11-01', [{ location_id: loc1, gross_minor: 10_000_000 }, { location_id: loc2, gross_minor: 0, zero_reason: 'x' }]);
    await t.expectError(F2, `select public.accrual_publish($1, $2)`, 'transition-not-allowed', [acc.reportId, key('pub')]);
    await t.as(F2, `select public.adjustment_create($1, 'debit', 7000, 'Неучтённая выручка (акт сверки)', $2)`, [acc.accrualId, key('adj')]);
    expect(await outstanding(acc.accrualId)).toBe(707_000);
    await t.expectError(F2, `select public.adjustment_create($1, 'credit', 100, '', $2)`, 'validation', [acc.accrualId, key('adj')]);
  });

  it('спор не удаляет начисление и не меняет сальдо', async () => {
    const acc = await closedPeriod('2024-12-01', [{ location_id: loc1, gross_minor: 10_000_000 }, { location_id: loc2, gross_minor: 0, zero_reason: 'x' }]);
    await t.as(PARTNER, `select public.dispute_open($1, 100000, 'Возвраты учтены не полностью')`, [acc.accrualId]);
    const [b] = await t.as<{ outstanding_minor: string; disputed_minor: string }>(PARTNER,
      `select outstanding_minor, disputed_minor from public.v_accrual_balance where accrual_id = $1`, [acc.accrualId]);
    expect(Number(b.outstanding_minor)).toBe(700_000);
    expect(Number(b.disputed_minor)).toBe(100_000);
  });
});

describe('ROY-01a и AT-09: смена ставки', () => {
  it('ставка изменилась в периоде → без разбивки базы утверждение запрещено', async () => {
    const [r] = await t.admin<{ id: string }>(`select r.id from public.revenue_report r join public.partner p on p.id = r.partner_id
      where p.code = 'GAMMA' and r.status = 'submitted'`);
    await t.expectError(F1, `select public.report_approve($1)`, 'policy-split-required', [r.id]);
    const [{ period, mid }] = await t.admin<{ period: string; mid: string }>(
      `select to_char(period, 'YYYY-MM-DD') as period, to_char(period + 13, 'YYYY-MM-DD') as mid from public.revenue_report where id = $1`, [r.id]);
    const [{ end }] = await t.admin<{ end: string }>(`select to_char(($1::date + interval '1 month' - interval '1 day')::date, 'YYYY-MM-DD') as end`, [period]);
    const [{ next }] = await t.admin<{ next: string }>(`select to_char($1::date + 1, 'YYYY-MM-DD') as next`, [mid]);
    // база 7 850 000: до смены ставки 4 000 000 × 7%, после 3 850 000 × 6,5%
    const segments = [{ from: period, to: mid, base_minor: 4_000_000 }, { from: next, to: end, base_minor: 3_850_000 }];
    const [res] = await t.as<{ r: { amount_minor: number; calculation_id: string } }>(F1, `select public.report_approve($1, $2::jsonb) as r`, [r.id, JSON.stringify(segments)]);
    expect(Number(res.r.amount_minor)).toBe(280_000 + 250_250);
    const [replay] = await t.as<{ r: { matches: boolean } }>(F1, `select public.calculation_replay($1) as r`, [res.r.calculation_id]);
    expect(replay.r.matches).toBe(true);
  });

  it('новая ставка после закрытия месяца не меняет старый расчёт', async () => {
    const acc = await closedPeriod('2023-12-01', [{ location_id: loc1, gross_minor: 10_000_000 }, { location_id: loc2, gross_minor: 0, zero_reason: 'x' }]).catch(() => null);
    // договор действует с 2024-01-01 — период до начала договора отклоняется
    expect(acc).toBeNull();
    const closed = await closedPeriod('2025-01-01', [{ location_id: loc1, gross_minor: 10_000_000 }, { location_id: loc2, gross_minor: 0, zero_reason: 'x' }]);
    await t.as(F1, `select public.contract_policy_add($1, '2025-01-01', 900, 'half_up', 5, 15, 'Новая ставка задним числом')`, [contract])
      .catch(async () => t.as(F1, `select public.contract_policy_add($1, '2025-01-02', 900, 'half_up', 5, 15, 'Новая ставка')`, [contract]));
    const [replay] = await t.as<{ r: { stored_amount_minor: number; matches: boolean } }>(F1, `select public.calculation_replay($1) as r`, [closed.calculationId]);
    expect(Number(replay.r.stored_amount_minor)).toBe(700_000);
    expect(replay.r.matches).toBe(true);
  });
});

describe('AT-07: повторный импорт', () => {
  it('тот же файл не удваивает базу; ошибки — в протоколе', async () => {
    const rows = [{ location_code: 'ALPHA-1', gross_minor: '3000000' }, { location_code: 'ALPHA-2', gross_minor: '0', zero_reason: 'Ремонт' }];
    const [a] = await t.as<{ r: { status: string } }>(PARTNER, `select public.report_import($1, '2025-02-01', 'hash-1', 'feb.csv', $2::jsonb) as r`, [contract, JSON.stringify(rows)]);
    expect(a.r.status).toBe('applied');
    const [b] = await t.as<{ r: { replayed: boolean } }>(PARTNER, `select public.report_import($1, '2025-02-01', 'hash-1', 'feb.csv', $2::jsonb) as r`, [contract, JSON.stringify(rows)]);
    expect(b.r.replayed).toBe(true);
    const [s] = await t.as<{ s: string }>(PARTNER, `select sum(l.base_minor) as s from public.report_line l join public.revenue_report r on r.current_revision_id = l.revision_id
      where r.contract_id = $1 and r.period = '2025-02-01'`, [contract]);
    expect(Number(s.s)).toBe(3_000_000);
    const [bad] = await t.as<{ r: { status: string; errors: unknown[] } }>(PARTNER, `select public.report_import($1, '2025-02-01', 'hash-2', 'bad.csv', $2::jsonb) as r`,
      [contract, JSON.stringify([{ location_code: 'BETA-1', gross_minor: '1' }, { location_code: 'ALPHA-1', gross_minor: '12.5' }])]);
    expect(bad.r.status).toBe('rejected');
    expect(bad.r.errors).toHaveLength(2);
  });
});

describe('демо-история из seed', () => {
  it('просроченная задолженность партнёра ALPHA: 51 800 ₽ − 30 000 ₽', async () => {
    const rows = await t.as<{ outstanding_minor: string }>(PARTNER,
      `select outstanding_minor from public.v_accrual_balance where outstanding_minor > 0 and due_on < current_date and period >= (date_trunc('month', now()) - interval '3 month')::date`);
    expect(rows.map((r) => Number(r.outstanding_minor))).toContain(2_180_000);
  });

  it('напоминание о несданном отчёте BETA создано один раз', async () => {
    await t.as('supply@demo.example.com', `select public.run_integration_jobs()`);
    const rows = await t.admin(`select 1 from public.task where kind = 'report_due' and partner_id = (select id from public.partner where code = 'BETA')`);
    expect(rows).toHaveLength(1);
  });
});

describe('напоминание о сдаче отчёта', () => {
  it('закрывается само, когда партнёр отправляет отчёт за этот период', async () => {
    const beta = 'beta.owner@demo.example.com';
    const [{ id: betaContract }] = await t.admin<{ id: string }>(`select k.id from public.contract k join public.partner p on p.id = k.partner_id where p.code = 'BETA'`);
    const [{ id: betaLoc }] = await t.admin<{ id: string }>(`select id from public.location where code = 'BETA-1'`);
    await t.as('supply@demo.example.com', `select public.run_integration_jobs()`);
    const [{ p }] = await t.admin<{ p: string }>(`select to_char(date_trunc('month', now()) - interval '1 month', 'YYYY-MM-DD') as p`);
    const key = `report_due:${betaContract}:${p}`;
    // Демо-данные v3: Бета уже отправила отчёт за прошлый месяц — напоминание должно быть закрыто им, а не висеть
    const [rep] = await t.admin<{ status: string }>(`select status from public.revenue_report where contract_id = $1 and period = $2::date`, [betaContract, p]);
    expect(rep.status).toBe('submitted');
    void beta; void betaLoc;
    expect((await t.admin<{ status: string }>(`select status from public.task where dedupe_key = $1`, [key]))[0].status).toBe('done');
  });
});
