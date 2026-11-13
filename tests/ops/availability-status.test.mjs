import test from 'node:test';
import assert from 'node:assert/strict';
import {checkAvailability,validBackupStatus} from '../../scripts/check-availability.mjs';

const NOW=Date.parse('2026-11-13T18:00:00.000Z');
const at=offset=>new Date(NOW+offset).toISOString();
const status=()=>({checked_at:at(-60_000),last_backup_utc:at(-30*60_000),healthy:true});
const env={APP_URL:'https://app.example.test/',VITE_SUPABASE_URL:'https://api.example.test',
 VITE_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_synthetic'};

test('backup status requires exactly the three public fields and a healthy boolean',()=>{
 assert.equal(validBackupStatus(status(),NOW),true);
 for(const change of [{healthy:false},{healthy:'true'},{healthy:1},{last_backup_utc:null},
   {path:'/private'},{token:'PRIVATE_VALUE_MUST_NOT_ESCAPE'}])
  assert.equal(validBackupStatus({...status(),...change},NOW),false);
 assert.equal(validBackupStatus(null,NOW),false);
 assert.equal(validBackupStatus([],NOW),false);
 assert.equal(validBackupStatus({checked_at:at(0),healthy:true},NOW),false);
});

test('watchdog and backup freshness have independent inclusive limits',()=>{
 assert.equal(validBackupStatus({...status(),checked_at:at(-25*60_000)},NOW),true);
 assert.equal(validBackupStatus({...status(),checked_at:at(-25*60_000-1)},NOW),false);
 assert.equal(validBackupStatus({...status(),last_backup_utc:at(-70*60_000)},NOW),true);
 assert.equal(validBackupStatus({...status(),last_backup_utc:at(-70*60_000-1)},NOW),false);
});

test('timestamps reject excess clock skew, invalid dates and non-UTC values',()=>{
 for(const field of ['checked_at','last_backup_utc']){
  assert.equal(validBackupStatus({...status(),[field]:at(60_000)},NOW),true);
  for(const value of [at(60_001),'2026-02-30T00:00:00Z','2026-11-13T24:00:00Z',
    '2026-11-13T18:00:00+03:00','not-a-date',NOW])
   assert.equal(validBackupStatus({...status(),[field]:value},NOW),false);
 }
 assert.equal(validBackupStatus({...status(),checked_at:'2026-11-13T18:00:00.123456+00:00'},NOW),true);
});

function fakeFetch({backupHttp=200,backupBody,backupFailure=false,publicHttp=200}={}){
 const requests=[];
 const fetchImpl=async(target,init)=>{
  const url=new URL(target);requests.push({url,init});
  if(url.pathname==='/.well-known/bron-health.json'){
   if(backupFailure)throw Error('PRIVATE_NETWORK_ERROR');
   const value=backupBody??{checked_at:new Date().toISOString(),
    last_backup_utc:new Date(Date.now()-60_000).toISOString(),healthy:true};
   return new Response(typeof value==='string'?value:JSON.stringify(value),{status:backupHttp});
  }
  const body=url.pathname.endsWith('app-version.json')?{build:new Date().toISOString()}:
   url.pathname.endsWith('/health')?{name:'GoTrue'}:url.pathname.endsWith('/ping')?'ok':{ok:true};
  return new Response(JSON.stringify(body),{status:publicHttp});
 };
 return {requests,fetchImpl};
}

test('only the fixed backup endpoint accepts HTTP 503, without sending an API key',async()=>{
 for(const backupHttp of [200,503]){
  const {requests,fetchImpl}=fakeFetch({backupHttp});
  const result=await checkAvailability(env,fetchImpl);
  assert.equal(Object.values(result.checks).every(value=>value.ok),true);
  const request=requests.find(value=>value.url.pathname==='/.well-known/bron-health.json');
  assert.equal(request.url.origin,'https://api.example.test');
  assert.equal(request.init.headers,undefined);
  assert.equal(request.init.redirect,'error');
  assert.equal(request.init.cache,'no-store');
  assert.ok(request.init.signal instanceof AbortSignal);
 }
 const {fetchImpl}=fakeFetch({backupHttp:503,publicHttp:503});
 const result=await checkAvailability(env,fetchImpl);
 assert.equal(result.checks.backup.ok,true);
 for(const name of ['frontend','auth','data','landing'])assert.equal(result.checks[name].ok,false);
});

test('malformed, oversized and unexpected HTTP status responses fail without publishing their body',async()=>{
 for(const options of [{backupBody:'PRIVATE_NOT_JSON'},
   {backupBody:' '.repeat(1025)},{backupHttp:201},{backupHttp:302},
   {backupBody:{...status(),token:'PRIVATE_TOKEN'}},{backupFailure:true}]){
  const {fetchImpl}=fakeFetch(options);
  const result=await checkAvailability(env,fetchImpl);
  assert.equal(result.checks.backup.ok,false);
  assert.deepEqual(Object.keys(result.checks.backup).sort(),['http','ms','ok']);
  assert.equal(JSON.stringify(result).includes('PRIVATE'),false);
 }
});

test('landings retain the non-inserting honeypot and private keys remain rejected',async()=>{
 const {requests,fetchImpl}=fakeFetch();
 await checkAvailability(env,fetchImpl);
 const landing=requests.find(value=>value.url.pathname.endsWith('/lead_submit'));
 assert.equal(landing.init.body,JSON.stringify({p_lead:{website:'availability-check'}}));
 assert.equal(landing.init.method,'POST');
 await assert.rejects(checkAvailability({...env,VITE_SUPABASE_PUBLISHABLE_KEY:'sb_secret_private'},fetchImpl));
 await assert.rejects(checkAvailability({...env,APP_URL:'http://app.example.test/'},fetchImpl));
});
