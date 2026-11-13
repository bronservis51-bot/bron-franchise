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
const standardSchemas=new Set(['pg_catalog','pg_toast','information_schema','public','extensions','vault',
  'cron','net','auth','storage','app_private','realtime','supabase_functions','graphql','graphql_public']);
const standardExtensions=new Set(['pg_cron','pg_net','pg_stat_statements','pg_trgm','pgcrypto','plpgsql','supabase_vault','uuid-ossp']);
const standardOwners=new Set(['supabase_admin','postgres','pg_database_owner']);
const schemaLabel=name=>standardSchemas.has(name)?name:'OTHER';
const extensionLabel=name=>standardExtensions.has(name)?name:'OTHER';
export function safeExtensionMetadata(e){return {name:extensionLabel(e.name),
  version:/^\d+(?:[.-]\d+)*(?:[a-z]+\d*)?$/.test(e.version)?e.version:'OTHER',
  schema:schemaLabel(e.schema),owner:standardOwners.has(e.owner)?e.owner:'OTHER'};}
export function preservedBuiltinExtensions(existing,expected) {
  const created=new Set();
  for(const e of existing){
    if(e.name!=='plpgsql')fail('REHEARSAL_UNEXPECTED_PREEXISTING_EXTENSION');
    const saved=expected.find(x=>x.name===e.name);
    if(!saved||['name','version','schema','owner'].some(key=>e[key]!==saved[key]))
      fail('REHEARSAL_PREEXISTING_EXTENSION_METADATA_MISMATCH');
    created.add(e.name);
  }
  if(!created.has('plpgsql'))fail('REHEARSAL_BUILTIN_PLPGSQL_MISSING');
  return created;
}
export function safeBootstrapError(error) {
  const message=String(error.message??''),sqlstate=/^[0-9A-Z]{5}$/.test(error.code??'')?error.code:null;
  const language=message.match(/language "([^"]+)" does not exist/i);
  if(language)return {sqlstate,messageClass:'MISSING_LANGUAGE',standardObject:language[1]==='plpgsql'?'plpgsql':'OTHER'};
  const setting=message.match(/unrecognized configuration parameter "([^"]+)"/i);
  if(setting)return {sqlstate,messageClass:'MISSING_SETTING',standardObject:
    ['cron.database_name','cron.launch_active_jobs','pg_net.batch_size','pgsodium.getkey_script','vault.getkey_script'].includes(setting[1])?setting[1]:'OTHER'};
  const role=message.match(/role "([^"]+)" does not exist/i);
  if(role)return {sqlstate,messageClass:'MISSING_ROLE',standardObject:standardOwners.has(role[1])?role[1]:'OTHER'};
  return {sqlstate,messageClass:classifyRestoreFailure('ERROR: '+message).diagnostic,standardObject:'OTHER'};
}
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
export function instrumentGlobals(script) {
  const out=[],steps=[];let quote='',block=0,dollar='',start=true,escape=false;
  for(const [index,line] of script.split('\n').entries()){
    const kind=globalsStatementClass(line,1);
    if(!quote&&!block&&!dollar&&start&&kind!=='OTHER'&&kind!=='UNAVAILABLE'){
      const marker='BRON_GLOBAL_STEP_'+String(steps.length+1).padStart(4,'0');
      steps.push({marker,statementLine:index+1,statementClass:kind,standardRoles:globalsStandardRoles(line,1)});
      out.push("SELECT '"+marker+"';");
    }
    out.push(line);
    if(!quote&&!block&&!dollar&&start&&line.trimStart().startsWith('\\'))continue;
    for(let i=0;i<line.length;i++){
      const c=line[i],next=line[i+1];
      if(block){if(c==='/'&&next==='*'){block++;i++;}else if(c==='*'&&next==='/'){block--;i++;}continue;}
      if(dollar){if(line.startsWith(dollar,i)){i+=dollar.length-1;dollar='';}continue;}
      if(quote){if(quote==="'"&&escape&&c==='\\'){i++;continue;}
        if(c===quote){if(next===quote)i++;else quote='';}continue;}
      if(c==='-'&&next==='-')break;
      if(c==='/'&&next==='*'){block++;i++;continue;}
      if(/\s/.test(c))continue;
      if(c==="'"||c==='"'){quote=c;escape=c==="'"&&/[eE]/.test(line[i-1]??'')&&
        (i<2||!/[A-Za-z0-9_$]/.test(line[i-2]));start=false;continue;}
      if(c==='$'){const tag=line.slice(i).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/)?.[0];
        if(tag){dollar=tag;i+=tag.length-1;start=false;continue;}}
      start=c===';';
    }
  }
  if(quote||block||dollar||!start)fail('REHEARSAL_GLOBALS_SQL_INCOMPLETE');
  return {sql:out.join('\n'),steps};
}
export function globalsRunSummary(result,steps) {
  const markers=[...(result.stdout??'').matchAll(/^BRON_GLOBAL_STEP_\d+\r?$/gm)];
  const marker=markers.at(-1)?.[0].trim();
  const step=steps.find(s=>s.marker===marker);
  const diagnostic=classifyRestoreFailure(result.stderr??'');
  return {exitStatus:result.status,diagnostic:result.status===0?'GLOBALS_RESTORED':diagnostic.diagnostic,
    sqlstate:diagnostic.sqlstate,statementLine:step?.statementLine??diagnostic.statementLine,
    statementClass:step?.statementClass??'UNAVAILABLE',standardRoles:step?.standardRoles??[],
    marker:step?.marker??null};
}
export const nativeGlobalsConfig=exact=>exact+"shared_preload_libraries = ''\nsession_preload_libraries = ''\n";
export function prepareBootstrapGlobals(script,bootstrap) {
  const lines=script.split('\n'),steps=instrumentGlobals(script).steps;
  const identifier='("(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)';
  const name=token=>token.startsWith('"')?token.slice(1,-1).replaceAll('""','"'):token.toLowerCase();
  let creates=0,superuserDeclared=false;
  for(const step of steps){const i=step.statementLine-1,line=lines[i];
    const create=line.match(new RegExp('^\\s*CREATE ROLE\\s+'+identifier+'\\s*;\\s*$','i'));
    if(create&&name(create[1])===bootstrap){creates++;lines[i]='-- BRON_INITIAL_BOOTSTRAP_ROLE_ALREADY_EXISTS';continue;}
    const alter=line.match(new RegExp('^\\s*ALTER ROLE\\s+'+identifier+'\\s+WITH\\s+','i'));
    if(alter&&name(alter[1])===bootstrap){
      const options=line.slice(alter[0].length).replace(/'(?:[^']|'')*'/g,"''");
      if(/\bNOSUPERUSER\b/i.test(options))fail('REHEARSAL_BOOTSTRAP_CANNOT_BE_NONSUPERUSER');
      if(/\bSUPERUSER\b/i.test(options))superuserDeclared=true;
    }
  }
  if(creates!==1||!superuserDeclared)fail('REHEARSAL_ARCHIVED_BOOTSTRAP_ROLE_INVALID');
  return {sql:lines.join('\n'),bootstrapCreateSkipped:creates};
}
export async function globalRoleState(db) {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    await db.query("SET LOCAL timezone='UTC'");
    const attributes=(await db.query(`SELECT (to_jsonb(r)-'oid'-'rolpassword')||
      jsonb_build_object('password_hash',a.rolpassword) AS record
      FROM pg_roles r JOIN pg_authid a ON a.oid=r.oid ORDER BY r.rolname COLLATE "C"`)).rows.map(r=>r.record);
    const memberships=(await db.query(`SELECT pg_get_userbyid(roleid) AS role,pg_get_userbyid(member) AS member,
      pg_get_userbyid(grantor) AS grantor,admin_option,inherit_option,set_option FROM pg_auth_members
      ORDER BY pg_get_userbyid(roleid) COLLATE "C",pg_get_userbyid(member) COLLATE "C",pg_get_userbyid(grantor) COLLATE "C"`)).rows;
    await db.query('ROLLBACK');return {attributes,memberships};
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
}
export function partitionArchiveToc(toc) {
  const database=[],administrativeCreates=[],remaining=[];
  for(const line of toc.split('\n')){
    const admin=line.match(/^\d+;\s+\d+\s+\d+\s+(DATABASE PROPERTIES|DATABASE|SCHEMA|EXTENSION)\s+-\s+(\S+)(?:\s+(\S+))?\s*$/);
    const dependent=line.match(/^\d+;\s+\d+\s+\d+\s+(ACL|COMMENT|SECURITY LABEL)\s+-\s+DATABASE\s+(\S+)(?:\s+(\S+))?\s*$/);
    if(dependent||(admin&&['DATABASE','DATABASE PROPERTIES'].includes(admin[1]))){
      const match=dependent??admin;
      if(match[2]!=='postgres')fail('REHEARSAL_TOC_DATABASE_UNKNOWN');
      database.push({kind:match[1],name:match[2],owner:match[3]??null,line});
    }else if(admin)administrativeCreates.push({kind:admin[1],name:admin[2],owner:admin[3]??null,line});
    else remaining.push(line);
  }
  if(database.filter(e=>e.kind==='DATABASE').length!==1)fail('REHEARSAL_CREATE_DATABASE_ARCHIVE_REQUIRED');
  return {database,administrativeCreates,remaining};
}
export async function databaseState(db) {
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const metadata=(await db.query(`SELECT jsonb_build_object('owner',pg_get_userbyid(d.datdba),
      'encoding',pg_encoding_to_char(d.encoding),'locale_provider',d.datlocprovider,'collate',d.datcollate,
      'ctype',d.datctype,'locale',coalesce(to_jsonb(d)->>'datlocale',to_jsonb(d)->>'daticulocale'),
      'icu_rules',to_jsonb(d)->>'daticurules','collation_version',d.datcollversion,
      'connection_limit',d.datconnlimit,'allow_connections',d.datallowconn,'is_template',d.datistemplate,
      'tablespace',(SELECT spcname FROM pg_tablespace WHERE oid=d.dattablespace),
      'comment',shobj_description(d.oid,'pg_database')) AS value
      FROM pg_database d WHERE datname=current_database()`)).rows[0].value;
    const acl=(await db.query(`SELECT * FROM (SELECT CASE WHEN x.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END AS grantee,
      pg_get_userbyid(x.grantor) AS grantor,x.privilege_type,
      (x.is_grantable OR x.grantee=d.datdba) AS grantable
      FROM pg_database d CROSS JOIN LATERAL aclexplode(coalesce(d.datacl,acldefault('d',d.datdba))) x
      WHERE d.datname=current_database()) acl ORDER BY grantee COLLATE "C",grantor COLLATE "C",privilege_type COLLATE "C",grantable`)).rows;
    const labels=(await db.query(`SELECT provider,label FROM pg_shseclabel
      WHERE classoid='pg_database'::regclass AND objoid=(SELECT oid FROM pg_database WHERE datname=current_database())
      ORDER BY provider COLLATE "C",label COLLATE "C"`)).rows;
    await db.query('ROLLBACK');return {metadata,acl,labels};
  }catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}
}
export async function ensureRestoreSchema(db,name,owner) {
  const label=schemaLabel(name);
  const inspect=async()=>(await db.query('SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname=$1',[name])).rows[0];
  phase='inspect-schema-'+label;
  const existing=await inspect();
  if(!existing){
    if(name.startsWith('pg_')||name==='information_schema')fail('REHEARSAL_BUILTIN_SCHEMA_MISSING');
    phase='create-schema-'+label;
    await db.query('CREATE SCHEMA '+sqlIdent(name)+' AUTHORIZATION '+sqlIdent(owner));
  }else if(existing.owner!==owner){
    phase='restore-schema-owner-'+label;
    await db.query('ALTER SCHEMA '+sqlIdent(name)+' OWNER TO '+sqlIdent(owner));
  }
  phase='verify-schema-owner-'+label;
  if((await inspect())?.owner!==owner)fail('REHEARSAL_SCHEMA_OWNER_MISMATCH');
}
export async function snapshotWithRelationCapture(db,snapshotDatabase,fingerprintRows) {
  let values=null;
  const adapter={query:async(...args)=>{
    const result=await db.query(...args),sql=args[0];
    if(typeof sql==='string'&&sql.includes('c.relpersistence')&&sql.includes('c.relforcerowsecurity')&&
      sql.includes('pg_get_viewdef(c.oid,true)')){
      if(values!==null)fail('REHEARSAL_RELATION_CAPTURE_MULTIPLE');
      values=result.rows.map(row=>row.value);
    }
    return result;
  }};
  const snapshot=await snapshotDatabase(adapter),expected=snapshot['schema:relations'];
  if(values===null||!expected||values.length!==expected.count||fingerprintRows(values)!==expected.hash)
    fail('REHEARSAL_RELATION_CAPTURE_FINGERPRINT_MISMATCH');
  return {snapshot,relations:values.map(value=>JSON.parse(value))};
}
const canonicalJSON=value=>Array.isArray(value)?'['+value.map(canonicalJSON).join(',')+']':
  value!==null&&typeof value==='object'?'{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonicalJSON(value[k])).join(',')+'}':JSON.stringify(value);
