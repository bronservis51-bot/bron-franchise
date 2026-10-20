// Режим редактирования «Финансов»: исправить выручку любого доступного дня, расходы месяца; где править зарплату.
import { useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Users } from 'lucide-react';
import { monthLabel } from '../../platform/dates';
import { Card, Chips, DataState } from '../../ui';
import { DayList } from '../revenue/FranchiseeHome';
import { RevenueDialog } from '../revenue/RevenueDialog';
import { revenueMonth, type DayRow } from '../revenue/api';
import { ExpensesCard, type Expense } from './Expenses';

type Tab = 'revenue' | 'expenses' | 'payroll';

export function FinanceEditor({ month, currency, location, locations, expenses, own, prevCount, total }: {
  month: string; currency: string; location: string | null; locations: { id: string; name: string }[];
  expenses: Expense[]; own: string[]; prevCount: number; total: number;
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
          <p className="faint">Нажмите на день, чтобы внести или исправить выручку. Текущий месяц можно править целиком, прошлый — до 5-го числа; позже — через менеджера по франшизе.</p>
          <DataState query={q} skeleton={4}>
            {(m) => (
              <>
                <DayList m={m} onPick={(day, row) => setEdit({ day, row })} />
                {edit && <RevenueDialog location={m.location_id} currency={m.currency} day={edit.day} existing={edit.row} staff={m.staff} onClose={() => setEdit(null)} />}
              </>
            )}
          </DataState>
        </>
      )}
      {tab === 'expenses' && (
        <ExpensesCard month={month} currency={currency} location={location} locations={locations} expenses={expenses} own={own} prevCount={prevCount} total={total} bare />
      )}
      {tab === 'payroll' && (
        <div className="stack" style={{ gap: 8 }}>
          <p className="muted">Зарплата считается сама по закрытым сменам: ставка за выход + процент от выручки смены.
            Чтобы исправить смену или ставку сотрудника, откройте раздел «Сотрудники» — заработок пересчитается.</p>
          <Link className="btn btn-secondary" to="/staff" style={{ alignSelf: 'flex-start' }}><Users size={16} aria-hidden />Открыть «Сотрудники»</Link>
        </div>
      )}
    </Card>
  );
}
