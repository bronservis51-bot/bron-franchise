import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { DataState } from '../../src/ui';
import { AppError } from '../../src/platform/backend';

describe('cached screens after failed refresh', () => {
  const render = (code: 'external-unavailable' | 'forbidden' | 'unauthenticated') => renderToStaticMarkup(
    <DataState query={{ data: ['Сохранённая заявка'], isLoading: false, error: new AppError(code, '', '', ''), refetch() {} }}>
      {rows => <div>{rows.join(', ')}</div>}
    </DataState>,
  );
  it('keeps the last screen with an explicit stale-data warning on a network failure', () => {
    const html = render('external-unavailable');
    expect(html).toContain('Сохранённая заявка');
    expect(html).toContain('Показаны последние загруженные данные');
  });
  it('hides cached content when access or authentication is rejected', () => {
    for (const code of ['forbidden', 'unauthenticated'] as const) expect(render(code)).not.toContain('Сохранённая заявка');
  });
});
