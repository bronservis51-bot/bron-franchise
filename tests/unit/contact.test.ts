import { describe, expect, it } from 'vitest';
import { parseLeadContact } from '../../src/modules/leads/contact';
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
