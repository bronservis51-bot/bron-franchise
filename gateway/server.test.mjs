import {test} from 'node:test';import assert from 'node:assert/strict';import {createGateway} from './server.mjs';
const key='sb_publishable_test_gateway_only',origin='https://app.example.invalid';
async function run(fn){const calls=[];const server=createGateway({upstream:'https://example.supabase.co',key,origins:[origin],fetchImpl:async(u,init)=>{calls.push({url:String(u),init});return Response.json({ok:true},{headers:{'sb-request-id':'synthetic-request'}});}});await new Promise(r=>server.listen(0,'127.0.0.1',r));try{await fn(`http://127.0.0.1:${server.address().port}`,calls);}finally{server.closeAllConnections();await new Promise(r=>server.close(r));}}
test('forwards original JWT and payload only to fixed API, never browser cookies',()=>run(async(url,calls)=>{
 const r=await fetch(url+'/rest/v1/rpc/lead_list',{method:'POST',headers:{apikey:key,origin,authorization:'Bearer synthetic-jwt',cookie:'must-not-leave-device','Content-Type':'application/json'},body:'{}'});
 assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(r.headers.get('access-control-allow-origin'),origin);
 assert.equal(calls[0].url,'https://example.supabase.co/rest/v1/rpc/lead_list');assert.equal(calls[0].init.headers.get('authorization'),'Bearer synthetic-jwt');assert.equal(calls[0].init.headers.has('cookie'),false);assert.equal(String(calls[0].init.body),'{}');
}));
test('blocks other origins, admin routes, secret keys and arbitrary destinations',()=>run(async(url,calls)=>{
 for(const [path,headers,status] of [['/rest/v1/rpc/me',{apikey:key,origin:'https://attacker.invalid'},403],['/auth/v1/admin/users',{apikey:key,origin},404],['/rest/v1/rpc/me',{apikey:'sb_secret_forbidden',origin},401],['//attacker.invalid/anything',{apikey:key,origin},400],['/auth/v1/signup',{apikey:key,origin},404]]){
  assert.equal((await fetch(url+path,{headers})).status,status);
 }assert.equal(calls.length,0);
}));
test('supports preflight and independent process health without invoking database',()=>run(async(url,calls)=>{
 const r=await fetch(url+'/rest/v1/rpc/me',{method:'OPTIONS',headers:{origin}});assert.equal(r.status,204);assert.equal(r.headers.get('access-control-allow-origin'),origin);
 assert.deepEqual(await(await fetch(url+'/healthz')).json(),{ok:true});assert.equal(calls.length,0);
}));
