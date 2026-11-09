import {afterEach,expect,it,vi} from 'vitest';
import {checkConnection,probe,connectionSummary,diagnosticText} from '../../src/platform/connection';
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers();});
it('checks auth and database separately, rejects an HTML success response',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.includes('/auth/')?Response.json({name:'GoTrue'}):Response.json('ok')));
 const c=await checkConnection('https://api.example.invalid','public-test');
 expect(c.auth.ok).toBe(true);expect(c.data.ok).toBe(true);
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('<html>proxy error</html>',{status:200})));
 expect((await probe('https://api.example.invalid','public-test','data')).ok).toBe(false);
});
it('reports HTTP and network outcomes without inventing a blocked network cause',async()=>{
 vi.stubGlobal('fetch',vi.fn(async(url:string)=>{if(url.includes('/auth/'))throw new TypeError('Failed to fetch');return new Response('',{status:503});}));
 const c=await checkConnection('https://api.example.invalid','public-test');
 expect(c.auth.code).toBe('AUTH-NETWORK');expect(c.data.code).toBe('DATA-HTTP-503');
 expect(connectionSummary(c)).toContain('Причиной могут быть');
});
it('bounds a hung probe and keeps diagnosis free from logins, passwords and browser storage',async()=>{
 vi.useFakeTimers();vi.stubGlobal('fetch',vi.fn((_url,init)=>new Promise((_,reject)=>init.signal.addEventListener('abort',()=>reject(new DOMException('Aborted','AbortError'))))));
 const p=probe('https://api.example.invalid','public-test','auth',undefined,100);
 await vi.advanceTimersByTimeAsync(100);expect((await p).code).toBe('AUTH-TIMEOUT');
 const output=JSON.parse(diagnosticText(null,true,'build'));
 expect(Object.keys(output).sort()).toEqual(['at','connection','online','version']);
});
