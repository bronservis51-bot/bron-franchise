import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@supabase/supabase-js',()=>({createClient:vi.fn(()=>null)}));
function storage(){const x:Record<string,string>={};return Object.assign(x,{getItem:(k:string)=>Object.hasOwn(x,k)?x[k]:null,setItem:(k:string,v:string)=>{x[k]=v;},removeItem:(k:string)=>{delete x[k];}});}
afterEach(()=>vi.unstubAllGlobals());
describe('independent account tabs',()=>{
 it('isolates remembered sessions and cached profiles without clearing the existing account',async()=>{
  const local=storage(),session=storage();vi.stubGlobal('localStorage',local);vi.stubGlobal('sessionStorage',session);
  vi.stubGlobal('location',{search:''});vi.resetModules();const original=await import('../../src/platform/supabase');
  original.setRememberDevice(true);original.snapshot.set('me',{user:'owner'});local.setItem('bron.auth','owner-session');
  vi.stubGlobal('location',{search:'?profile=manager'});vi.resetModules();const other=await import('../../src/platform/supabase');
  expect(other.snapshot.get('me')).toBeNull();other.setRememberDevice(true);other.snapshot.set('me',{user:'manager'});
  expect(original.snapshot.get('me')).toEqual({user:'owner'});expect(other.snapshot.get('me')).toEqual({user:'manager'});
  other.snapshot.clear();expect(original.snapshot.get('me')).toEqual({user:'owner'});expect(local.getItem('bron.auth')).toBe('owner-session');
 });
});
