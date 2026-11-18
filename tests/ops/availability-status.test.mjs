import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {checkAvailability,validBackupStatus} from '../../scripts/check-availability.mjs';

const NOW=Date.parse('2026-11-13T18:00:00.000Z');
const at=offset=>new Date(NOW+offset).toISOString();
const status=()=>({checked_at:at(-60_000),last_backup_utc:at(-30*60_000),healthy:true});
const key='sb_publishable_synthetic';
const env={BRON_AVAILABILITY_API_PUBLISHABLE_KEY:key};
const jwt=(role,alg='HS256')=>`${Buffer.from(JSON.stringify({alg,typ:'JWT'})).toString('base64url')}.${Buffer.from(JSON.stringify({role})).toString('base64url')}.fake_signature`;
const configuredFallback={app_url:'https://app.bronservis.ru/',api_url:'https://api.bronservis.ru',
 backup_status_url:'https://api.bronservis.ru/.well-known/bron-health.json',api_anon_key:jwt('anon')};

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
  assert.equal(request.url.origin,'https://api.bronservis.ru');
  assert.equal(request.init.headers,undefined);
  assert.equal(request.init.redirect,'error');
  assert.equal(request.init.cache,'no-store');
  assert.ok(request.init.signal instanceof AbortSignal);
 }
 const {fetchImpl}=fakeFetch({backupHttp:503,publicHttp:503});
 const result=await checkAvailability(env,fetchImpl);
 assert.equal(result.checks.backup.ok,true);
 for(const name of ['frontend','auth','data','landing'])assert.equal(result.checks[name].ok,false);
 assert.deepEqual(result.failed_checks,['frontend','auth','data','landing']);
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

test('the production monitor reaches the deployed app and never uses the legacy Pages or API variables',async()=>{
 const {requests,fetchImpl}=fakeFetch();
 const source={...env,APP_URL:'https://bronservis51-bot.github.io/bron-franchise/',
  VITE_SUPABASE_URL:'https://source.example.test',
  VITE_SUPABASE_PUBLISHABLE_KEY:'sb_publishable_legacy_source'};
 const result=await checkAvailability(source,fetchImpl);
 assert.equal(Object.values(result.checks).every(value=>value.ok),true);
 assert.deepEqual(result.failed_checks,[]);
 const backup=requests.find(value=>value.url.pathname==='/.well-known/bron-health.json');
 assert.equal(backup.url.origin,'https://api.bronservis.ru');
 assert.equal(backup.init.headers,undefined);
 assert.equal(requests.find(value=>value.url.pathname.endsWith('app-version.json')).url.href,
  'https://app.bronservis.ru/app-version.json');
 for(const request of requests.filter(value=>value.url.pathname.startsWith('/auth/')||value.url.pathname.startsWith('/rest/'))){
  assert.equal(request.url.origin,'https://api.bronservis.ru');
  assert.equal(request.init.headers.apikey,key);
 }
});

test('legacy backup overrides cannot change the pinned destination',async()=>{
 for(const value of ['http://api.bronservis.ru/.well-known/bron-health.json',
  'https://user:password@api.bronservis.ru/.well-known/bron-health.json',
  'https://api.bronservis.ru/private.json','https://other.example.test/.well-known/bron-health.json',
  'https://api.bronservis.ru/.well-known/bron-health.json?token=private',
  'https://api.bronservis.ru/.well-known/bron-health.json#private']){
  const {requests,fetchImpl}=fakeFetch();
  await checkAvailability({...env,BRON_BACKUP_STATUS_URL:value},fetchImpl);
  assert.equal(requests.find(request=>request.url.pathname==='/.well-known/bron-health.json').url.href,
   'https://api.bronservis.ru/.well-known/bron-health.json');
 }
});

test('the production legacy anon key keeps the landing probe non-inserting',async()=>{
 const {requests,fetchImpl}=fakeFetch();
 const anonKey=jwt('anon');
 await checkAvailability({BRON_AVAILABILITY_API_PUBLISHABLE_KEY:anonKey},fetchImpl);
 const landing=requests.find(value=>value.url.pathname.endsWith('/lead_submit'));
 assert.equal(landing.init.body,JSON.stringify({p_lead:{website:'availability-check'}}));
 assert.equal(landing.init.method,'POST');
 assert.equal(landing.init.headers.apikey,anonKey);
});