export function safeRelationDiff(source,restored) {
  const key=row=>row.nspname+'\0'+row.relname;
  const label=row=>['public','app_private'].includes(row.nspname)&&/^[a-z_][a-z0-9_]{0,62}$/.test(row.relname)?
    row.nspname+'.'+row.relname:'OTHER_RELATION';
  const a=new Map(source.map(row=>[key(row),row])),b=new Map(restored.map(row=>[key(row),row]));
  if(a.size!==source.length||b.size!==restored.length)fail('REHEARSAL_DUPLICATE_RELATION_METADATA');
  const result={sourceRows:a.size,restoredRows:b.size,sourceOnlyObjects:[],restoredOnlyObjects:[],changed:[]};
  const counts=edges=>{const m=new Map();for(const edge of edges){const k=canonicalJSON(edge);m.set(k,(m.get(k)??0)+1);}return m;};
  const difference=(left,right)=>[...left].reduce((n,[k,v])=>n+Math.max(0,v-(right.get(k)??0)),0);
  for(const [id,row] of a){
    const other=b.get(id);if(!other){result.sourceOnlyObjects.push(label(row));continue;}
    const fields=['relkind','relpersistence','owner','relrowsecurity','relforcerowsecurity','relacl','view_definition']
      .filter(field=>canonicalJSON(row[field])!==canonicalJSON(other[field]));
    if(!fields.length)continue;
    const changed={object:label(row),fields};
    if(fields.includes('relacl')){const left=counts(row.relacl??[]),right=counts(other.relacl??[]);
      changed.acl={sourceEntries:(row.relacl??[]).length,restoredEntries:(other.relacl??[]).length,
        addedEdges:difference(right,left),removedEdges:difference(left,right)};}
    result.changed.push(changed);
  }
  for(const [id,row] of b)if(!a.has(id))result.restoredOnlyObjects.push(label(row));
  result.sourceOnlyObjects.sort();result.restoredOnlyObjects.sort();result.changed.sort((x,y)=>x.object.localeCompare(y.object));
  return result;
}
export async function readOnlyPostchecks(checks,strictMismatches=[]) {
  const results=[];
  for(const [gate,check] of checks){
    try{await check();results.push({gate,status:'PASS'});}
    catch(error){
      if(!strictMismatches.length)throw error;
      results.push({gate,status:'FAIL',code:/^[A-Z0-9_]{3,80}$/.test(error?.code??'')?error.code:'READONLY_POSTCHECK_FAILED'});
    }
  }
  return {passed:strictMismatches.length===0&&results.every(r=>r.status==='PASS'),strictMismatches,results};
}
function run(binary,args,{input,timeout=30000,diagnose=false}={}) {
  const result=spawnSync(binary,args,{env,input,encoding:'utf8',timeout,maxBuffer:4*1024*1024,
    stdio:[input===undefined?'ignore':'pipe','pipe',diagnose?'pipe':'ignore']});
  if(result.error||result.status!==0){
    if(diagnose)console.error('T16_FILE_RESTORE_FAILURE',JSON.stringify({exitStatus:result.status,
      signal:result.signal??null,...classifyRestoreFailure(result.stderr??'')}));
    fail('REHEARSAL_COMMAND_FAILED');
  }
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
export async function runDecodePipeline(commands,{capture=false,timeoutMs=300000}={}) {
  const children=commands.map(([binary,args])=>spawn(binary,args,{env,
    stdio:['pipe','pipe','pipe']}));
  const diagnostics=[];let diagnosticBytes=0;
  for(const c of children)c.stderr.on('data',b=>{if(diagnosticBytes<65536){
    const part=b.subarray(0,65536-diagnosticBytes);diagnostics.push(part);diagnosticBytes+=part.length;}});
  children[0].stdin.end();
  for(const c of children){c.stdin.on('error',()=>{});c.stdout.on('error',()=>{});
    c.once('exit',status=>{if(status!==0)for(const other of children)if(other!==c&&other.exitCode===null)other.kill();});}
  for(let i=0;i<children.length-1;i++){
    const source=children[i].stdout,destination=children[i+1].stdin;
    // An early successful consumer still requires complete producer draining:
    // age must authenticate its final chunk and zstd must reach its real EOF.
    const drain=()=>{source.unpipe(destination);source.resume();};
    destination.once('close',drain);destination.once('error',drain);children[i+1].once('exit',drain);
    source.pipe(destination);
  }
  const chunks=[];let bytes=0,overflow=false;
  children[2].stdout.on('data',b=>{if(capture){bytes+=b.length;if(bytes>4*1024*1024){overflow=true;children.forEach(c=>c.kill());}else chunks.push(b);}});
  const timer=setTimeout(()=>children.forEach(c=>c.kill()),timeoutMs);
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
const decode=(file,consumer,capture=false)=>runDecodePipeline([
  ['/usr/bin/age',['-d','-i',identity,file]],['/usr/bin/zstd',['-d','-c']],consumer],{capture});
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
  if(await hashFile(runtime+'/scripts/migration-audit.mjs')!=='a5306390fa06db03665caaaa988cadf472f17c349538712f03fa31f794d6bdea')
    fail('REHEARSAL_AUDITOR_SHA_MISMATCH');
  const {default:pg}=await import(runtime+'/node_modules/pg/lib/index.js');
  const {snapshotDatabase,compareSnapshots,fingerprintRows}=await import(runtime+'/scripts/migration-audit.mjs');
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
  const baselineCapture=await snapshotWithRelationCapture(primary,snapshotDatabase,fingerprintRows);
  const baseline=baselineCapture.snapshot;
  const baselineRoles=await globalRoleState(primary);
  const baselineDatabase=await databaseState(primary);
  const initialRole=(await primary.query('SELECT rolname,rolsuper FROM pg_roles WHERE oid=10')).rows[0];
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
  const [pinnedImage]=JSON.parse(d(['image','inspect',manifest.metadata.database_image]));
  const imageEnv=Object.fromEntries((pinnedImage.Config.Env??[]).map(e=>{const i=e.indexOf('=');return[e.slice(0,i),e.slice(i+1)];}));
  const archivedCompose=d(['exec',ownId,'cat','/restore-config/opt/bron/supabase/docker/docker-compose.yml']);
  const declaredDefault=/^\s*POSTGRES_USER:\s*["']?supabase_admin["']?\s*(?:#.*)?$/m.test(archivedCompose)?'supabase_admin':null;
  const bootstrap=manifest.metadata.bootstrap_role??declaredDefault??imageEnv.POSTGRES_USER;
  if(!bootstrap||bootstrap!==initialRole?.rolname||!initialRole.rolsuper)fail('REHEARSAL_BOOTSTRAP_IDENTITY_MISMATCH');
  const archivedRoles=(await decode(artifact('roles.sql'),['/usr/bin/cat',[]],true)).toString('utf8');
  const preparedRoles=prepareBootstrapGlobals(archivedRoles,bootstrap);
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
  // Native cluster bootstrap restores roles before role/security extension hooks.
  const nativeConfig=nativeGlobalsConfig(config);
  d(['exec','-i','--user','postgres',ownId,'/bin/sh','-c','cat > /restore-data/postgresql.auto.conf'],{input:nativeConfig});
  d(['exec','--user','postgres',ownId,'pg_ctl','-D','/restore-data','-l','/restore-data/server.log','-w','-t','45','start'],{timeout:60000});
  const psql=['psql','-h','/restore-socket','-U',bootstrap,'-d','postgres','-X','-q','-v','ON_ERROR_STOP=1',
    '-v','VERBOSITY=verbose','-v','SHOW_CONTEXT=never'];
  phase='restore-globals';
  const actor=JSON.parse(d(['exec',ownId,...psql,'-A','-t','--command',`SELECT json_build_object(
    'session_is_bootstrap',session_user=${sqlLiteral(bootstrap)},'current_is_session',current_user=session_user,
    'role_superuser',(SELECT rolsuper FROM pg_roles WHERE rolname=current_user),
    'setting_superuser',current_setting('is_superuser')='on',
    'shared_preload_empty',current_setting('shared_preload_libraries')='',
    'session_preload_empty',current_setting('session_preload_libraries')='',
    'reserved_roles_configured',coalesce(current_setting('supautils.reserved_roles',true),'')<>'',
    'configured_superuser_is_bootstrap',coalesce(current_setting('supautils.superuser',true),'')=session_user);`]));
  if(!actor.role_superuser||!actor.setting_superuser||!actor.shared_preload_empty||!actor.session_preload_empty)
    fail('REHEARSAL_NATIVE_GLOBALS_BOOTSTRAP_GUARD_FAILED');
  const marked=instrumentGlobals(preparedRoles.sql);
  const result=spawnSync('/usr/bin/docker',[...docker,'exec','-i',ownId,...psql,'-A','-t','--single-transaction'],{
    env,input:marked.sql,encoding:'utf8',timeout:300000,maxBuffer:1024*1024,stdio:['pipe','pipe','pipe']});
  const summary=globalsRunSummary(result,marked.steps);
  console.log('T14_NATIVE_GLOBALS_RESULT',JSON.stringify({actor,bootstrapCreateSkipped:preparedRoles.bootstrapCreateSkipped,...summary}));
  if(result.error||result.status!==0)fail('REHEARSAL_NATIVE_GLOBALS_FAILED');
  if(diagnose){if(compareSnapshots(baseline,await snapshotDatabase(primary)).length)fail('REHEARSAL_PRIMARY_CHANGED_DURING_RUN');
    console.log('T13_GLOBALS_DIAGNOSTIC',JSON.stringify({actor,diagnostic:'GLOBALS_RESTORED',
    restorePassed:false}));console.log('T13_DIAGNOSTICS_COMPLETE_NO_FULL_RESTORE');return;}
  phase='restore-exact-security-preloads';
  d(['exec','-i','--user','postgres',ownId,'/bin/sh','-c','cat > /restore-data/postgresql.auto.conf'],{input:config});
  d(['exec','--user','postgres',ownId,'pg_ctl','-D','/restore-data','-l','/restore-data/server.log',
    '-m','fast','-w','-t','45','restart'],{timeout:60000});
  const actualPreloads=JSON.parse(d(['exec',ownId,...psql,'-A','-t','--command',`SELECT json_object_agg(name,setting)
    FROM pg_settings WHERE name IN ('shared_preload_libraries','session_preload_libraries','cron.launch_active_jobs','pg_net.batch_size');`]));
  for(const name of ['shared_preload_libraries','session_preload_libraries'])
    if(actualPreloads[name]!==settings.find(s=>s.name===name)?.setting)fail('REHEARSAL_SECURITY_PRELOAD_RESTORE_MISMATCH');
  if(actualPreloads['cron.launch_active_jobs']!=='off'||actualPreloads['pg_net.batch_size']!=='0')
    fail('REHEARSAL_SCHEDULER_ISOLATION_FAILED');
  console.log('T14_EXACT_SECURITY_PRELOADS_RESTORED');
  phase='decrypt-complete-database-archive';
  const archiveFile='/restore-data/input.dump';
  await decode(artifact('database.dump'),owned(['/bin/sh','-c','umask 077; cat > /restore-data/input.dump']));
  phase='read-database-archive-toc';
  // --list follows restore selection: --create is necessary to expose DB metadata.
  const toc=d(['exec',ownId,'pg_restore','--list','--create',archiveFile],{timeout:300000,diagnose:true});
  const selected=partitionArchiveToc(toc);
  d(['exec','-i',ownId,'/bin/sh','-c','cat > /restore-data/database.list'],
    {input:selected.database.map(e=>e.line).join('\n')+'\n'});
  // Only the disposable cluster's initial empty postgres database is replaced.
  d(['exec',ownId,...psql.map(x=>x==='postgres'?'template1':x),'--command',
    "ALTER DATABASE postgres ALLOW_CONNECTIONS false; SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='postgres';"]);
  phase='restore-archived-database-definition';
  d(['exec',ownId,'pg_restore','-h','/restore-socket','-U',bootstrap,
    '--dbname=template1','--create','--clean','--if-exists','--exit-on-error','--use-list=/restore-data/database.list',archiveFile],
    {timeout:300000,diagnose:true});
  restored=new pg.Client({host:socket,user:bootstrap,database:'postgres',ssl:false,query_timeout:60000});
  await restored.connect();
  phase='bootstrap-exact-schema-and-extension-metadata';
  const prepared=new Set(),kept=selected.remaining,archiveSchemas=new Map(
    selected.administrativeCreates.filter(e=>e.kind==='SCHEMA').map(e=>[e.name,e.owner]));
  async function schema(name){
    if(prepared.has(name))return;
    const ns=namespaces.find(n=>n.name===name);if(!ns)fail('REHEARSAL_SCHEMA_METADATA_MISSING');
    if(archiveSchemas.has(name)&&archiveSchemas.get(name)!==ns.owner)fail('REHEARSAL_ARCHIVED_SCHEMA_OWNER_MISMATCH');
    await ensureRestoreSchema(restored,name,ns.owner);prepared.add(name);
  }
  for(const entry of selected.administrativeCreates){
    if(entry.kind==='SCHEMA')await schema(entry.name);
    else if(!extensions.some(e=>e.name===entry.name))fail('REHEARSAL_TOC_EXTENSION_UNKNOWN');
  }
  // Only duplicate administrative CREATE entries are omitted. Every data,
  // routine, trigger, policy, constraint, owner/ACL and sequence entry remains.
  // Extension install scripts can contain DO blocks without declaring the
  // builtin plpgsql dependency. Preserve its exact initdb state before any CREATE.
  phase='verify-preinstalled-builtin-extensions';
  const existingExtensions=(await restored.query(`SELECT e.extname AS name,e.extversion AS version,
    n.nspname AS schema,pg_get_userbyid(e.extowner) AS owner FROM pg_extension e
    JOIN pg_namespace n ON n.oid=e.extnamespace`)).rows;
  const created=preservedBuiltinExtensions(existingExtensions,manifest.metadata.extensions);
  console.log('T19_BUILTIN_PLPGSQL_PRESERVED',JSON.stringify({exactMetadataMatch:true,dropExecuted:false}));
  const dependencies=[];
  for(const e of manifest.metadata.extensions){phase='inspect-extension-version-'+extensionLabel(e.name);const row=(await restored.query(
    'SELECT requires FROM pg_available_extension_versions WHERE name=$1 AND version=$2',[e.name,e.version])).rows[0];
    if(!row)fail('REHEARSAL_EXTENSION_VERSION_UNAVAILABLE');
    for(const required of row.requires??[])dependencies.push({name:e.name,required});}
  const pending=manifest.metadata.extensions.filter(e=>!created.has(e.name));
  while(pending.length){
    const i=pending.findIndex(e=>dependencies.filter(d=>d.name===e.name).every(d=>created.has(d.required)));
    if(i<0)fail('REHEARSAL_EXTENSION_DEPENDENCY_CYCLE');
    const [e]=pending.splice(i,1);await schema(e.schema);
    console.log('T18_EXTENSION_BOOTSTRAP',JSON.stringify(safeExtensionMetadata(e)));
    phase='activate-extension-owner-'+extensionLabel(e.name);
    await restored.query('SET ROLE '+sqlIdent(e.owner));
    try{phase='create-extension-'+extensionLabel(e.name);
      await restored.query('CREATE EXTENSION '+sqlIdent(e.name)+' WITH SCHEMA '+sqlIdent(e.schema)+' VERSION '+sqlLiteral(e.version));}
    finally{await restored.query('RESET ROLE');}
    created.add(e.name);
  }
  d(['exec','-i',ownId,'/bin/sh','-c','cat > /restore-data/restore.list'],{input:kept.join('\n')});
  console.log('T11_ADMINISTRATIVE_BOOTSTRAP',JSON.stringify({schemas:prepared.size,extensions:created.size,
    duplicateCreateEntries:selected.administrativeCreates.length,databaseMetadataEntries:selected.database.length,
    archivedExtensionMetadata:!!manifest.metadata.extensions}));
  phase='restore-full-database';
  const restore=['exec','-e','PGOPTIONS=-c session_replication_role=replica',ownId,
    'pg_restore','-h','/restore-socket','-U',bootstrap,'--role=supabase_admin','--dbname=postgres',
    '--use-list=/restore-data/restore.list','--single-transaction','--exit-on-error',archiveFile];
  d(restore,{timeout:300000,diagnose:true});
  phase='verify-database-runtime-settings';
  if(normalizedSettings(dbSettings)!==normalizedSettings((await restored.query(dbSettingsSql)).rows))
    fail('REHEARSAL_DATABASE_SETTING_MISMATCH');
  if(JSON.stringify(baselineDatabase)!==JSON.stringify(await databaseState(restored)))
    fail('REHEARSAL_DATABASE_METADATA_ACL_OR_LABEL_MISMATCH');
  console.log('T17_DATABASE_METADATA_MATCH',JSON.stringify({metadata:true,acl:true,labels:true,dbRoleSettingsMatch:true}));
  const safe=(await restored.query(`SELECT current_setting('cron.launch_active_jobs') AS cron,
    current_setting('pg_net.batch_size') AS net,current_setting('listen_addresses') AS listen`)).rows[0];
  if(safe.cron!=='off'||safe.net!=='0'||safe.listen!=='')fail('REHEARSAL_SCHEDULER_ISOLATION_FAILED');
  phase='strict-restore-comparison';
  const restoredCapture=await snapshotWithRelationCapture(restored,snapshotDatabase,fingerprintRows);
  const mismatch=compareSnapshots(baseline,restoredCapture.snapshot);
  console.log('T11_RESTORE_MISMATCH_GROUPS',JSON.stringify(mismatch));
  if(mismatch.includes('schema:relations'))console.log('T20_RELATION_METADATA_DIFF',
    JSON.stringify(safeRelationDiff(baselineCapture.relations,restoredCapture.relations)));
  const postchecks=await readOnlyPostchecks([
    ['global_roles',async()=>{
      phase='verify-all-global-role-metadata';
      const restoredRoles=await globalRoleState(restored);
      const attributesMatch=JSON.stringify(baselineRoles.attributes)===JSON.stringify(restoredRoles.attributes);
      const membershipsMatch=JSON.stringify(baselineRoles.memberships)===JSON.stringify(restoredRoles.memberships);
      console.log('T20_GLOBAL_ROLE_CHECKS',JSON.stringify({attributesMatch,membershipsMatch,excludedRoles:0}));
      if(!attributesMatch)fail('REHEARSAL_GLOBAL_ROLE_ATTRIBUTES_MISMATCH');
      if(!membershipsMatch)fail('REHEARSAL_GLOBAL_MEMBERSHIPS_OR_GRANTORS_MISMATCH');
      console.log('T15_ALL_GLOBAL_ROLES_MATCH',JSON.stringify({roles:baselineRoles.attributes.length,
        memberships:baselineRoles.memberships.length,attributesMatch:true,grantorsAndAllOptionsMatch:true,excludedRoles:0}));
    }],
    ['extension_metadata',async()=>{
      phase='verify-extension-owner-and-version';
      const extRestored=(await restored.query(`SELECT e.extname AS name,e.extversion AS version,n.nspname AS schema,
        pg_get_userbyid(e.extowner) AS owner FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace`)).rows;
      if(sorted(extensions)!==sorted(extRestored))fail('REHEARSAL_EXTENSION_OWNER_OR_VERSION_MISMATCH');
    }],
    ['vault_logical',async()=>{
      phase='verify-vault-logical';
      const copy=`SET TIME ZONE ${sqlLiteral(settings.find(s=>s.name.toLowerCase()==='timezone').setting)};
        COPY (SELECT id,name,description,decrypted_secret,created_at,updated_at FROM vault.decrypted_secrets ORDER BY id)
        TO STDOUT WITH (FORMAT CSV,HEADER true);`;
      const copied=Buffer.from(d(['exec',ownId,...psql,'-A','-t','--command',copy]));
      const archived=await decode(artifact('vault-logical.csv'),['/usr/bin/cat',[]],true);
      if(!copied.equals(archived))fail('REHEARSAL_VAULT_LOGICAL_MISMATCH');
    }],
    ['storage_tree',async()=>{
      phase='verify-storage-tree';
      await decode(artifact('storage.tar'),owned(['tar','-x','-f','-','-C','/restore-storage']));
      if(tree('/proc/'+own.State.Pid+'/root/restore-storage')!==storageTree||tree(storageRoot)!==storageTree)
        fail('REHEARSAL_STORAGE_TREE_MISMATCH');
    }],
    ['primary_data_unchanged',async()=>{
      phase='verify-primary-data-unchanged';
      if(compareSnapshots(baseline,await snapshotDatabase(primary)).length)fail('REHEARSAL_PRIMARY_CHANGED_DURING_RUN');
    }],
    ['primary_roles_unchanged',async()=>{
      phase='verify-primary-roles-unchanged';
      if(JSON.stringify(baselineRoles)!==JSON.stringify(await globalRoleState(primary)))fail('REHEARSAL_PRIMARY_ROLES_CHANGED_DURING_RUN');
    }],
    ['primary_database_unchanged',async()=>{
      phase='verify-primary-database-unchanged';
      if(JSON.stringify(baselineDatabase)!==JSON.stringify(await databaseState(primary)))fail('REHEARSAL_PRIMARY_DATABASE_METADATA_CHANGED');
    }],
  ],mismatch);
  phase='readonly-postchecks-complete';
  console.log('T20_READONLY_POSTCHECKS',JSON.stringify(postchecks));
  if(!postchecks.passed)fail(mismatch.length?'REHEARSAL_STRICT_RESTORE_MISMATCH':'REHEARSAL_RESTORE_POSTCHECKS_FAILED');
  console.log('T11_TARGET_RESTORE_PASS',JSON.stringify({strictGroups:Object.keys(baseline).length,
    storageObjects:0,storageTreeMatches:true,vaultLogicalMatches:true,keyRecoveredFromEncryptedConfig:true,extensionOwnersMatch:true,
    sourceAccessed:false,productionWrites:false}));
} catch(error){
  if(phase.includes('extension')||phase.includes('schema'))console.error('T19_BOOTSTRAP_FAILURE',JSON.stringify({phase,...safeBootstrapError(error)}));
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
