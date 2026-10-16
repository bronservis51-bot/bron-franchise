// Названия статусов для пользователя.
import type { Tone } from './index';

type Map = Record<string, [string, Tone]>;

export const ARTICLE_STATUS: Map = {
  draft: ['черновик', 'neutral'],
  published: ['опубликована', 'success'],
  superseded: ['заменена новой', 'neutral'],
  archived: ['в архиве', 'neutral'],
};

export const PARTNER_STATUS: Map = {
  active: ['работает', 'success'],
  suspended: ['приостановлен', 'warning'],
  terminated: ['договор расторгнут', 'neutral'],
};

export const st = (m: Map, k: string): [string, Tone] => m[k] ?? [k, 'neutral'];
