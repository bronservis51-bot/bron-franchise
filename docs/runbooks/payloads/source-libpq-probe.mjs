// One reviewed VPS-only libpq diagnosis. Synthetic bytes only; never a migration runner.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash,randomBytes} from 'node:crypto';
import {networkInterfaces} from 'node:os';
import {lookup} from 'node:dns/promises';
import {spawn,execFileSync} from 'node:child_process';
import {SOURCE_HOST,validatedSourcePeerConfig} from './t31-source-network.mjs';

const PRIVATE='/root/bron-secrets',RUNTIME='/opt/bron/audit-runtime-c128f9b',MANIFEST=PRIVATE+'/source-libpq-reviewed.json';
const LABEL='bron.source-libpq-probe',SOCKET='unix:///var/run/docker.sock',sha=b=>createHash('sha256').update(b).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
export const stages=Object.freeze([{name:'first512',bytes:512,rows:1},{name:'single128',bytes:128,rows:1},
 {name:'repeat128x10',bytes:128,rows:10},{name:'single1MiB',bytes:1048576,rows:1}]);
export const syntheticSql=`\\conninfo
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout='5000';
SET LOCAL idle_in_transaction_session_timeout='10000';
\\echo LP:identity
SELECT 'identity',current_database()='postgres',current_user='postgres',current_setting('transaction_read_only')='on',current_setting('transaction_isolation')='repeatable read',current_setting('statement_timeout')='5s',current_setting('idle_in_transaction_session_timeout')='10s';
${stages.map(s=>`\\echo LP:${s.name}\nSELECT repeat('x',${s.bytes}) FROM generate_series(1,${s.rows});`).join('\n')}
ROLLBACK;
\\echo LP:complete
`;
export class SyntheticOutputParser {
 constructor(onPhase=()=>{}){this.pending='';this.total=0;this.phase='connect';this.counts={};this.tls=false;this.preamble=0;this.onPhase=onPhase;}
 push(bytes){this.total+=bytes.length;if(this.total>2097152)fail('LIBPQ_STDOUT_LIMIT');const lines=bytes.toString('latin1').split('\n');
  for(let i=0;i<lines.length;i++){this.pending+=lines[i];if(i<lines.length-1){this.line(this.pending);this.pending='';}}}
 line(line){
  if(line.startsWith('LP:')){const next=line.slice(3),order=['identity',...stages.map(s=>s.name),'complete'],index=order.indexOf(next);
   if(index<0||(index===0?this.phase!=='connect':this.phase!==order[index-1])||(this.phase==='identity'&&this.counts.identity!==1)||
     (stages.find(s=>s.name===this.phase)&&this.counts[this.phase]!==stages.find(s=>s.name===this.phase).rows)||
     (next==='identity'&&!this.tls))fail('LIBPQ_PHASE_INVALID');
   this.phase=next;this.onPhase(next);return;
  }
  if(this.phase==='connect'){this.preamble+=line.length+1;if(this.preamble>4096)fail('LIBPQ_PREAMBLE_LIMIT');
   if(/^SSL connection \(protocol: TLSv1\.[23], cipher: [A-Za-z0-9_-]+, compression: (?:off|on)(?:, ALPN: [A-Za-z0-9_-]+)?\)$/.test(line))this.tls=true;return;}
  if(this.phase==='identity'){if(line!=='identity|t|t|t|t|t|t'||this.counts.identity)fail('LIBPQ_IDENTITY_INVALID');this.counts.identity=1;return;}
  const stage=stages.find(s=>s.name===this.phase);
  if(!stage||line.length!==stage.bytes||!/^[x]+$/.test(line)||(this.counts[stage.name]??0)>=stage.rows)fail('LIBPQ_SYNTHETIC_INVALID');
  this.counts[stage.name]=(this.counts[stage.name]??0)+1;
 }
 finish(){if(this.pending||this.phase!=='complete'||!this.tls)fail('LIBPQ_TRUNCATED');return {frontendTls:true,readOnly:true,repeatableRead:true,
  statementDeadlineMs:5000,idleDeadlineMs:10000,rows:stages.map(s=>({phase:s.name,rows:this.counts[s.name],bytesPerRow:s.bytes})),bulkBytes:1048576};}
}
export function pgpassField(value){if(typeof value!=='string'||!value||/[\x00\r\n]/.test(value))fail('LIBPQ_CREDENTIAL_INVALID');return value.replace(/\\/g,'\\\\').replace(/:/g,'\\:');}
export function credentialFiles(config,peer,password){
 const selected=validatedSourcePeerConfig(config,peer);if(typeof selected.ssl.ca!=='string'&&!Buffer.isBuffer(selected.ssl.ca))fail('LIBPQ_CA_INVALID');
 return {pgpass:[SOURCE_HOST,'6543','postgres',selected.user,password].map(pgpassField).join(':')+'\n',ca:selected.ssl.ca,
  service:`[source]\nhost=${SOURCE_HOST}\nhostaddr=${peer.address}\nport=6543\ndbname=postgres\nuser=${selected.user}\nsslmode=verify-full\nsslrootcert=/bron-probe/ca.crt\nconnect_timeout=5\napplication_name=bron_source_libpq_synthetic\n`};
}
export function validateManifest(bytes,expected,selfHash){
 if(!/^[0-9a-f]{64}$/.test(expected??'')||sha(bytes)!==expected)fail('LIBPQ_MANIFEST_SHA');let m;try{m=JSON.parse(bytes);}catch{fail('LIBPQ_MANIFEST_INVALID');}
 if(Object.keys(m??{}).sort().join(',')!=='address,canonicalHost,expiresUtc,helperSha256,resolvedAddresses,targetImage,task'||m.task!=='SOURCE_LIBPQ_SYNTHETIC_V1'||
   m.helperSha256!==selfHash||!Array.isArray(m.resolvedAddresses)||m.resolvedAddresses.length<1||m.resolvedAddresses.length>8||!m.resolvedAddresses.every(x=>typeof x==='string')||!m.resolvedAddresses.includes(m.address)||!/^sha256:[0-9a-f]{64}$/.test(m.targetImage??'')||m.canonicalHost!==SOURCE_HOST||
   !Number.isFinite(Date.parse(m.expiresUtc))||Date.parse(m.expiresUtc)<=Date.now()||Date.parse(m.expiresUtc)>Date.now()+86400000)fail('LIBPQ_MANIFEST_INVALID');
 // Peer validity is checked by the existing pinned source validator before credentials are requested.
 return m;
}
const safeCode=e=>/^LIBPQ_[A-Z0-9_]+$/.test(e?.code??'')?e.code:'LIBPQ_PROBE_FAILED';
function privatePath(filename,directory=false){const s=fs.lstatSync(filename);if((directory?!s.isDirectory():!s.isFile())||s.uid!==0||(s.mode&0o777)!==(directory?0o700:0o600)||(!directory&&s.nlink!==1))fail('LIBPQ_PRIVATE_PATH_UNSAFE');}
export function privateWrite(filename,data){const fd=fs.openSync(filename,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try{fs.fchmodSync(fd,0o600);fs.writeFileSync(fd,data);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const d=fs.openSync(path.dirname(filename),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);try{fs.fsyncSync(d);}finally{fs.closeSync(d);}}
// Key-only Docker env flags remove inherited image defaults when the clean host env lacks each key.
export const unsetPgEnvironment=Object.freeze(['PGPASSWORD','PGOPTIONS','PGSSLMODE','PGSSLROOTCERT','PGSSLCERT','PGSSLKEY','PGSSLCRL',
 'PGSSLCRLDIR','PGSSLCOMPRESSION','PGSSLSNI','PGREQUIRESSL','PGSSLNEGOTIATION','PGSSLMINPROTOCOLVERSION','PGSSLMAXPROTOCOLVERSION']);
export function clientArgs({image,name,nonce,directory}){
 if(!/^sha256:[0-9a-f]{64}$/.test(image)||!/^bron-libpq-[0-9a-f]{32}$/.test(name)||!/^[0-9a-f]{32}$/.test(nonce)||name!=='bron-libpq-'+nonce||!/^\/root\/bron-secrets\/libpq-[A-Za-z0-9]+$/.test(directory))fail('LIBPQ_CLIENT_ARGUMENT_INVALID');
 return ['run','--interactive','--rm','--pull=never','--name',name,'--label',LABEL+'='+nonce,'--network','host','--read-only','--cap-drop=ALL',
  '--security-opt=no-new-privileges','--user','0','--restart=no','--log-driver=none','--pids-limit','32','--memory','64m',
  '--tmpfs','/var/lib/postgresql/data:rw,nosuid,nodev,noexec,size=1m,mode=0700','--mount',`type=bind,src=${directory},dst=/bron-probe,readonly`,
  ...unsetPgEnvironment.flatMap(key=>['-e',key]),'-e','PGSERVICEFILE=/bron-probe/service','-e','PGPASSFILE=/bron-probe/pgpass','-e','PGSERVICE=source',
  '-e','LANG=C','-e','LC_ALL=C','--entrypoint','psql',image,'-X','-w','-q','-A','-t','-v','ON_ERROR_STOP=1'];
}
export function ownedContainer(record,name,nonce){return record?.Name==='/'+name&&record?.Config?.Labels?.[LABEL]===nonce&&/^bron-libpq-[0-9a-f]{32}$/.test(name)&&name==='bron-libpq-'+nonce&&/^[0-9a-f]{64}$/.test(record.Id??'');}
export async function runSyntheticClient({docker,args,env,deadlineMs=35000,phaseMs=7000,spawnClient=spawn,signal}){
 let child,timer,phaseTimer,phase='connect',settled=false,closed=false;const started=performance.now();let phaseStarted=started;const timings=[];
 const parser=new SyntheticOutputParser(next=>{timings.push({phase,elapsedMs:Math.round(performance.now()-phaseStarted)});phase=next;phaseStarted=performance.now();arm();});
 const progress=()=>({frontendTls:parser.tls,identityVerified:parser.counts.identity===1,rowsCompleted:stages.map(s=>({phase:s.name,rows:parser.counts[s.name]??0,expectedRows:s.rows,bytesPerRow:s.bytes})),
  elapsedMs:Math.round(performance.now()-started),phaseTimings:[...timings,{phase,elapsedMs:Math.round(performance.now()-phaseStarted)}]});
 const arm=()=>{clearTimeout(phaseTimer);phaseTimer=setTimeout(()=>abort('LIBPQ_PHASE_TIMEOUT'),phaseMs);};
 let abort;const onAbort=()=>abort('LIBPQ_INTERRUPTED');try{return await new Promise((resolve,reject)=>{
  abort=code=>{if(settled)return;settled=true;child?.kill('SIGKILL');reject(Object.assign(new Error(code),{code,phase,progress:progress()}));};
  child=spawnClient(docker,['--host',SOCKET,...args],{env,stdio:['pipe','pipe','pipe']});arm();timer=setTimeout(()=>abort('LIBPQ_WALL_DEADLINE'),deadlineMs);
  if(signal?.aborted){abort('LIBPQ_INTERRUPTED');return;}signal?.addEventListener('abort',onAbort,{once:true});
  child.on('error',()=>abort('LIBPQ_CLIENT_SPAWN'));child.stdin.on('error',()=>{});let stderrBytes=0;
  child.stderr.on('data',b=>{stderrBytes+=b.length;if(stderrBytes>65536)abort('LIBPQ_STDERR_LIMIT');});
  child.stdout.on('data',b=>{try{parser.push(b);}catch(e){abort(safeCode(e));}});
  child.on('close',code=>{closed=true;if(settled)return;settled=true;try{if(code!==0)fail('LIBPQ_PSQL_EXIT');resolve(parser.finish());}catch(e){e.phase=phase;e.progress=progress();reject(e);}});
  child.stdin.end(syntheticSql);
 });}finally{clearTimeout(timer);clearTimeout(phaseTimer);signal?.removeEventListener('abort',onAbort);if(child&&!closed){await new Promise(resolve=>{const t=setTimeout(resolve,250);child.once('close',()=>{clearTimeout(t);resolve();});});}}
}
async function main(){
 const started=performance.now(),controller=new AbortController(),onSignal=()=>controller.abort();process.on('SIGTERM',onSignal);process.on('SIGINT',onSignal);
 let directory,docker,env,name,nonce,guard=false,phase='activation',result={status:'BLOCKED',sourceDataRead:false,macDataTransit:false};
 const command=args=>{try{return execFileSync(docker,['--host',SOCKET,...args],{env,encoding:'utf8',timeout:2000,maxBuffer:262144,stdio:['ignore','pipe','pipe']});}catch{fail('LIBPQ_DOCKER_COMMAND');}};
 try{
  if(process.argv.length!==6||process.argv[2]!=='--manifest'||process.argv[3]!==MANIFEST||process.argv[4]!=='--manifest-sha256')fail('LIBPQ_EXPLICIT_REVIEW_REQUIRED');
  if(process.platform!=='linux'||process.getuid?.()!==0||!Object.values(networkInterfaces()).flat().some(i=>i?.address==='152.228.115.115'))fail('LIBPQ_VPS_ROOT_REQUIRED');
  privatePath(PRIVATE,true);privatePath(MANIFEST);const self=fileURLToPath(import.meta.url),m=validateManifest(fs.readFileSync(MANIFEST),process.argv[5],sha(fs.readFileSync(self)));
  const pins={
   [RUNTIME+'/scripts/migration-source.mjs']:'c13f82606d1ebf4a45fd459d0d5b5354b062076b7c8bb27a47c66ee5519b347b',
   [PRIVATE+'/t31-source-network.mjs']:'9ef0c3e8c32626b7760e307efc57f26c033affddeef43f4841e70ebb5a2f8472',
   [PRIVATE+'/t30-auth-compact.mjs']:'0e34802b3308df318a210a55bc2f379c517554fa9d73775453738adb371ae661'};
  // The t31 hash is generated from the reviewed checkout; a mismatched deployment blocks.
  for(const [file,expected]of Object.entries(pins))if(sha(fs.readFileSync(file))!==expected)fail('LIBPQ_DEPENDENCY_SHA');
  if(fs.existsSync(PRIVATE+'/source-libpq-probe-result.json'))fail('LIBPQ_PRIOR_STATE_RECONCILIATION');
  nonce=randomBytes(16).toString('hex');name='bron-libpq-'+nonce;
  try{privateWrite(PRIVATE+'/source-libpq-probe.guard',JSON.stringify({task:m.task,manifestSha256:process.argv[5],nonce,startedUtc:new Date().toISOString()})+'\n');}catch(e){if(e.code==='EEXIST')fail('LIBPQ_PRIOR_STATE_RECONCILIATION');throw e;}guard=true;
  phase='preflight';execFileSync('/usr/bin/prlimit',['--pid',String(process.pid),'--core=0:0'],{stdio:'ignore',timeout:1000});
  docker=['/usr/bin/docker','/usr/local/bin/docker'].find(p=>{try{const s=fs.statSync(p);return s.isFile()&&s.uid===0&&!(s.mode&0o022);}catch{return false;}});if(!docker)fail('LIBPQ_DOCKER_UNAVAILABLE');
  directory=fs.mkdtempSync(PRIVATE+'/libpq-');fs.chmodSync(directory,0o700);env={PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C',LC_ALL:'C',DOCKER_CONFIG:directory};
  const targetImage=command(['inspect','--format','{{.Image}}','supabase-db']).trim();if(targetImage!==m.targetImage)fail('LIBPQ_TARGET_IMAGE_MISMATCH');
  const image=JSON.parse(command(['image','inspect',m.targetImage]));if(image.length!==1||image[0].Id!==m.targetImage||Object.keys(image[0].Config?.Volumes??{}).some(v=>v!=='/var/lib/postgresql/data'))fail('LIBPQ_CACHED_IMAGE_INVALID');
  let dnsTimer;const answers=await Promise.race([lookup(SOURCE_HOST,{all:true,family:4,verbatim:true}),new Promise((_,reject)=>{dnsTimer=setTimeout(()=>reject(Object.assign(new Error(),{code:'LIBPQ_DNS_TIMEOUT'})),2500);})]).finally(()=>clearTimeout(dnsTimer));
  if(!answers.some(a=>a.address===m.address)||answers.some(a=>!m.resolvedAddresses.includes(a.address)))fail('LIBPQ_REVIEWED_PEER_CHANGED');
  const {sourceServiceConfig}=await import(RUNTIME+'/scripts/migration-source.mjs');const source=sourceServiceConfig();validatedSourcePeerConfig(source,m);
  phase='credentials';let passwordTimer,password=await Promise.race([Promise.resolve().then(()=>source.password()),new Promise((_,reject)=>{passwordTimer=setTimeout(()=>reject(Object.assign(new Error(),{code:'LIBPQ_PASSWORD_TIMEOUT'})),2500);})]).finally(()=>clearTimeout(passwordTimer));const files=credentialFiles(source,m,password);password=undefined;
  for(const [filename,data]of Object.entries(files))privateWrite(directory+'/'+(filename==='ca'?'ca.crt':filename),data);
  phase='psql';if(controller.signal.aborted)fail('LIBPQ_INTERRUPTED');const remaining=44000-(performance.now()-started);if(remaining<=0)fail('LIBPQ_WALL_DEADLINE');
  result={...result,...await runSyntheticClient({docker,args:clientArgs({image:m.targetImage,name,nonce,directory}),env,deadlineMs:Math.min(35000,remaining),signal:controller.signal}),status:'PASS'};
 }catch(e){result={...result,status:'BLOCKED',phase:e.phase??phase,code:safeCode(e),...(e.progress?{progress:e.progress}:{})};}
 finally{
  if(name&&docker&&env){try{const list=()=>command(['ps','--all','--filter','name=^/'+name+'$','--format','{{.ID}}']).trim();if(list()){const records=JSON.parse(command(['inspect',name]));if(records.length!==1||!ownedContainer(records[0],name,nonce))fail('LIBPQ_CLEANUP_OWNERSHIP');command(['rm','--force',records[0].Id]);if(list())fail('LIBPQ_CLEANUP_REMAINS');}result.clientRemoved=true;}catch(e){result.status='BLOCKED';result.cleanupCode=safeCode(e);}}
  if(directory){try{fs.rmSync(directory,{recursive:true,force:true});result.credentialsRemoved=!fs.existsSync(directory);}catch{result.status='BLOCKED';result.cleanupCode='LIBPQ_CREDENTIAL_CLEANUP';}}
  if(guard)try{privateWrite(PRIVATE+'/source-libpq-probe-result.json',JSON.stringify(result)+'\n');}catch{result.status='BLOCKED';result.code='LIBPQ_RESULT_WRITE';}
 }
 process.off('SIGTERM',onSignal);process.off('SIGINT',onSignal);
 console.log('SOURCE_LIBPQ_PROBE',JSON.stringify(result));if(result.status!=='PASS')process.exitCode=2;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
