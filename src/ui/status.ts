// Деловые названия статусов для пользователя (UX-04): «Заказ ожидает передачи на склад», а не техническая очередь.
import type { Tone } from './index';

type Map = Record<string, [string, Tone]>;

export const TASK_STATUS: Map = {
  planned: ['запланирована', 'neutral'],
  ready: ['доступна', 'info'],
  in_progress: ['в работе', 'info'],
  waiting_external: ['ждёт внешнего ответа', 'warning'],
  blocked: ['заблокирована', 'danger'],
  in_review: ['на проверке', 'warning'],
  done: ['завершена', 'success'],
  cancelled: ['отменена', 'neutral'],
};

export const TICKET_STATUS: Map = {
  new: ['новое', 'info'],
  assigned: ['назначено', 'info'],
  in_progress: ['в работе', 'info'],
  waiting_partner: ['ждёт вашего ответа', 'warning'],
  waiting_vendor: ['ждёт поставщика', 'warning'],
  resolved: ['решено', 'success'],
  closed: ['закрыто', 'neutral'],
};

export const URGENCY: Map = {
  normal: ['обычная', 'neutral'],
  high: ['высокая', 'warning'],
  stopped: ['точка не работает', 'danger'],
};

export const ORDER_STATUS: Map = {
  draft: ['черновик', 'neutral'],
  submitted: ['отправлен', 'info'],
  confirmed: ['подтверждён складом', 'info'],
  in_fulfillment: ['в сборке', 'info'],
  partially_shipped: ['отгружен частично', 'warning'],
  shipped: ['отгружен', 'info'],
  delivered: ['доставлен', 'success'],
  completed: ['получен полностью', 'success'],
  cancelled: ['отменён', 'neutral'],
};

export const APPROVAL_STATUS: Map = {
  not_required: ['согласование не требуется', 'neutral'],
  pending: ['ждёт согласования', 'warning'],
  approved: ['согласован', 'success'],
  rejected: ['отклонён', 'danger'],
};

export const PAYMENT_STATUS_ORDER: Map = {
  not_required: ['оплата не требуется', 'neutral'],
  required: ['ждёт оплаты', 'warning'],
  reported: ['оплата сообщена', 'warning'],
  confirmed: ['оплата подтверждена', 'success'],
};

export const TRANSFER_STATUS: Map = {
  not_sent: ['не передан на склад', 'neutral'],
  pending: ['ожидает передачи на склад', 'info'],
  sent: ['передан на склад', 'success'],
  failed: ['склад недоступен — повтор автоматически', 'danger'],
  needs_reconciliation: ['проверяем, получил ли склад заказ', 'warning'],
};

export const REPORT_STATUS: Map = {
  draft: ['черновик', 'neutral'],
  submitted: ['отправлен', 'info'],
  in_review: ['на проверке у финансов', 'info'],
  needs_correction: ['требуется исправление', 'danger'],
  approved: ['утверждён', 'success'],
  closed: ['период закрыт', 'success'],
};

export const PAYMENT_STATUS: Map = {
  reported: ['ожидает подтверждения', 'warning'],
  registered: ['зарегистрирована по выписке', 'info'],
  confirmed: ['подтверждена', 'success'],
  rejected: ['отклонена', 'danger'],
  reversed: ['возвращена', 'neutral'],
};

export const VERIFICATION: Map = {
  reported: ['со слов партнёра', 'warning'],
  imported: ['импорт из файла', 'info'],
  verified: ['проверено по источнику', 'success'],
};

export const OPENING_STATUS: Map = {
  active: ['в подготовке', 'info'],
  approved: ['открытие разрешено', 'success'],
  opened: ['открыта, стабилизация', 'success'],
  completed: ['завершён', 'neutral'],
  cancelled: ['отменён', 'neutral'],
};

export const ARTICLE_STATUS: Map = {
  draft: ['черновик', 'neutral'],
  in_review: ['на согласовании', 'warning'],
  published: ['опубликована', 'success'],
  superseded: ['заменена новой', 'neutral'],
  rejected: ['возвращена', 'danger'],
  needs_review: ['требуется пересмотр', 'warning'],
  suspended: ['приостановлена', 'danger'],
  archived: ['в архиве', 'neutral'],
};

export const EXPORT_STATUS: Map = {
  not_required: ['копия не требуется', 'neutral'],
  pending: ['корпоративная копия ожидает сохранения', 'warning'],
  done: ['копия сохранена', 'success'],
  failed: ['копия не сохранена', 'danger'],
};

export const OUTBOX_STATUS: Map = {
  pending: ['ожидает', 'info'],
  processing: ['выполняется', 'info'],
  done: ['выполнено', 'success'],
  failed: ['ошибка, повтор', 'danger'],
  unknown: ['результат неизвестен — сверка', 'warning'],
  dead: ['остановлено', 'danger'],
  resolved_manually: ['решено вручную', 'neutral'],
};

export const UNIT: Record<string, string> = { roll: 'рулон', sheet: 'лист', meter: 'метр', piece: 'шт.', cut: 'вырез', pack: 'упак.' };

export function st(map: Map, key: string | null | undefined): [string, Tone] {
  return (key && map[key]) || [key ?? '—', 'neutral'];
}
