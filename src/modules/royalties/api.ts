import { command, from, rows, single } from '../../platform/backend';

export interface Report { id: string; number: string; contract_id: string; partner_id: string; period: string; status: string; current_revision_id: string | null; partner_ref: string | null; return_reason: string | null; calculation_id: string | null; updated_at: string; revision: number }
export interface Revision { id: string; report_id: string; rev_no: number; source: string; verification_level: string; comment: string | null; locked: boolean; submitted_at: string | null; submitted_by: string | null; created_at: string }
export interface Line { id: string; revision_id: string; location_id: string; currency: string; gross_minor: string; returns_minor: string; excluded_minor: string; base_minor: string; zero_reason: string | null }
export interface Calculation { id: string; report_id: string; revision_id: string; base_minor: string; exact_amount: string; amount_minor: string; currency: string; created_by: string; created_at: string;
  inputs: { segments: { from: string; to: string; base_minor: number; rate_bp: number; policy_version: number; exact: number }[]; rounding: string; rev_no: number; verification_level: string } }
export interface Contract { id: string; number: string; partner_id: string; currency: string; timezone: string; valid_from: string; valid_to: string | null; is_test: boolean }
export interface Balance { accrual_id: string; number: string; contract_id: string; partner_id: string; period: string; currency: string; amount_minor: string; due_on: string; debit_minor: string; credit_minor: string; allocated_minor: string; outstanding_minor: string; disputed_minor: string }
export interface Payment { id: string; number: string; partner_id: string; contract_id: string | null; source: string; status: string; amount_minor: string; currency: string; paid_on: string; partner_ref: string | null; bank_ref: string | null; comment: string | null; reported_by: string | null; registered_by: string | null; confirmed_by: string | null; status_reason: string | null; created_at: string }
export interface PaymentBalance { payment_id: string; number: string; partner_id: string; currency: string; amount_minor: string; status: string; paid_on: string; source: string; allocated_minor: string; unallocated_minor: string }
export interface Allocation { id: string; payment_id: string; accrual_id: string; amount_minor: string; status: string; reversed_reason: string | null; created_at: string; created_by: string }
export interface Accrual { id: string; number: string; contract_id: string; partner_id: string; period: string; calculation_id: string; amount_minor: string; currency: string; due_on: string; status: string; published_by: string; published_at: string }

export const listReports = (status?: string | null) => {
  let q = from('revenue_report').select('*').order('period', { ascending: false }).limit(200);
  if (status) q = q.in('status', status === 'submitted' ? ['submitted', 'in_review'] : [status]);
  return rows<Report>(q);
};
export const listBalances = () => rows<Balance>(from('v_accrual_balance').select('*').order('period', { ascending: false }));
export const listPayments = () => rows<PaymentBalance>(from('v_payment_balance').select('*').order('paid_on', { ascending: false }));
export const contracts = () => rows<Contract>(from('contract').select('*').order('number'));
export const contractLocations = (contractId: string) => rows<{ location_id: string; valid_from: string; valid_to: string | null }>(from('contract_location').select('location_id, valid_from, valid_to').eq('contract_id', contractId));
export const policies = (contractId: string) => rows<{ id: string; version: number; effective_from: string; rate_bp: number; rounding: string; report_due_day: number; payment_due_day: number; note: string | null }>(
  from('contract_policy_version').select('*').eq('contract_id', contractId).order('effective_from'));

export const getReport = (id: string) => single<Report>(from('revenue_report').select('*').eq('id', id));
export const revisions = (reportId: string) => rows<Revision>(from('report_revision').select('*').eq('report_id', reportId).order('rev_no'));
export const lines = (revisionId: string) => rows<Line>(from('report_line').select('*').eq('revision_id', revisionId));
export const getCalculation = (id: string) => single<Calculation>(from('calculation').select('*').eq('id', id));
export const accrualForReport = (contractId: string, period: string) => single<Accrual>(from('accrual').select('*').eq('contract_id', contractId).eq('period', period).eq('status', 'published'));
export const getAccrual = (id: string) => single<Accrual>(from('accrual').select('*').eq('id', id));
export const getBalance = (id: string) => single<Balance>(from('v_accrual_balance').select('*').eq('accrual_id', id));
export const adjustments = (accrualId: string) => rows<{ id: string; direction: string; amount_minor: string; reason: string; created_by: string; created_at: string }>(from('adjustment').select('*').eq('accrual_id', accrualId).order('created_at'));
export const disputes = (accrualId: string) => rows<{ id: string; amount_minor: string; reason: string; status: string; resolution: string | null; opened_by: string; created_at: string }>(from('dispute').select('*').eq('accrual_id', accrualId).order('created_at'));
export const allocationsFor = (field: 'accrual_id' | 'payment_id', id: string) => rows<Allocation>(from('allocation').select('*').eq(field, id).order('created_at'));
export const getPayment = (id: string) => single<Payment>(from('payment').select('*').eq('id', id));
export const getPaymentBalance = (id: string) => single<PaymentBalance>(from('v_payment_balance').select('*').eq('payment_id', id));
export const events = (type: string, id: string) => rows<{ id: number; actor_id: string | null; action: string; detail: Record<string, unknown> | null; comment: string | null; at: string }>(
  from('royalty_event').select('*').eq('subject_type', type).eq('subject_id', id).order('at'));