test('missing or privileged keys leave frontend and backup under monitoring and call no API routes',async()=>{
 for(const invalidKey of [undefined,'sb_secret_private',jwt('service_role'),jwt('authenticated'),jwt('anon','none')]){
  const {requests,fetchImpl}=fakeFetch({backupFailure:true});
  const result=await checkAvailability({BRON_AVAILABILITY_API_PUBLISHABLE_KEY:invalidKey},fetchImpl);
  assert.equal(result.checks.frontend.ok,true);
  assert.equal(result.checks.backup.ok,false);
  assert.deepEqual(result.failed_checks,['backup','api_config']);
  assert.deepEqual(requests.map(r=>r.url.pathname).sort(),['/.well-known/bron-health.json','/app-version.json']);
  assert.ok(requests.every(r=>r.init.headers===undefined));
 }
});

test('the fixed production anon fallback supplies the API key only without a configured override',async()=>{
 for(const [override,expected] of [['',configuredFallback.api_anon_key],[key,key]]){
  const {requests,fetchImpl}=fakeFetch();
  const result=await checkAvailability({BRON_AVAILABILITY_API_PUBLISHABLE_KEY:override},fetchImpl,configuredFallback);
  assert.deepEqual(result.failed_checks,[]);
  assert.equal(requests.filter(request=>request.init.headers?.apikey===expected).length,3);
 }
 const {requests,fetchImpl}=fakeFetch();
 const result=await checkAvailability({BRON_AVAILABILITY_API_PUBLISHABLE_KEY:jwt('service_role')},fetchImpl,configuredFallback);
 assert.deepEqual(result.failed_checks,['api_config']);
 assert.equal(requests.some(request=>request.init.headers?.apikey),false);
});

test('incorrect fallback origins, JWT algorithms and roles leave public probes in place',async()=>{
 for(const override of [{app_url:'https://elsewhere.example.test/'},{api_url:'https://elsewhere.example.test'},
  {backup_status_url:'https://api.bronservis.ru/other.json'},{api_anon_key:jwt('anon','none')},{api_anon_key:jwt('service_role')}]){
  const {requests,fetchImpl}=fakeFetch();
  const result=await checkAvailability({},fetchImpl,{...configuredFallback,...override});
  assert.deepEqual(result.failed_checks,['api_config']);
  assert.equal(requests.length,2);
  assert.ok(requests.every(request=>request.init.headers===undefined));
 }
});

test('the workflow entry point loads the pinned public config and exports only failed check codes',()=>{
 const temporary=mkdtempSync(join(tmpdir(),'bron-monitor-'));
 const output=join(temporary,'github-output');
 const report=join(temporary,'status.json');
 const mockFetch=`globalThis.fetch=async(target,init)=>{
  const url=new URL(target);
  if(url.pathname.endsWith('app-version.json'))return Response.json({build:new Date().toISOString()});
  if(url.pathname.endsWith('bron-health.json'))return Response.json({checked_at:new Date().toISOString(),last_backup_utc:new Date().toISOString(),healthy:true});
  if(!init.headers?.apikey||url.pathname.endsWith('/ping'))throw Error('PRIVATE_VALUE_MUST_NOT_ESCAPE');
  return Response.json(url.pathname.endsWith('/health')?{name:'GoTrue'}:{ok:true});
 };`;
 try{
  const script=fileURLToPath(new URL('../../scripts/check-availability.mjs',import.meta.url));
  const result=spawnSync(process.execPath,['--import',`data:text/javascript,${encodeURIComponent(mockFetch)}`,script],{
   encoding:'utf8',env:{...process.env,BRON_AVAILABILITY_API_PUBLISHABLE_KEY:'',GITHUB_OUTPUT:output,STATUS_OUTPUT:report},
  });
  assert.equal(result.status,1);
  assert.equal(readFileSync(output,'utf8'),'failed_checks=data\n');
  assert.deepEqual(JSON.parse(readFileSync(report,'utf8')).failed_checks,['data']);
  assert.equal(result.stdout.includes('PRIVATE'),false);
  assert.equal(result.stdout.includes('eyJ'),false);
  assert.equal(result.stderr,'');
 }finally{rmSync(temporary,{recursive:true,force:true});}
});
