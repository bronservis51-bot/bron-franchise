import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { RoyaltyCheckoutResult, RoyaltyHomeCard, trustedRoyaltyCheckout, type RoyaltyHomeState } from '../../src/modules/revenue/RoyaltyHome';

const payable: RoyaltyHomeState = {
  state: 'payable', month: '2026-11-01', due_on: '2026-12-05', amount_minor: '123405',
  currency: 'RUB', checkout_url: null, missing: [],
};
const render = (status: RoyaltyHomeState) => renderToStaticMarkup(
  <MemoryRouter><RoyaltyHomeCard status={status} onAction={() => undefined} /></MemoryRouter>,
);

describe('royalty on the franchisee homepage', () => {
  it('gives revenue gaps priority and links to the missing day without exposing checkout', () => {
    const html = render({
      ...payable, state: 'missing_revenue',
      missing: [{ location_id: 'point-one', location_name: 'Точка 1', days: ['2026-11-29'] }],
    });
    expect(html).toContain('Заполните выручку за ноябрь');
    expect(html).toContain('home-missing-danger');
    expect(html).toContain('day=2026-11-29');
    expect(html).not.toContain('Оплатить');
  });

  it('offers payment in an inline card with a deadline before overdue', () => {
    const html = render(payable);
    expect(html).toContain('Роялти за ноябрь 2026 года');
    expect(html).toContain('до 5-го числа включительно');
    expect(html).toContain('Оплатить');
    expect(html).not.toContain('role="dialog"');
    expect(html).not.toContain('просрочили');
  });

  it('adds the overdue copy without removing the payment action', () => {
    const html = render({ ...payable, state: 'overdue' });
    expect(html).toContain('Вы просрочили оплату роялти. Оплатите, чтобы избежать санкций.');
    expect(html).toContain('Оплатить');
  });

  it('keeps an unresolved attempt available for status checking, without creating a new payment', () => {
    const html = render({ ...payable, state: 'checking' });
    expect(html).toContain('Проверить статус');
    expect(html).not.toContain('Оплатить</button>');
  });

  it('keeps the overdue message visible during payment checking', () => {
    expect(render({ ...payable, state: 'checking', overdue: true })).toContain('Вы просрочили оплату роялти');
  });

  it('shows a confirmed receipt or an in-progress check on provider return, without opening another payment', () => {
    for (const [state, message] of [['paid', 'Оплата подтверждена'], ['checking', 'Проверяем оплату']] as const) {
      const html = renderToStaticMarkup(<RoyaltyCheckoutResult state={state} onClose={() => undefined} />);
      expect(html).toContain(message);
      expect(html).not.toContain('Оплатить');
    }
  });

  it('does not render a payment link for untrusted origins', () => {
    expect(trustedRoyaltyCheckout('https://yoomoney.ru/api-pages/v2/payment-confirm/epl?orderId=x')).toContain('https://yoomoney.ru/');
    for (const url of ['https://yoomoney.ru.evil.test/pay', 'http://yoomoney.ru/pay', 'javascript:alert(1)', 'https://wrong@yoomoney.ru/pay']) {
      expect(trustedRoyaltyCheckout(url)).toBeNull();
    }
  });
});