export interface SalesCheck { report_id: string; period: string; reported_gross_minor: number; daily_gross_minor: number; diff_minor: number; missing_days: number;
  detail: { location_id: string; location_name: string; reported_minor: number; daily_minor: number; missing_days: number }[]; checked_at: string }
export const salesCheck = (reportId: string) => rows<SalesCheck>(from('report_sales_check').select('*').eq('report_id', reportId)).then((r) => r[0] ?? null);
export const notes = (type: string, id: string) => rows<{ id: string; body: string; author_id: string; created_at: string }>(from('royalty_note').select('*').eq('subject_type', type).eq('subject_id', id).order('created_at'));

export interface LineInput { location_id: string; gross_minor: string; returns_minor: string; excluded_minor: string; zero_reason: string | null }

export const royaltyCommands = {
  saveDraft: (contract: string, period: string, ls: LineInput[], comment: string | null, partnerRef: string | null) =>
    command<Report>('report_save_draft', { contract, period, lines: ls, comment, partner_ref: partnerRef }),
  importRows: (contract: string, period: string, fileHash: string, fileName: string, rs: Record<string, string>[]) =>
    command<{ batch_id: string; status: string; errors: { row: number; field: string; error: string }[]; replayed: boolean; rows?: number }>('report_import', { contract, period, file_hash: fileHash, file_name: fileName, rows: rs }),
  submit: (report: string, key: string) => command<{ status: string; rev_no: number; replayed?: boolean }>('report_submit', { report, key }),
  takeReview: (report: string) => command('report_take_review', { report }),
  returnReport: (report: string, reason: string) => command('report_return', { report, reason }),
  approve: (report: string, segments: { from: string; to: string; base_minor: string }[] | null, verification: string, comment: string | null) =>
    command<{ amount_minor: string; calculation_id: string }>('report_approve', { report, segments, verification, comment }),
  replay: (calculation: string) => command<{ stored_amount_minor: string; replayed_amount_minor: string; matches: boolean }>('calculation_replay', { calculation }),
  publish: (report: string, key: string) => command<{ accrual_id: string; number: string }>('accrual_publish', { report, key }),
  close: (report: string) => command('period_close', { report }),
  adjust: (accrual: string, direction: string, amount: string, reason: string, key: string) => command('adjustment_create', { accrual, direction, amount, reason, key }),
  disputeOpen: (accrual: string, amount: string, reason: string) => command('dispute_open', { accrual, amount, reason }),
  disputeResolve: (dispute: string, status: string, resolution: string) => command('dispute_resolve', { dispute, status, resolution }),
  paymentReport: (contract: string, amount: string, currency: string, paidOn: string, ref: string, comment: string | null, key: string) =>
    command<{ payment_id: string; number: string }>('payment_report', { contract, amount, currency, paid_on: paidOn, partner_ref: ref, comment, key }),
  paymentRegister: (partner: string, contract: string | null, amount: string, currency: string, paidOn: string, bankRef: string, reported: string | null, key: string) =>
    command<{ payment_id: string }>('payment_register', { partner, contract, amount, currency, paid_on: paidOn, bank_ref: bankRef, reported_payment: reported, key }),
  paymentConfirm: (payment: string) => command('payment_confirm', { payment }),
  paymentReject: (payment: string, reason: string) => command('payment_reject', { payment, reason }),
  paymentReverse: (payment: string, reason: string) => command('payment_reverse', { payment, reason }),
  allocate: (payment: string, accrual: string, amount: string, key: string) =>
    command<{ payment_unallocated_minor: string; accrual_outstanding_minor: string }>('allocation_create', { payment, accrual, amount, key }),
  allocationReverse: (allocation: string, reason: string) => command('allocation_reverse', { allocation, reason }),
  attachPrepare: (payment: string, f: { name: string; mime: string; size: number; checksum: string }) =>
    command<{ file_id: string; path: string }>('payment_attach_prepare', { payment, name: f.name, mime: f.mime, size: f.size, checksum: f.checksum }),
  note: (type: string, id: string, partner: string, body: string) => command('royalty_note_add', { subject_type: type, subject: id, partner, body }),
};

export const ROY_EVENT: Record<string, string> = {
  submitted: 'Отчёт отправлен', review_started: 'Финансы начали проверку', returned: 'Возвращён на исправление', approved: 'Утверждён, выполнен расчёт',
  closed: 'Период закрыт', published: 'Начисление опубликовано', adjustment: 'Корректировка', dispute_opened: 'Открыт спор', dispute_resolved: 'Спор урегулирован',
  dispute_rejected: 'Спор отклонён', reported: 'Партнёр сообщил об оплате', registered: 'Зачисление зарегистрировано по выписке', confirmed: 'Зачисление подтверждено',
  rejected: 'Оплата отклонена', reversed: 'Платёж возвращён', allocated: 'Распределение', allocation_reversed: 'Распределение сторнировано',
};
