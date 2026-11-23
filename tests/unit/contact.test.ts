import { describe, expect, it } from 'vitest';
import { canonicalLeadPhone, leadPhoneCountry, parseLeadContact } from '../../src/modules/leads/contact';
describe('minimal lead contact',()=>{
 it('accepts @handle, a profile link, or a plain Instagram handle',()=>{
  for(const text of ['@bron.service','bron.service','https://www.instagram.com/bron.service/?igsh=xyz'])expect(parseLeadContact(text)).toEqual({name:'@bron.service',instagram:'bron.service'});
 });
 it('keeps real names and never creates a profile link from arbitrary URLs',()=>{
  expect(parseLeadContact('  Адам Алиев ')).toEqual({name:'Адам Алиев',instagram:null});
  expect(parseLeadContact('javascript:alert(1)').instagram).toBeNull();
  expect(parseLeadContact('https://evil.example/test').instagram).toBeNull();
 });
});

describe('lead phone contact', () => {
  it.each([
    ['8 (912) 444-72-01', '79124447201', 'RU'],
    ['8 777 444 7202', '77774447202', 'KZ'],
    ['+8 840 444-72-03', '88404447203', undefined],
    ['+90 532 444-72-04', '905324447204', 'TR'],
    ['+7 800 444-72-05', '78004447205', undefined],
  ])('canonicalizes %s and uses explicitly supported country data', (phone, digits, country) => {
    expect(canonicalLeadPhone(phone)).toBe(digits);
    expect(leadPhoneCountry(phone)).toBe(country);
  });
});
