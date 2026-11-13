// One-off restore rehearsal. Run only AFTER Auth QA cleanup; no source access.
// argv[2]: one existing, S3-read-back-verified target manifest. No secret argv.
import fs from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const runtime='/opt/bron/audit-runtime-c128f9b';
const identity='/root/bron-secrets/source-backup.agekey';
const docker=['--host','unix:///var/run/docker.sock'];
const fail=code=>{throw Object.assign(new Error(code),{code});};
const env={PATH:'/usr/bin:/bin',HOME:'/root',LANG:'C.UTF-8',LC_ALL:'C.UTF-8'};
let phase='guards', ownId, socket, primary, restored;
const marker=randomUUID().replaceAll('-','');
export function classifyRestoreFailure(text) {
  const headline=text.match(/ERROR:\s+(?:([0-9A-Z]{5}):\s*)?([^\r\n]*)/i);
  const message=headline?.[2]??'';
  const diagnostic=/reserved role|role memberships are reserved/i.test(message)?'RESERVED_ROLE':
    /must be superuser|only superusers|superuser.*required/i.test(message)?'SUPERUSER_REQUIRED':
    /permission denied to (?:create|alter|drop|grant|revoke).*role/i.test(message)?'ROLE_PERMISSION':
    /permission denied to set parameter/i.test(message)?'PARAMETER_PERMISSION':
    /already exists/i.test(message)?'OBJECT_EXISTS':/permission denied|must be owner/i.test(message)?'PERMISSION':
    /could not open.*control|extension.*not available|no installation script/i.test(message)?'EXTENSION_UNAVAILABLE':
    /does not exist/i.test(message)?'OBJECT_MISSING':/encryption key|pgsodium.*key/i.test(message)?'VAULT_KEY':'UNCLASSIFIED';
  const line=text.match(/psql:(?:<stdin>|-):(\d+):\s*ERROR:/i);
  return {diagnostic,sqlstate:headline?.[1]?.toUpperCase()??null,
    statementLine:line?Number(line[1]):null};
}
export function globalsStatementClass(script,line) {
  if(!Number.isSafeInteger(line)||line<1)return 'UNAVAILABLE';
  const source=script.split(/\r?\n/)[line-1]?.trim()??'';
  const patterns=[['CREATE_ROLE',/^CREATE ROLE\b/i],['ALTER_ROLE',/^ALTER ROLE\b/i],
    ['GRANT_ROLE',/^GRANT\b/i],['REVOKE_ROLE',/^REVOKE\b/i],
    ['SESSION_AUTHORIZATION',/^SET SESSION AUTHORIZATION\b/i],['SET_ROLE',/^SET ROLE\b/i],['SET_PARAMETER',/^SET\b/i]];
  return patterns.find(([,pattern])=>pattern.test(source))?.[0]??'OTHER';
}
export function globalsStandardRoles(script,line) {
  if(!Number.isSafeInteger(line)||line<1)return [];
  const source=(script.split(/\r?\n/)[line-1]??'').replace(/'(?:[^']|'')*'/g,"''");
  const allowed=new Set(['anon','authenticated','authenticator','service_role','postgres','supabase_admin',
    'supabase_auth_admin','supabase_storage_admin','supabase_read_only_user','supabase_realtime_admin',
    'supabase_replication_admin','supabase_etl_admin','supabase_privileged_role','pgbouncer','dashboard_user',
    'pgsodium_keyholder','pgsodium_keyiduser','pgsodium_keymaker']);
  const roles=[...new Set((source.match(/\b[a-z_][a-z0-9_]*\b/g)??[]).filter(word=>allowed.has(word)))].sort();
  return roles.length?roles:['OTHER'];
}
function run(binary,args,{input,timeout=30000}={}) {
  const result=spawnSync(binary,args,{env,input,encoding:'utf8',timeout,maxBuffer:4*1024*1024,
    stdio:[input===undefined?'ignore':'pipe','pipe','ignore']});
  if(result.error||result.status!==0)fail('REHEARSAL_COMMAND_FAILED');
  return result.stdout;
}
const d=(args,opts)=>run('/usr/bin/docker',[...docker,...args],opts);
function privatePath(file,directory=false) {
  const s=fs.lstatSync(file);
  if(s.uid!==0||(s.mode&0o777)!==(directory?0o700:0o600)||!(directory?s.isDirectory():s.isFile()))
    fail('REHEARSAL_PRIVATE_PATH_INVALID');
}
async function hashFile(file) {
  privatePath(file);
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  const h=createHash('sha256');
  for await(const chunk of fs.createReadStream(null,{fd,autoClose:true}))h.update(chunk);
  return h.digest('hex');
}
async function decode(file,consumer,capture=false) {
  const commands=[['/usr/bin/age',['-d','-i',identity,file]],['/usr/bin/zstd',['-d','-c']],consumer];
  const children=commands.map(([binary,args])=>spawn(binary,args,{env,
    stdio:['pipe','pipe','pipe']}));
  const diagnostics=[];let diagnosticBytes=0;
  for(const c of children)c.stderr.on('data',b=>{if(diagnosticBytes<65536){
    const part=b.subarray(0,65536-diagnosticBytes);diagnostics.push(part);diagnosticBytes+=part.length;}});
  children[0].stdin.end();
  for(const c of children){c.stdin.on('error',()=>{});c.stdout.on('error',()=>{});}
  children[0].stdout.pipe(children[1].stdin);children[1].stdout.pipe(children[2].stdin);
  const chunks=[];let bytes=0,overflow=false;
  children[2].stdout.on('data',b=>{if(capture){bytes+=b.length;if(bytes>4*1024*1024){overflow=true;children.forEach(c=>c.kill());}else chunks.push(b);}});
  const timer=setTimeout(()=>children.forEach(c=>c.kill()),300000);
  try {
    const statuses=await Promise.all(children.map(c=>new Promise((resolve,reject)=>{
      c.once('error',()=>reject(new Error('pipeline')));c.once('close',(status)=>resolve(status));})));
    if(overflow||statuses.some(status=>status!==0)){
      const text=Buffer.concat(diagnostics).toString('utf8');
      const diagnostic=classifyRestoreFailure(text);
      console.error('T11_PIPELINE_FAILURE',JSON.stringify({exitCodes:statuses,...diagnostic}));
      throw Object.assign(new Error('REHEARSAL_DECRYPT_OR_RESTORE_FAILED'),
        {code:'REHEARSAL_DECRYPT_OR_RESTORE_FAILED',diagnostic});
    }
    return Buffer.concat(chunks);
  } finally {clearTimeout(timer);for(const c of children)if(c.exitCode===null)c.kill();}
}
const owned=(args)=>['/usr/bin/docker',[...docker,'exec','-i',ownId,...args]];
const sqlIdent=s=>'"'+s.replaceAll('"','""')+'"';
const sqlLiteral=s=>"'"+s.replaceAll("'","''")+"'";
const pgConf=s=>"'"+String(s).replaceAll("'","''")+"'";
const sorted=x=>JSON.stringify([...x].sort((a,b)=>a.name.localeCompare(b.name)));
function tree(root,relative='') {
  const h=createHash('sha256');
  function visit(name){
    const file=path.join(root,name),s=fs.lstatSync(file);
    h.update(JSON.stringify([name,s.isDirectory()?'directory':'file',s.isFile()?s.size:0]));
    if(s.isDirectory())for(const child of fs.readdirSync(file).sort())visit(path.join(name,child));
    else if(s.isFile()&&s.nlink===1){const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      try{const b=Buffer.alloc(65536);let n;while((n=fs.readSync(fd,b,0,b.length,null)))h.update(b.subarray(0,n));}finally{fs.closeSync(fd);}}
    else fail('REHEARSAL_STORAGE_FILE_TYPE_INVALID');
  }visit(relative);return h.digest('hex');
}
export async function main(){try {
  if(process.getuid()!==0)fail('REHEARSAL_ROOT_REQUIRED');
  run('/usr/bin/prlimit',['--pid',String(process.pid),'--core=0:0']);
  const available=Number(fs.readFileSync('/proc/meminfo','utf8').match(/^MemAvailable:\s+(\d+) kB$/m)?.[1]);
  if(!Number.isFinite(available)||available<1536*1024)fail('REHEARSAL_MEMORY_HEADROOM_REQUIRED');
  const ips=run('/usr/sbin/ip',['-4','-o','addr','show','scope','global']);
  if(!ips.split('\n').some(line=>line.split(/\s+/)[3]?.split('/')[0]==='152.228.115.115'))fail('REHEARSAL_WRONG_VPS');
  const manifestPath=process.argv[2];
  const diagnose=process.argv[3]==='--diagnose-globals';
  if(process.argv.length!==(diagnose?4:3)||!/^\/var\/backups\/bron-franchise\/target-\d{8}T\d{6}Z-[a-f0-9]{8}\/manifest\.json$/.test(manifestPath??''))
    fail('REHEARSAL_EXPLICIT_TARGET_MANIFEST_REQUIRED');
  privatePath(path.dirname(manifestPath),true);privatePath(manifestPath);privatePath(identity);
  const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8'));
  const expected=['database.dump.zst.age','roles.sql.zst.age','vault-logical.csv.zst.age','config.tar.zst.age','storage.tar.zst.age'];
  if(manifest.target!=='bron-franchise-russia'||manifest.status!=='target_backup_saved_restore_unverified'||
    manifest.complete!==false||manifest.storage_objects!==0||manifest.artifacts?.length!==5||
    expected.some(name=>manifest.artifacts.filter(x=>x.file===name).length!==1))fail('REHEARSAL_MANIFEST_MISMATCH');
  if(!Array.isArray(manifest.metadata.extensions)||manifest.metadata.extensions.some(e=>typeof e.owner!=='string'))
    fail('REHEARSAL_NEW_BACKUP_FORMAT_REQUIRED');
  for(const e of manifest.artifacts){
    const file=path.join(path.dirname(manifestPath),e.file);
    if(fs.statSync(file).size!==e.bytes||await hashFile(file)!==e.sha256)fail('REHEARSAL_ARTIFACT_SHA_MISMATCH');
  }
  const artifact=name=>path.join(path.dirname(manifestPath),name+'.zst.age');
  if(await hashFile(runtime+'/scripts/migration-audit.mjs')!=='d63fbef0ab6fbed0bb3d09ed6d067ca5f7753d47a981bdb4c4bc8a4719468931')
    fail('REHEARSAL_AUDITOR_SHA_MISMATCH');
  const {default:pg}=await import(runtime+'/node_modules/pg/lib/index.js');
  const {snapshotDatabase,compareSnapshots}=await import(runtime+'/scripts/migration-audit.mjs');
  const [live]=JSON.parse(d(['inspect','supabase-db']));
  if(live.Name!=='/supabase-db'||!live.State.Running||live.Image!==manifest.metadata.database_image)
    fail('REHEARSAL_IMAGE_OR_TARGET_MISMATCH');
  const values=Object.fromEntries(live.Config.Env.map(e=>{const i=e.indexOf('=');return[e.slice(0,i),e.slice(i+1)];}));
  if(values.POSTGRES_USER!=='supabase_admin'||values.POSTGRES_DB!=='postgres'||!values.POSTGRES_PASSWORD||
    values.PGPASSWORD!==values.POSTGRES_PASSWORD)fail('REHEARSAL_TARGET_CONFIG_MISMATCH');
  primary=new pg.Client({host:'127.0.0.1',port:15433,user:'supabase_admin',database:'postgres',
    password:values.POSTGRES_PASSWORD,ssl:false,query_timeout:60000});
  await primary.connect();
  phase='capture-baseline';
  const baseline=await snapshotDatabase(primary);
  const settings=(await primary.query(`SELECT name,setting FROM pg_settings WHERE lower(name) IN
    ('shared_preload_libraries','session_preload_libraries','pgsodium.getkey_script','vault.getkey_script','timezone','datestyle')`)).rows;
  const database=(await primary.query(`SELECT to_jsonb(d) AS value,pg_get_userbyid(d.datdba) AS owner
    FROM pg_database d WHERE datname=current_database()`)).rows[0];
  const extensions=(await primary.query(`SELECT e.extname AS name,e.extversion AS version,n.nspname AS schema,
    pg_get_userbyid(e.extowner) AS owner FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace`)).rows;
  const namespaces=(await primary.query('SELECT nspname AS name,pg_get_userbyid(nspowner) AS owner FROM pg_namespace')).rows;
  const dbSettingsSql=`SELECT CASE WHEN setrole=0 THEN '' ELSE pg_get_userbyid(setrole) END AS role,setconfig
    FROM pg_db_role_setting WHERE setdatabase=(SELECT oid FROM pg_database WHERE datname=current_database())`;
  const dbSettings=(await primary.query(dbSettingsSql)).rows;
  const normalizedSettings=rows=>JSON.stringify(rows.map(r=>({role:r.role,setconfig:[...r.setconfig].sort()}))
    .sort((a,b)=>a.role.localeCompare(b.role)));
  if(manifest.metadata.extensions.length!==extensions.length)fail('REHEARSAL_ARCHIVED_EXTENSION_METADATA_MISMATCH');
  for(const archived of manifest.metadata.extensions){
    const actual=extensions.find(e=>e.name===archived.name);
    if(!actual||Object.keys(archived).some(k=>archived[k]!==actual[k]))fail('REHEARSAL_ARCHIVED_EXTENSION_METADATA_MISMATCH');
  }
  const counts=(await primary.query('SELECT (SELECT count(*) FROM storage.objects)::int AS objects')).rows[0];
  if(counts.objects!==0)fail('REHEARSAL_ZERO_STORAGE_REQUIRED');
  const storageRoot='/opt/bron/supabase/docker/volumes/storage',storageTree=tree(storageRoot);
  const uid=Number(d(['exec',live.Id,'id','-u','postgres']).trim());
  const gid=Number(d(['exec',live.Id,'id','-g','postgres']).trim());
  if(!Number.isSafeInteger(uid)||uid<=0||!Number.isSafeInteger(gid)||gid<=0)fail('REHEARSAL_POSTGRES_UID_INVALID');
  socket='/run/bron-rst-'+marker.slice(0,12);fs.mkdirSync(socket,{mode:0o700});fs.chownSync(socket,uid,gid);
  const tmpfs=(where,size)=>['--tmpfs',`${where}:rw,nosuid,nodev,uid=${uid},gid=${gid},mode=0700,size=${size}`];
  phase='create-isolated-container';
  ownId=d(['run','--detach','--pull=never','--name','bron-restore-'+marker,'--label','bron.restore='+marker,
    '--network','none','--no-healthcheck','--restart=no','--memory','1g','--cpus','1',
    ...tmpfs('/restore-data','768m'),...tmpfs('/restore-config','32m'),...tmpfs('/restore-storage','32m'),
    ...tmpfs('/etc/postgresql-custom','32m'),'--volume',socket+':/restore-socket',
    '--entrypoint','/bin/sh',live.Image,'-c','exec tail -f /dev/null']).trim();
  const [own]=JSON.parse(d(['inspect',ownId]));
  if(own.Config.Labels['bron.restore']!==marker||own.HostConfig.NetworkMode!=='none'||
    Object.keys(own.HostConfig.PortBindings??{}).length||own.Mounts.some(m=>
      !['bind','tmpfs'].includes(m.Type)||(m.Type==='bind'&&m.Source!==socket)))
    fail('REHEARSAL_ISOLATION_FAILED');
  phase='recover-key-from-encrypted-config';
  await decode(artifact('config.tar'),owned(['tar','-x','-f','-','-C','/restore-config']));
  d(['exec',ownId,'/bin/sh','-c',`set -eu
set -- /restore-config/var/lib/docker/volumes/*/_data
[ "$#" = 1 ] && [ -d "$1" ]
cp -a "$1"/. /etc/postgresql-custom/
test -s /etc/postgresql-custom/pgsodium_root.key
chown -R postgres:postgres /etc/postgresql-custom`]);
  phase='initialize-isolated-postgres';
  const bootstrap='bron_restore_'+marker.slice(0,16);
  const db=database.value, locale=db.datlocale??db.daticulocale;
  const init=['exec','--user','postgres',ownId,'initdb','-D','/restore-data','--username='+bootstrap,
    '--auth-local=trust','--auth-host=reject','--encoding=UTF8'];
  if(db.datlocprovider==='i'&&locale)init.push('--locale-provider=icu','--icu-locale='+locale);
  else if(db.datlocprovider==='c')init.push('--locale-provider=libc','--lc-collate='+db.datcollate,'--lc-ctype='+db.datctype);
  else fail('REHEARSAL_LOCALE_UNSUPPORTED');
  d(init,{timeout:60000});
  const config=["include_if_exists = '/etc/postgresql-custom/supautils.conf'",
    ...settings.map(s=>s.name+' = '+pgConf(s.setting)),"listen_addresses = ''",
    "unix_socket_directories = '/restore-socket'","shared_buffers = '32MB'","max_connections = 20",
    'cron.launch_active_jobs = off','pg_net.batch_size = 0','log_min_messages = fatal'].join('\n')+'\n';
  d(['exec','-i','--user','postgres',ownId,'/bin/sh','-c','cat > /restore-data/postgresql.auto.conf'],{input:config});
  d(['exec','--user','postgres',ownId,'pg_ctl','-D','/restore-data','-l','/restore-data/server.log','-w','-t','45','start'],{timeout:60000});
  const psql=['psql','-h','/restore-socket','-U',bootstrap,'-d','postgres','-X','-q','-v','ON_ERROR_STOP=1',
    '-v','VERBOSITY=verbose','-v','SHOW_CONTEXT=never'];
  phase='restore-globals';
  const actor=JSON.parse(d(['exec',ownId,...psql,'-A','-t','--command',`SELECT json_build_object(
    'session_is_bootstrap',session_user=${sqlLiteral(bootstrap)},'current_is_session',current_user=session_user,
    'role_superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),
    'setting_superuser',current_setting('is_superuser')='on',
    'reserved_roles_configured',coalesce(current_setting('supautils.reserved_roles',true),'')<>'',
    'configured_superuser_is_bootstrap',coalesce(current_setting('supautils.superuser',true),'')=session_user);`]));
  try{await decode(artifact('roles.sql'),owned([...psql,'--single-transaction']));}
  catch(error){
    if(!diagnose)throw error;
    const script=(await decode(artifact('roles.sql'),['/usr/bin/cat',[]],true)).toString('utf8');
    console.log('T13_GLOBALS_DIAGNOSTIC',JSON.stringify({actor,...error.diagnostic,
      statementClass:globalsStatementClass(script,error.diagnostic?.statementLine),
      standardRoles:globalsStandardRoles(script,error.diagnostic?.statementLine),restorePassed:false}));
    if(compareSnapshots(baseline,await snapshotDatabase(primary)).length)fail('REHEARSAL_PRIMARY_CHANGED_DURING_RUN');
    console.log('T13_DIAGNOSTICS_COMPLETE_NO_FULL_RESTORE');return;
  }
  if(diagnose){if(compareSnapshots(baseline,await snapshotDatabase(primary)).length)fail('REHEARSAL_PRIMARY_CHANGED_DURING_RUN');
    console.log('T13_GLOBALS_DIAGNOSTIC',JSON.stringify({actor,diagnostic:'GLOBALS_RESTORED',
    restorePassed:false}));console.log('T13_DIAGNOSTICS_COMPLETE_NO_FULL_RESTORE');return;}
  const toc=(await decode(artifact('database.dump'),owned(['pg_restore','--list']),true)).toString('utf8');
  const lines=toc.split('\n');
  const dbCreate=lines.filter(l=>/^\d+;\s+\d+\s+\d+\s+DATABASE\s+-\s+postgres\s/.test(l));
  if(dbCreate.length!==1)fail('REHEARSAL_CREATE_DATABASE_ARCHIVE_REQUIRED');
  d(['exec','-i',ownId,'/bin/sh','-c','cat > /restore-data/database.list'],{input:dbCreate.join('\n')+'\n'});
  // Only the disposable cluster's initial empty postgres database is replaced.
  d(['exec',ownId,...psql.map(x=>x==='postgres'?'template1':x),'--command',
    "ALTER DATABASE postgres ALLOW_CONNECTIONS false; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='postgres';"]);
  phase='restore-archived-database-definition';
  await decode(artifact('database.dump'),owned(['pg_restore','-h','/restore-socket','-U',bootstrap,
    '--dbname=template1','--create','--clean','--if-exists','--exit-on-error','--use-list=/restore-data/database.list']));
  restored=new pg.Client({host:socket,user:bootstrap,database:'postgres',ssl:false,query_timeout:60000});
  await restored.connect();
  phase='bootstrap-exact-schema-and-extension-metadata';
  const prepared=new Set(),kept=[],propertyEntries=[],archiveSchemas=new Map();let skipped=0;
  for(const line of lines){const m=line.match(/^\d+;\s+\d+\s+\d+\s+SCHEMA\s+-\s+(\S+)\s+(\S+)\s*$/);
    if(m)archiveSchemas.set(m[1],m[2]);}
  async function schema(name){
    if(prepared.has(name))return;
    const ns=namespaces.find(n=>n.name===name);if(!ns)fail('REHEARSAL_SCHEMA_METADATA_MISSING');
    if(archiveSchemas.has(name)&&archiveSchemas.get(name)!==ns.owner)fail('REHEARSAL_ARCHIVED_SCHEMA_OWNER_MISMATCH');
    await restored.query('CREATE SCHEMA IF NOT EXISTS '+sqlIdent(name)+' AUTHORIZATION '+sqlIdent(ns.owner));
    await restored.query('ALTER SCHEMA '+sqlIdent(name)+' OWNER TO '+sqlIdent(ns.owner));prepared.add(name);
  }
  for(const line of lines){
    if(/^\d+;\s+\d+\s+\d+\s+DATABASE PROPERTIES\s+-\s+postgres\s/.test(line))propertyEntries.push(line);
    const item=line.match(/^\d+;\s+\d+\s+\d+\s+(SCHEMA|EXTENSION|DATABASE)\s+-\s+(\S+)(?:\s+(\S+))?\s*$/);
    if(!item){kept.push(line);continue;}
    if(item[1]==='SCHEMA')await schema(item[2]);
    else if(item[1]==='EXTENSION'&&!extensions.some(e=>e.name===item[2]))fail('REHEARSAL_TOC_EXTENSION_UNKNOWN');
    else if(item[1]==='DATABASE'&&item[2]!=='postgres')fail('REHEARSAL_TOC_DATABASE_UNKNOWN');
    skipped++;
  }
  // Only duplicate administrative CREATE entries are omitted. Every data,
  // routine, trigger, policy, constraint, owner/ACL and sequence entry remains.
  await restored.query('DROP EXTENSION IF EXISTS plpgsql');
  const dependencies=[];
  for(const e of manifest.metadata.extensions){const row=(await restored.query(
    'SELECT requires FROM pg_available_extension_versions WHERE name=$1 AND version=$2',[e.name,e.version])).rows[0];
    if(!row)fail('REHEARSAL_EXTENSION_VERSION_UNAVAILABLE');
    for(const required of row.requires??[])dependencies.push({name:e.name,required});}
  const pending=[...manifest.metadata.extensions],created=new Set();
  while(pending.length){
    const i=pending.findIndex(e=>dependencies.filter(d=>d.name===e.name).every(d=>created.has(d.required)));
    if(i<0)fail('REHEARSAL_EXTENSION_DEPENDENCY_CYCLE');
    const [e]=pending.splice(i,1);await schema(e.schema);
    await restored.query('SET ROLE '+sqlIdent(e.owner));
    try{await restored.query('CREATE EXTENSION '+sqlIdent(e.name)+' WITH SCHEMA '+sqlIdent(e.schema)+' VERSION '+sqlLiteral(e.version));}
    finally{await restored.query('RESET ROLE');}
    created.add(e.name);
  }
  d(['exec','-i',ownId,'/bin/sh','-c','cat > /restore-data/restore.list'],{input:kept.join('\n')});
  console.log('T11_ADMINISTRATIVE_BOOTSTRAP',JSON.stringify({schemas:prepared.size,extensions:created.size,
    duplicateCreateEntries:skipped,archivedExtensionMetadata:!!manifest.metadata.extensions}));
  phase='restore-full-database';
  const restore=['/usr/bin/docker',[...docker,'exec','-i','-e','PGOPTIONS=-c session_replication_role=replica',ownId,
    'pg_restore','-h','/restore-socket','-U',bootstrap,'--role=supabase_admin','--dbname=postgres',
    '--use-list=/restore-data/restore.list','--single-transaction','--exit-on-error']];
  await decode(artifact('database.dump'),restore);
  await restored.query('REASSIGN OWNED BY '+sqlIdent(bootstrap)+' TO '+sqlIdent(namespaces.find(n=>n.name==='pg_catalog').owner));
  phase='verify-database-runtime-settings';
  if(propertyEntries.length){
    d(['exec','-i',ownId,'/bin/sh','-c','cat > /restore-data/properties.list'],{input:propertyEntries.join('\n')+'\n'});
    await decode(artifact('database.dump'),owned(['pg_restore','-h','/restore-socket','-U',bootstrap,'--role=supabase_admin',
      '--dbname=postgres','--create','--exit-on-error','--use-list=/restore-data/properties.list']));
  }
  if(normalizedSettings(dbSettings)!==normalizedSettings((await restored.query(dbSettingsSql)).rows))
    fail('REHEARSAL_DATABASE_SETTING_MISMATCH');
  const safe=(await restored.query(`SELECT current_setting('cron.launch_active_jobs') AS cron,
    current_setting('pg_net.batch_size') AS net,current_setting('listen_addresses') AS listen`)).rows[0];
  if(safe.cron!=='off'||safe.net!=='0'||safe.listen!=='')fail('REHEARSAL_SCHEDULER_ISOLATION_FAILED');
  phase='strict-restore-comparison';
  const mismatch=compareSnapshots(baseline,await snapshotDatabase(restored));
  console.log('T11_RESTORE_MISMATCH_GROUPS',JSON.stringify(mismatch));
  if(mismatch.length)fail('REHEARSAL_STRICT_RESTORE_MISMATCH');
  const extRestored=(await restored.query(`SELECT e.extname AS name,e.extversion AS version,n.nspname AS schema,
    pg_get_userbyid(e.extowner) AS owner FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace`)).rows;
  if(sorted(extensions)!==sorted(extRestored))fail('REHEARSAL_EXTENSION_OWNER_OR_VERSION_MISMATCH');
  phase='verify-vault-and-storage';
  const copy=`SET TIME ZONE ${sqlLiteral(settings.find(s=>s.name.toLowerCase()==='timezone').setting)};
    COPY (SELECT id,name,description,decrypted_secret,created_at,updated_at FROM vault.decrypted_secrets ORDER BY id)
    TO STDOUT WITH (FORMAT CSV,HEADER true);`;
  const copied=Buffer.from(d(['exec',ownId,...psql,'-A','-t','--command',copy]));
  const archived=await decode(artifact('vault-logical.csv'),['/usr/bin/cat',[]],true);
  if(!copied.equals(archived))fail('REHEARSAL_VAULT_LOGICAL_MISMATCH');
  await decode(artifact('storage.tar'),owned(['tar','-x','-f','-','-C','/restore-storage']));
  if(tree('/proc/'+own.State.Pid+'/root/restore-storage')!==storageTree||tree(storageRoot)!==storageTree)
    fail('REHEARSAL_STORAGE_TREE_MISMATCH');
  if(compareSnapshots(baseline,await snapshotDatabase(primary)).length)fail('REHEARSAL_PRIMARY_CHANGED_DURING_RUN');
  console.log('T11_TARGET_RESTORE_PASS',JSON.stringify({strictGroups:Object.keys(baseline).length,
    storageObjects:0,storageTreeMatches:true,vaultLogicalMatches:true,keyRecoveredFromEncryptedConfig:true,extensionOwnersMatch:true,
    sourceAccessed:false,productionWrites:false}));
} catch(error){
  console.error('T11_TARGET_RESTORE_BLOCKED',phase,/^[A-Z0-9_]{3,80}$/.test(error.code??'')?error.code:'REHEARSAL_FAILED');
  process.exitCode=2;
} finally {
  await restored?.end().catch(()=>{});await primary?.end().catch(()=>{});
  if(ownId){try{const [own]=JSON.parse(d(['inspect',ownId]));
    if(own.Config.Labels['bron.restore']===marker){
      try{d(['exec','--user','postgres',ownId,'pg_ctl','-D','/restore-data','-m','fast','-w','-t','10','stop'],{timeout:15000});}catch{}
      d(['stop','--time','5',ownId]);d(['rm',ownId]);}
  }catch{console.error('T11_TEMPORARY_CONTAINER_CLEANUP_REQUIRED');process.exitCode=2;}}
  if(socket){try{for(const name of fs.readdirSync(socket)){
    if(!['.s.PGSQL.5432','.s.PGSQL.5432.lock'].includes(name))fail('REHEARSAL_UNEXPECTED_SOCKET_FILE');
    fs.unlinkSync(path.join(socket,name));
  }fs.rmdirSync(socket);}catch{console.error('T11_TEMPORARY_SOCKET_CLEANUP_REQUIRED');process.exitCode=2;}}
}}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)await main();
