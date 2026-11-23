import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { CustomPayFields, customPayDraft, customPayPolicy } from '../../src/modules/staff/CustomPayFields';
import { PayExample } from '../../src/modules/staff/Motivation';

const policy = { name: 'Личные условия', floor_minor: 50000, tiers: [
  { from_minor: 0, rate_bp: 1000, bonus_minor: 0 },
  { from_minor: 1000000, rate_bp: 1250, bonus_minor: 20000 },
] };

it('keeps every tier and a conflicting threshold visible for correction', () => {
  const draft = customPayDraft(policy);
  expect(customPayPolicy(draft)).toEqual(policy);
  draft.tiers[1].from.minor = '0';
  const html = renderToStaticMarkup(<CustomPayFields currency="RUB" draft={draft} setDraft={() => {}} />);
  expect(html).toContain('Порог должен быть выше предыдущего');
  expect(html).not.toContain('<details');
  expect(html).toContain('Ступень 2');
  expect(customPayPolicy(draft)).toBeNull();
});

it('previews the selected tier including its bonus and uses the partner currency', () => {
  const html = renderToStaticMarkup(<PayExample currency="KZT" policy={policy} />).replace(/\s/g, '');
  expect(html).toContain('1450₸');
});

it('previews existing fixed terms and a separate minimum during the internship', () => {
  const html = renderToStaticMarkup(<PayExample currency="RUB" policy={{ mode: 'legacy', fee_minor: 40000, rate_bp: 500 }}
    traineePolicy={{ ...policy, floor_minor: 180000 }} />).replace(/\s/g, '');
  expect(html).toContain('Послестажировки');
  expect(html).toContain('900₽');
  expect(html).toContain('Настажировке');
  expect(html).toContain('2000₽');
});
