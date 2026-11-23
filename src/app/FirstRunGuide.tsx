import { useLayoutEffect, useRef, useState } from 'react';
import { Button, ConfirmDialog } from '../ui';
import './FirstRunGuide.css';

export type FirstRunRole = 'manager' | 'franchisee' | 'team' | 'staff' | 'support';

const guides: Record<FirstRunRole, ReadonlyArray<{ title: string; text: string }>> = {
  manager: [
    { title: 'Партнёры и точки', text: 'На «Главной» откройте карточку партнёра. В ней находятся точки, настройки и доступ в кабинет.' },
    { title: 'Заявки с сайта', text: 'В «Заявках» берите обращения в работу и отмечайте этап переговоров.' },
    { title: 'Экономика сети', text: 'В «Экономике» сверяйте поставки и расчёты по роялти.' },
  ],
  franchisee: [
    { title: 'Ваша точка', text: 'На «Главной» внесите итог дня или проверьте задачи запуска.' },
    { title: 'Команда', text: 'В «Сотрудниках» выдавайте доступ, проверяйте смены и настраивайте оплату.' },
    { title: 'Финансы', text: 'В «Финансах» выберите месяц, внесите расходы и скачайте отчёт.' },
  ],
  team: [
    { title: 'Закрытие смены', text: 'Нажмите «Закрыть смену». Укажите точку, наличные и карту.' },
    { title: 'Выручка точки', text: 'На «Главной» за выбранный месяц видны выручка точки и ваш заработок.' },
    { title: 'Уроки и команда', text: 'Уроки доступны в «Обучении». Доступ к «Сотрудникам» выдаёт франчайзи.' },
  ],
  staff: [
    { title: 'Закрытие смены', text: 'Нажмите «Закрыть смену». Укажите точку, наличные и карту.' },
    { title: 'Заработок', text: 'На «Главной» выберите месяц, чтобы посмотреть свои смены и начисления.' },
    { title: 'Уроки', text: 'В «Обучении» есть уроки и тесты. Стажёрам видна назначенная программа стажировки.' },
  ],
  support: [
    { title: 'Вопросы команды', text: 'На «Главной» открывайте вопросы и отвечайте на них.' },
    { title: 'Статьи и инструкции', text: 'В «Знаниях» ищите инструкции. Редакторы могут обновлять статьи.' },
  ],
};

const guideKey = (userId: string, role: FirstRunRole) => `bron.first-run:${userId}:${role}`;

export function hasSeenFirstRunGuide(userId: string, role: FirstRunRole) {
  try { return localStorage.getItem(guideKey(userId, role)) === 'seen'; }
  catch { return false; }
}

export function markFirstRunGuideSeen(userId: string, role: FirstRunRole) {
  try { localStorage.setItem(guideKey(userId, role), 'seen'); }
  catch { /* In private mode the dialog can still be dismissed for the current app session. */ }
}

export function FirstRunGuide({ role, replay, onClose }: { role: FirstRunRole; replay: boolean; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const stepBody = useRef<HTMLDivElement>(null);
  const steps = guides[role];
  const last = step === steps.length - 1;
  useLayoutEffect(() => {
    const scroller = stepBody.current?.closest('.dialog-body');
    if (scroller) scroller.scrollTop = 0;
  }, [step]);
  return (
    <ConfirmDialog open className="first-run-dialog" title="Первые шаги" cancelLabel={replay ? 'Закрыть' : 'Пропустить'}
      confirmLabel={last ? 'Готово' : 'Далее'} onClose={onClose}
      onConfirm={last ? onClose : () => setStep(step + 1)}>
      <div ref={stepBody} className="first-run-guide" aria-live="polite" aria-atomic="true">
        <p className="faint first-run-progress">Шаг {step + 1} из {steps.length}</p>
        <h3>{steps[step].title}</h3>
        <p>{steps[step].text}</p>
      </div>
      {step > 0 && <Button variant="ghost" onClick={() => setStep(step - 1)}>Назад</Button>}
    </ConfirmDialog>
  );
}
