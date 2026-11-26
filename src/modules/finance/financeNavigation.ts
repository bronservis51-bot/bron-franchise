export const financeSections = ['report', 'days', 'expenses', 'payroll'] as const;
export type FinanceSection = typeof financeSections[number];

export function financeMonthLimit(officeMonth: string, points: readonly { location_id: string; today: string }[], location: string | null) {
  if (location) {
    const point = points.find(value => value.location_id === location);
    return point ? point.today.slice(0, 7) + '-01' : officeMonth;
  }
  return points.reduce((latest, point) => {
    const month = point.today.slice(0, 7) + '-01';
    return month > latest ? month : latest;
  }, officeMonth);
}

export function financeOfficeMonth(now = new Date()) {
  const fields = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', timeZone: 'Europe/Moscow' })
    .formatToParts(now);
  const year = fields.find(part => part.type === 'year')?.value;
  const month = fields.find(part => part.type === 'month')?.value;
  return year + '-' + month + '-01';
}

export function financeSelection(params: URLSearchParams, currentMonth: string) {
  const requestedSection = params.get('section');
  const section = requestedSection === 'royalty' ? 'expenses' : financeSections.find(value => value === requestedSection) ?? 'report';
  const requestedMonth = params.get('month');
  const month = requestedMonth && /^[1-9]\d{3}-(0[1-9]|1[0-2])-01$/.test(requestedMonth) && requestedMonth <= currentMonth
    ? requestedMonth : currentMonth;
  const requestedLocation = params.get('location');
  const location = requestedLocation && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(requestedLocation)
    ? requestedLocation.toLowerCase() : null;
  const requestedDay = params.get('day');
  let day: string | null = null;
  if (section === 'days' && requestedDay && /^\d{4}-\d{2}-\d{2}$/.test(requestedDay) && requestedDay.slice(0, 7) === month.slice(0, 7)) {
    const date = new Date(requestedDay + 'T12:00:00Z');
    if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === requestedDay) day = requestedDay;
  }
  return { section, month, location, day };
}

export function financeDays(month: string, location?: string, day?: string) {
  const params = new URLSearchParams({ section: 'days', month });
  if (location) params.set('location', location);
  if (day) params.set('day', day);
  return `/finance?${params}`;
}
