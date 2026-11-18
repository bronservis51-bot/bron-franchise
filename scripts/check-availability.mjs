// No real submissions, passwords or personal data. A honeypot exercises the landing contract without inserting a lead.
import {appendFileSync,readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const APP_URL='https://app.bronservis.ru/';
const API_URL='https://api.bronservis.ru';
const BACKUP_STATUS_URL=`${API_URL}/.well-known/bron-health.json`;

function utcTime(value){
 if(typeof value!=='string')return NaN;
 const match=value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/);
 if(!match)return NaN;
 const time=Date.parse(value), canonical=`${match[1]}.${(match[2]??'').padEnd(3,'0').slice(0,3)}Z`;
 return Number.isFinite(time)&&new Date(time).toISOString()===canonical?time:NaN;
}

export function validBackupStatus(body,now=Date.now()){
 if(!body||typeof body!=='object'||Array.isArray(body)||body.healthy!==true||
   Object.keys(body).sort().join(',')!=='checked_at,healthy,last_backup_utc')return false;
 const checkedAge=now-utcTime(body.checked_at), backupAge=now-utcTime(body.last_backup_utc);
 return checkedAge>=-60_000&&checkedAge<=25*60_000&&backupAge>=-60_000&&backupAge<=70*60_000;
}

async function backupJson(response){
 const reader=response.body?.getReader();
 if(!reader)throw Error('Missing status body');
 const chunks=[];let bytes=0;
 try{
  while(true){
   const {done,value}=await reader.read();
   if(done)break;
   bytes+=value.byteLength;
   if(bytes>1024){await reader.cancel();throw Error('Status body too large');}
   chunks.push(value);
  }
 }finally{reader.releaseLock();}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function isLegacyAnonKey(key){
 if(typeof key!=='string'||key.length>4096||!/^[-\w]+\.[-\w]+\.[-\w]+$/.test(key))return false;
 const [header,payload]=key.split('.');
 try{
  return JSON.parse(Buffer.from(header,'base64url').toString('utf8'))?.alg==='HS256'&&
    JSON.parse(Buffer.from(payload,'base64url').toString('utf8'))?.role==='anon';
 }
 catch{return false;}
}

function isPublicApiKey(key){
 return typeof key==='string'&&key.length<=4096&&(/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)||isLegacyAnonKey(key));
}

function fallbackApiKey(config){
 if(config?.app_url===APP_URL&&config.api_url===API_URL&&config.backup_status_url===BACKUP_STATUS_URL&&isLegacyAnonKey(config.api_anon_key)){
  return config.api_anon_key;
 }
}

function readPublicConfig(){
 try{return JSON.parse(readFileSync(new URL('../deploy/timeweb/availability-public.json',import.meta.url),'utf8'));}
 catch{return null;}
}

export async function checkAvailability(env=process.env,fetchImpl=fetch,publicConfig=null){
 const key=env.BRON_AVAILABILITY_API_PUBLISHABLE_KEY||fallbackApiKey(publicConfig);
 async function check(target,init,valid,statuses){
  const start=Date.now();
  try{
   const r=await fetchImpl(target,{...init,signal:AbortSignal.timeout(20_000),redirect:'error',cache:'no-store'});
   let body;try{body=await(statuses?backupJson(r):r.json());}catch{}
   return {ok:(statuses?statuses.includes(r.status):r.ok)&&valid(body),http:r.status,ms:Date.now()-start};
  }catch{return{ok:false,http:0,ms:Date.now()-start};}
 }
 const probes={
  frontend:check(new URL('app-version.json',APP_URL),{},b=>typeof b?.build==='string'&&Number.isFinite(Date.parse(b.build))),
  backup:check(BACKUP_STATUS_URL,{},validBackupStatus,[200,503]),
 };
 if(isPublicApiKey(key)){
  const headers={apikey:key,'Content-Type':'application/json'};
  probes.auth=check(`${API_URL}/auth/v1/health`,{headers},b=>b?.name==='GoTrue');
  probes.data=check(`${API_URL}/rest/v1/rpc/ping`,{method:'POST',headers,body:'{}'},b=>b==='ok');
  probes.landing=check(`${API_URL}/rest/v1/rpc/lead_submit`,{method:'POST',headers,body:JSON.stringify({p_lead:{website:'availability-check'}})},b=>b?.ok===true);
 }else{
  probes.api_config=Promise.resolve({ok:false,http:0,ms:0});
 }
 const checks=Object.fromEntries(await Promise.all(Object.entries(probes).map(async ([name,result])=>[name,await result])));
 const failed_checks=Object.keys(checks).filter(name=>!checks[name].ok);
 return {checked_at:new Date().toISOString(),checks,failed_checks};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const report=await checkAvailability(process.env,fetch,readPublicConfig());
 writeFileSync(process.env.STATUS_OUTPUT??'/tmp/bron-status.json',JSON.stringify(report,null,2)+'\n');
 if(process.env.GITHUB_OUTPUT)appendFileSync(process.env.GITHUB_OUTPUT,`failed_checks=${report.failed_checks.join(',')}\n`);
 console.log(JSON.stringify(report));
 if(report.failed_checks.length)process.exitCode=1;
}
