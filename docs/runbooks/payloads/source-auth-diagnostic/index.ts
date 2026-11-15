// Fixed one-shot Auth diagnosis only. No arbitrary SQL, values, writes or logging.
import pg from "npm:pg@8.23.1";
import {lookup} from "node:dns/promises";
import {captureAuthDiagnostic} from "./t58-auth-diagnostic-core.mjs";
import {encryptDiagnostic} from "./t58-encrypt-diagnostic.mjs";
import {freshOwnerWitnessSql,validateFenceContext,validateFenceWitness} from "./fence-witness.mjs";
const CAPABILITY_SHA256="{{CAPABILITY_SHA256}}";
const EXPIRES_EPOCH_MS=Number("{{EXPIRES_EPOCH_MS}}");
const FENCE_CONTEXT:unknown={{FENCE_CONTEXT_JSON}};
const FENCE_CONTEXT_SHA256="{{FENCE_CONTEXT_SHA256}}";
const PROJECT="vkkqffvmztpzgygzfxhq",PROTOCOL="BRON_AUTH_DIAGNOSTIC_V1";
const reply=(value:Record<string,unknown>,status=200)=>Response.json({protocol:PROTOCOL,...value},{status,
 headers:{"Cache-Control":"no-store","Content-Type":"application/json"}});
Deno.serve(async(req)=>{
 const started=Date.now(),clients=new Set<InstanceType<typeof pg.Client>>(),capability=new Uint8Array(64);
 let stage="authorization",timer:ReturnType<typeof setTimeout>|undefined,reader:ReadableStreamDefaultReader<Uint8Array>|undefined,stopped=false;
 const deadline=Math.min(started+90000,Number.isSafeInteger(EXPIRES_EPOCH_MS)?EXPIRES_EPOCH_MS:started);
 const stop=()=>{stopped=true;reader?.cancel().catch(()=>{});for(const c of clients)c.connection?.stream?.destroy();};
 const check=()=>{if(stopped||req.signal.aborted||Date.now()>=deadline)throw Error('deadline');};
 const run=async()=>{
  if(req.method!=="POST"||new URL(req.url).search||!/^[a-f0-9]{64}$/.test(CAPABILITY_SHA256)||
   !Number.isSafeInteger(EXPIRES_EPOCH_MS)||EXPIRES_EPOCH_MS<=started||EXPIRES_EPOCH_MS-started>7200000||req.signal.aborted)
   return reply({ok:false},403);
  if(req.headers.has('content-length')&&req.headers.get('content-length')!=='64')return reply({ok:false},403);
  reader=req.body?.getReader();if(!reader)return reply({ok:false},403);let length=0;
  for(;;){const part=await reader.read();check();if(part.done)break;if(length+part.value.length>64)return reply({ok:false},403);
   capability.set(part.value,length);length+=part.value.length;}
  if(length!==64||!capability.every(b=>b>=48&&b<=57||b>=97&&b<=102))return reply({ok:false},403);
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',capability));let mismatch=0;
  for(let i=0;i<32;i++)mismatch|=hash[i]^parseInt(CAPABILITY_SHA256.slice(i*2,i*2+2),16);
  if(mismatch)return reply({ok:false},403);
  stage='fence-context';const context=await validateFenceContext(FENCE_CONTEXT,FENCE_CONTEXT_SHA256);check();
  stage='configuration';const u=new URL(Deno.env.get('SUPABASE_DB_URL')??''),host=u.hostname,port=Number(u.port||5432),user=decodeURIComponent(u.username);
  const direct=host===`db.${PROJECT}.supabase.co`&&user==='postgres'&&port===5432;
  const pooler=/^aws-[0-2]-us-west-2\.pooler\.supabase\.com$/.test(host)&&user===`postgres.${PROJECT}`&&[5432,6543].includes(port);
  if(!['postgres:','postgresql:'].includes(u.protocol)||(!direct&&!pooler)||u.pathname!=='/postgres'||!u.password||u.hash)throw Error('scope');
  stage='dns';const {address}=await lookup(host);check();
  const makeClient=(servername:string)=>{const c=new pg.Client({host:address,port,user,password:decodeURIComponent(u.password),database:'postgres',
   ssl:{rejectUnauthorized:true,servername},connectionTimeoutMillis:6000,query_timeout:6000,application_name:'bron-source-auth-diagnostic'});
   c.on('error',()=>{});clients.add(c);return c;};
  stage='tls-negative';const negative=makeClient('bron-tls-negative.invalid');let rejected=false;
  try{await negative.connect();}catch(e){rejected=/cert|NotValidForName|dnsname|hostname/i.test(String(e instanceof Error?e.message:e));}
  finally{negative.connection?.stream?.destroy();negative.end().catch(()=>{});}check();if(!rejected)throw Error('tls-verification');
  stage='connect';const c=makeClient(host);await c.connect();check();let began=false;
  try{
   await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');began=true;
   await c.query("SET LOCAL statement_timeout='5s';SET LOCAL lock_timeout='5s';SET LOCAL idle_in_transaction_session_timeout='10s';SET LOCAL timezone='UTC';SET LOCAL search_path=pg_catalog");
   stage='fence-witness';const witness=validateFenceWitness(context,(await c.query(freshOwnerWitnessSql)).rows[0]?.witness);check();
   stage='identity';const identity=(await c.query(`SELECT current_database() AS database,current_user AS role,session_user AS session_role,
    (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner,
    current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation,
    current_setting('statement_timeout') AS statement_timeout,current_setting('idle_in_transaction_session_timeout') AS idle_timeout,
    pg_backend_pid() AS pid,host(inet_server_addr()) AS server_address,clock_timestamp()::text AS database_time`)).rows[0];
   if(!identity||['database','role','session_role','owner'].some(k=>identity[k]!=='postgres')||identity.read_only!=='on'||
    identity.isolation!=='repeatable read'||identity.statement_timeout!=='5s'||identity.idle_timeout!=='10s'||identity.pid!==witness.pid)throw Error('identity');
   stage='auth-diagnostic';const data=await captureAuthDiagnostic({query:async(sql:string)=>{check();const out=await c.query(sql);check();return out;}});
   check();await c.query('ROLLBACK');began=false;check();stage='encryption';
   return reply(await encryptDiagnostic({ok:true,protocol:PROTOCOL,projectRef:PROJECT,started_epoch_ms:started,finished_epoch_ms:Date.now(),
    expires_epoch_ms:EXPIRES_EPOCH_MS,tls_negative_rejected:true,tls_verification:'native-ca-and-hostname',identity,fenceWitness:witness,data},capability,CAPABILITY_SHA256));
  }finally{if(began)await c.query('ROLLBACK').catch(()=>{});}
 };
 req.signal.addEventListener('abort',stop,{once:true});
 try{return await Promise.race([run(),new Promise<Response>(resolve=>{timer=setTimeout(()=>{stop();resolve(reply({ok:false,stage:'deadline',code:'READER_DEADLINE'},504));},Math.max(1,deadline-Date.now()));})]);}
 catch{return reply({ok:false,stage,code:'READER_FAILED'},502);}
 finally{clearTimeout(timer);req.signal.removeEventListener('abort',stop);stop();capability.fill(0);for(const c of clients)c.end().catch(()=>{});}
});
