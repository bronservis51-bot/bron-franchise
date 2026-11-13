// No real submissions, passwords or personal data. A honeypot exercises the landing contract without inserting a lead.
import {writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

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

export async function checkAvailability(env=process.env,fetchImpl=fetch){
 const url=env.VITE_SUPABASE_URL, key=env.VITE_SUPABASE_PUBLISHABLE_KEY;
 const appUrl=new URL(env.APP_URL || 'https://bronservis51-bot.github.io/bron-franchise/');
 if(appUrl.protocol!=='https:'||appUrl.username||appUrl.password||appUrl.search||appUrl.hash)throw Error('APP_URL must be a public HTTPS application base URL');
 if(!appUrl.pathname.endsWith('/'))appUrl.pathname+='/';
 if(!url?.startsWith('https://')||!key||key.startsWith('sb_secret_'))throw Error('Public connection variables are missing or invalid');
 async function check(target,init,valid,statuses){
  const start=Date.now();
  try{
   const r=await fetchImpl(target,{...init,signal:AbortSignal.timeout(20_000),redirect:'error',cache:'no-store'});
   let body;try{body=await(statuses?backupJson(r):r.json());}catch{}
   return {ok:(statuses?statuses.includes(r.status):r.ok)&&valid(body),http:r.status,ms:Date.now()-start};
  }catch{return{ok:false,http:0,ms:Date.now()-start};}
 }
 const headers={apikey:key,'Content-Type':'application/json'};
 const [frontend,auth,data,landing,backup]=await Promise.all([
  check(new URL('app-version.json',appUrl),{},b=>typeof b?.build==='string'&&Number.isFinite(Date.parse(b.build))),
  check(`${url}/auth/v1/health`,{headers},b=>b?.name==='GoTrue'),
  check(`${url}/rest/v1/rpc/ping`,{method:'POST',headers,body:'{}'},b=>b==='ok'),
  check(`${url}/rest/v1/rpc/lead_submit`,{method:'POST',headers,body:JSON.stringify({p_lead:{website:'availability-check'}})},b=>b?.ok===true),
  check(new URL('/.well-known/bron-health.json',url),{},validBackupStatus,[200,503]),
 ]);
 return {checked_at:new Date().toISOString(),checks:{frontend,auth,data,landing,backup}};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const report=await checkAvailability();
 writeFileSync(process.env.STATUS_OUTPUT??'/tmp/bron-status.json',JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify(report));
 if(Object.values(report.checks).some(v=>!v.ok))process.exitCode=1;
}
