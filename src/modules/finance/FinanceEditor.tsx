// Режим редактирования «Финансов»: исправить выручку любого доступного дня, расходы месяца; где править зарплату.
import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { monthLabel } from '../../platform/dates';
import type { MinorInput } from '../../platform/money';
import { Card, Chips, DataState } from '../../ui';
import { DayList } from '../revenue/components';
import { RevenueDialog } from '../revenue/RevenueDialog';
import { canEditRevenueDay, revenueMonth, type DayRow } from '../revenue/api';
import { ExpensesCard, type Expense } from './Expenses';

type Tab = 'revenue' | 'expenses' | 'payroll';

export function FinanceEditor({ month, currency, location, locations, expenses, own, prevCount, total, royalty }: {
  month: string; currency: string; location: string | null; locations: { id: string; name: string; status: string }[];
  expenses: Expense[]; own: string[]; prevCount: number; total: MinorInput; royalty: MinorInput;
}) {
  const [tab, setTab] = useState<Tab>('revenue');
  const [point, setPoint] = useState(location ?? locations[0]?.id ?? '');
  const [edit, setEdit] = useState<{ day: string; row?: DayRow } | null>(null);
  const q = useQuery({ queryKey: ['revenue', 'month', point, month], enabled: Boolean(point) && tab === 'revenue', queryFn: () => revenueMonth(point, month) });
  return (
    <Card title={`Редактирование — ${monthLabel(month)}`} className="fin-editor">
      <Chips label="Что исправить" value={tab} onChange={setTab}
        options={[{ id: 'revenue', label: 'Выручка по дням' }, { id: 'expenses', label: 'Расходы' }, { id: 'payroll', label: 'Зарплата' }]} />
      {tab === 'revenue' && (
        <>
          {locations.length > 1 && (
            <div className="chips point-chips" role="group" aria-label="Точка">
              {locations.map((l) => <button key={l.id} type="button" className="chip" aria-pressed={point === l.id} onClick={() => setPoint(l.id)}>{l.name}</button>)}
            </div>
          )}
          <p className="faint">Выберите месяц и день, чтобы внести пропущенную выручку или исправить итог.</p>
          <DataState query={q} skeleton={4}>
            {(m) => (
              <>
                <DayList m={m} onPick={(day, row) => setEdit({ day, row })} />
                {edit && <RevenueDialog location={m.location_id} locationName={m.location_name} currency={m.currency} day={edit.day} existing={edit.row}
                  dayOff={m.days_off?.includes(edit.day)} canMarkOff={canEditRevenueDay(m, edit.day) && (Boolean(m.editable_days) || m.status === 'active')}
                  readOnly={!canEditRevenueDay(m, edit.day)} onClose={() => setEdit(null)} />}
              </>
            )}
          </DataState>
        </>
      )}
      {tab === 'expenses' && (
        <ExpensesCard month={month} currency={currency} location={location} locations={locations.filter(point => point.status === 'active')} expenses={expenses} own={own} prevCount={prevCount} total={total} royalty={royalty} bare />
      )}
      {tab === 'payroll' && (
        <div className="stack" style={{ gap: 8 }}>
          <p className="muted">Зарплата считается по закрытым сменам и сохранённым условиям оплаты.
            Настройки в разделе «Сотрудники» действуют с выбранной даты. Прошлую смену можно открыть и исправить в этом же разделе.</p>
          <Link className="btn btn-secondary" to="/staff" style={{ alignSelf: 'flex-start' }}><Users size={16} aria-hidden />Открыть «Сотрудники»</Link>
        </div>
      )}
    </Card>
  );
}
