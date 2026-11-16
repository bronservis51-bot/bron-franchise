// T33 continuation: unchanged tested T30/T31 Auth algorithm, only task/guard/result namespace changes.
// Run only after a different canonical peer has passed the complete synthetic response sequence.
// Real records remain in VPS RAM. No updates, freeze, preview or publication.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {captureAuthRows,authRowsPlan} from './t30-auth-compact.mjs';
import {validatedSourcePeerConfig} from './t31-source-network.mjs';

const PRIVATE='/root/bron-secrets',RUNTIME='/opt/bron/audit-runtime-c128f9b';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const PINS={
 'migration-audit.mjs':'a5306390fa06db03665caaaa988cadf472f17c349538712f03fa31f794d6bdea',
 'migration-source.mjs':'c13f82606d1ebf4a45fd459d0d5b5354b062076b7c8bb27a47c66ee5519b347b',
 'database-config.mjs':'1064d54299d354ec7951f40b719ce6886b78ddd00b2f2ac234c0024a8fbd55e6',
};
export function verifiedNetworkResult(value,now=Date.now()){
 const end=Date.parse(value?.finishedUtc),start=Date.parse(value?.startedUtc);
 if(value?.task!=='T33'||value.status!=='PASS'||value.canonicalHost!=='aws-1-us-west-2.pooler.supabase.com'||
   !Array.isArray(value.resolvedAddresses)||!value.resolvedAddresses.includes(value.selectedPeerIPv4)||
   !Number.isFinite(start)||!Number.isFinite(end)||end<start||end>now+5000||now-end>600000||
   !['baseline','temporary-mtu1280-advmss1200'].includes(value.transport)||
   value.retainedRoute!==(value.transport==='temporary-mtu1280-advmss1200'))
   fail('T33_AUTH_NETWORK_PASS_REQUIRED');
 return value;
}
function privateRead(filename){
 const fd=fs.openSync(filename,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
 try{const s=fs.fstatSync(fd);
  if(!s.isFile()||s.uid!==0||s.nlink!==1||(s.mode&0o777)!==0o600||s.size>65536)fail('T33_AUTH_PRIVATE_RESULT_UNSAFE');
  return fs.readFileSync(fd);
 }finally{fs.closeSync(fd);}
}
const safe=error=>/^(?:T3[13]_|AUTH_PLAN_|SOURCE_|MIGRATION_)[A-Z0-9_]+$/.test(error?.code??'')?error.code:
 /^[0-9A-Z]{5}$/.test(error?.code??'')?error.code:error?.message==='Query read timeout'?'PG_QUERY_READ_TIMEOUT':
 error?.code==='EEXIST'?'T33_AUTH_ALREADY_STARTED':
 ['ECONNRESET','ECONNREFUSED','ETIMEDOUT','EPIPE','ENETUNREACH','EHOSTUNREACH','EAI_AGAIN'].includes(error?.code)?error.code:'T33_AUTH_FAILED';

async function main(){let source,target,phase='preflight';
 const deadline=setTimeout(()=>{source?.connection?.stream?.destroy();target?.connection?.stream?.destroy();
  console.error('T33_AUTH_BLOCKED',JSON.stringify({phase,code:'T33_AUTH_DEADLINE'}));process.exit(2);},90000);deadline.unref();
 try{
  if(process.argv.length!==2||process.platform!=='linux'||process.getuid?.()!==0)fail('T33_AUTH_VPS_ONLY');
  execFileSync('/usr/bin/prlimit',['--pid',String(process.pid),'--core=0:0'],{stdio:'ignore'});
  const d=fs.lstatSync(PRIVATE);if(!d.isDirectory()||d.isSymbolicLink()||d.uid!==0||(d.mode&0o777)!==0o700)fail('T33_AUTH_PRIVATE_DIRECTORY');
  const raw=privateRead(PRIVATE+'/t33-source-network-result.json');
  const network=verifiedNetworkResult(JSON.parse(raw));
  for(const [name,digest] of Object.entries(PINS))if(createHash('sha256').update(fs.readFileSync(RUNTIME+'/scripts/'+name)).digest('hex')!==digest)fail('T33_AUTH_RUNTIME_SHA');
  if(JSON.parse(fs.readFileSync(RUNTIME+'/node_modules/pg/package.json','utf8')).version!=='8.23.1')fail('T33_AUTH_DRIVER_VERSION');
  const {sourceServiceConfig,assertMigrationTarget}=await import(RUNTIME+'/scripts/migration-source.mjs');
  const {databaseConfig}=await import(RUNTIME+'/scripts/database-config.mjs');
  const {default:pg}=await import(RUNTIME+'/node_modules/pg/lib/index.js');
  const sourceConfig=validatedSourcePeerConfig(sourceServiceConfig(),{
   canonicalHost:network.canonicalHost,address:network.selectedPeerIPv4,resolvedAddresses:network.resolvedAddresses});
  const records=JSON.parse(execFileSync('/usr/bin/docker',['--host','unix:///var/run/docker.sock','inspect','supabase-db'],
   {encoding:'utf8',timeout:15000,maxBuffer:1048576,stdio:['ignore','pipe','ignore']}));
  const c=records[0];if(records.length!==1||c?.Name!=='/supabase-db'||!c.State?.Running)fail('T33_AUTH_TARGET_CONTAINER');
  const v={};for(const entry of c.Config?.Env??[]){const i=entry.indexOf('='),key=entry.slice(0,i);
   if(!['POSTGRES_PASSWORD','PGPASSWORD','POSTGRES_USER','POSTGRES_DB'].includes(key))continue;
   if(Object.hasOwn(v,key))fail('T33_AUTH_TARGET_DUPLICATE');v[key]=entry.slice(i+1);}
  if(!v.POSTGRES_PASSWORD||v.PGPASSWORD!==v.POSTGRES_PASSWORD||v.POSTGRES_USER!=='supabase_admin'||v.POSTGRES_DB!=='postgres')fail('T33_AUTH_TARGET_CONFIG');
  const addresses=Object.values(c.NetworkSettings?.Networks??{}).map(x=>x.IPAddress).filter(Boolean);
  if(!addresses.length)fail('T33_AUTH_TARGET_ADDRESS');
  const url=new URL('postgresql://supabase_admin@127.0.0.1:15433/postgres?sslmode=disable');
  url.password=encodeURIComponent(v.POSTGRES_PASSWORD);assertMigrationTarget(url.href);
  // Guard is durable BEFORE any connection; a failed launch never grants another attempt.
  const guard=fs.openSync(PRIVATE+'/t33-auth-verified-peer.guard.json','wx',0o600);
  try{fs.writeFileSync(guard,JSON.stringify({task:'T33',action:'auth_verified_peer',startedUtc:new Date().toISOString(),
   networkResultSha256:createHash('sha256').update(raw).digest('hex')})+'\n');fs.fsyncSync(guard);}finally{fs.closeSync(guard);}
  const directory=fs.openSync(PRIVATE,fs.constants.O_RDONLY);try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
  source=new pg.Client(sourceConfig);target=new pg.Client({...databaseConfig(url.href,{BRON_DB_ALLOW_LOCAL_PLAIN:'1'}),
   options:'-c default_transaction_read_only=on',query_timeout:20000});
  for(const db of [source,target])db.on('error',()=>{});
  phase='connect';await source.connect();await target.connect();
  const verify=side=>async db=>{
   await db.query("SET LOCAL idle_in_transaction_session_timeout='10000'");
   const r=(await db.query(`SELECT current_database() AS db,current_user AS role,current_setting('transaction_read_only') AS mode,
    current_setting('transaction_isolation') AS isolation,host(inet_server_addr()) AS address,inet_server_port() AS port`+
    (side==='target'?`,current_setting('cron.launch_active_jobs') AS cron,current_setting('pg_net.batch_size') AS net`:''))).rows[0];
   if(r?.db!=='postgres'||r.role!==(side==='source'?'postgres':'supabase_admin')||r.mode!=='on'||r.isolation!=='repeatable read')fail('T33_AUTH_IDENTITY');
   if(side==='target'&&(!addresses.includes(r.address)||r.port!==5432||r.cron!=='off'||r.net!=='0'))fail('T33_AUTH_TARGET_ISOLATION');
  };
  const step=side=>item=>console.log('T33_AUTH_STEP',JSON.stringify({side,...item}));
  phase='source-readonly';const a=await captureAuthRows(source,verify('source'),step('source'));
  phase='target-readonly';const b=await captureAuthRows(target,verify('target'),step('target'));
  console.log('T33_AUTH_PLAN',JSON.stringify({...authRowsPlan(a.rows,b.rows),
   sourceWindow:{startedUtc:a.startedUtc,finishedUtc:a.finishedUtc},targetWindow:{startedUtc:b.startedUtc,finishedUtc:b.finishedUtc}}));
 }catch(error){console.error('T33_AUTH_BLOCKED',JSON.stringify({phase,code:safe(error),step:error.authStep??null,elapsedMs:error.authElapsedMs??null}));process.exitCode=2;}
 finally{for(const db of [source,target])db?.connection?.stream?.destroy();await Promise.allSettled([source?.end(),target?.end()]);clearTimeout(deadline);}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
