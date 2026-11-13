// Temporary staging-only builder. No publication, dependency install or database calls.
// BRON_RELEASE_CONFIG names a private JSON file; public keys are never command arguments.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const TARGET = 'https://api.bronservis.ru';
const SOURCE = 'https://vkkqffvmztpzgygzfxhq.supabase.co';
const LANDING_COMMIT = 'fb5210c6de3ac6df93bad2ddf0306a1856e98b73';
const fail = code => { throw Object.assign(new Error(code), { code }); };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function run(binary, args, cwd, extra = {}) {
  try { return execFileSync(binary, args, { cwd, maxBuffer:64*1024*1024,
    stdio:['pipe','pipe','pipe'], ...extra }); }
  catch { fail('RELEASE_COMMAND_FAILED'); }
}
function anonKey(key, legacyOnly=false) {
  if (typeof key !== 'string') fail('RELEASE_ANON_KEY_INVALID');
  if (!legacyOnly && /^sb_publishable_[A-Za-z0-9_-]{20,100}$/.test(key)) return;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key))
    fail('RELEASE_ANON_KEY_INVALID');
  try {
    const payload = JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString());
    if (payload.role !== 'anon' || !(payload.exp > Date.now()/1000 + 86400))
      fail('RELEASE_ANON_KEY_INVALID');
  } catch { fail('RELEASE_ANON_KEY_INVALID'); }
}
function privateConfig() {
  const filename = process.env.BRON_RELEASE_CONFIG;
  if (!filename) fail('RELEASE_CONFIG_REQUIRED');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let config;
  try {
    const info=fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o600 || info.size>65536)
      fail('RELEASE_CONFIG_NOT_PRIVATE');
    config=JSON.parse(fs.readFileSync(fd,'utf8'));
  } finally { fs.closeSync(fd); }
  if (Object.keys(config).some(k=>!['appRepo','landingRepo','appCommit','landingCommit','anonKey','sourceAnonKey'].includes(k)) ||
      !/^[0-9a-f]{40}$/.test(config.appCommit) || config.landingCommit !== LANDING_COMMIT)
    fail('RELEASE_CONFIG_INVALID');
  anonKey(config.anonKey);
  if (config.sourceAnonKey !== undefined) anonKey(config.sourceAnonKey,true);
  for (const key of ['appRepo','landingRepo']) {
    if (typeof config[key] !== 'string' || !path.isAbsolute(config[key])) fail('RELEASE_REPO_PATH_INVALID');
    config[key]=fs.realpathSync(config[key]);
  }
  return config;
}
function archive(repo, commit, destination) {
  if (run('git',['cat-file','-t',commit],repo).toString().trim() !== 'commit') fail('RELEASE_COMMIT_INVALID');
  fs.mkdirSync(destination,{mode:0o700});
  run('tar',['-xf','-','-C',destination],repo,{ input:run('git',['archive','--format=tar',commit],repo) });
  // Git-tracked example configuration is harmless; local dotenv files must never enter builds.
  if (fs.readdirSync(destination).some(x=>/^\.env(?:\.|$)/.test(x) && x!=='.env.example'))
    fail('RELEASE_TRACKED_DOTENV');
}
function files(directory) {
  const result=[];
  function visit(relative) {
    for (const name of fs.readdirSync(path.join(directory,relative)).sort()) {
      const file=path.join(relative,name),info=fs.lstatSync(path.join(directory,file));
      if (info.isDirectory()) visit(file);
      else if (info.isFile()) result.push(file.split(path.sep).join('/'));
      else fail('RELEASE_ARTIFACT_SYMLINK');
    }
  }
  visit(''); return result;
}
export function manifest(directory, metadata) {
  const entries=files(directory).map(file=>{
    const bytes=fs.readFileSync(path.join(directory,file));
    return {file,bytes:bytes.length,sha256:sha(bytes)};
  });
  const record={format:1,...metadata,files:entries};
  const bytes=JSON.stringify(record,null,2)+'\n';
  fs.writeFileSync(path.join(directory,'release-manifest.json'),bytes,{mode:0o600,flag:'wx'});
  const archive=directory+'.tar';
  if (fs.existsSync(archive)) fail('RELEASE_ARCHIVE_EXISTS');
  run('tar',['-cf',archive,'-C',directory,'.'],directory);
  return {bundle:path.basename(directory),sourceCommit:metadata.sourceCommit,
    files:entries.length,manifestSha256:sha(bytes),archive:path.basename(archive),
    archiveBytes:fs.statSync(archive).size,archiveSha256:sha(fs.readFileSync(archive)),
    base:metadata.base,apiOrigin:metadata.apiOrigin};
}
export function transformLanding(original, origin, key) {
  anonKey(key);
  const api=/\bvar API='https:\/\/vkkqffvmztpzgygzfxhq\.supabase\.co\/rest\/v1\/rpc\/lead_submit', KEY='sb_publishable_[A-Za-z0-9_-]+'(?=, WA=)/g;
  if ([...original.matchAll(api)].length!==1 || original.split('id="q-consent" checked').length!==2 ||
      original.split('https://bronservis51-bot.github.io/bronservice-franchise/og-image.jpg').length!==2)
    fail('RELEASE_LANDING_SOURCE_UNEXPECTED');
  const changed=original.replace(api,`var API=${JSON.stringify(origin+'/rest/v1/rpc/lead_submit')}, KEY=${JSON.stringify(key)}`)
    .replace('id="q-consent" checked','id="q-consent"')
    .replace('https://bronservis51-bot.github.io/bronservice-franchise/og-image.jpg',
      origin===TARGET?'https://bronservis.ru/og-image.jpg':'https://bronservis51-bot.github.io/bronservice-franchise/og-image.jpg');
  // Check that queue/form logic has not changed beyond the endpoint/key declaration.
  const scripts=html=>[...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(x=>x[1]);
  const before=scripts(original.replace(api,'var API=PUBLIC_ENDPOINT, KEY=PUBLIC_KEY'));
  const replacement=`var API=${JSON.stringify(origin+'/rest/v1/rpc/lead_submit')}, KEY=${JSON.stringify(key)}`;
  const after=scripts(changed.replace(replacement,'var API=PUBLIC_ENDPOINT, KEY=PUBLIC_KEY'));
  if (JSON.stringify(before)!==JSON.stringify(after)) fail('RELEASE_LANDING_LOGIC_CHANGED');
  return changed;
}
async function main() {
  process.umask(0o077);
  const config=privateConfig();
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bron-release-artifacts-'));
  const source=path.join(root,'app-source');
  archive(config.appRepo,config.appCommit,source);
  const modules=fs.realpathSync(path.join(config.appRepo,'node_modules'));
  fs.symlinkSync(modules,path.join(source,'node_modules'),'dir');
  const env={...process.env};
  for (const key of Object.keys(env)) if (/^(VITE_|SUPABASE_|BRON_RELEASE_)/.test(key)) delete env[key];
  run('npm',['ls','--depth=0','--omit=optional'],source,{env});
  const versions={node:process.version,npm:run('npm',['--version'],source,{env}).toString().trim(),
    packageLockSha256:sha(fs.readFileSync(path.join(source,'package-lock.json')))};
  const summaries=[];
  function app(name,base,origin,key) {
    run('npm',['run','build'],source,{env:{...env,VITE_BASE_PATH:base,VITE_SUPABASE_URL:origin,
      VITE_SUPABASE_PUBLISHABLE_KEY:key,VITE_APP_ENV:'production',VITE_APP_VERSION:'0.1.0+'+config.appCommit.slice(0,12)}});
    const out=path.join(root,name);
    fs.renameSync(path.join(source,'dist'),out);
    const pwa=JSON.parse(fs.readFileSync(path.join(out,'manifest.webmanifest'),'utf8'));
    const version=JSON.parse(fs.readFileSync(path.join(out,'app-version.json'),'utf8'));
    const html=fs.readFileSync(path.join(out,'index.html'),'utf8');
    const js=files(out).filter(x=>x.endsWith('.js')).map(x=>fs.readFileSync(path.join(out,x),'utf8')).join('\n');
    if (pwa.start_url!==base || pwa.scope!==base || !html.includes(origin) || !js.includes(origin) || !js.includes(key) ||
        js.includes('https://example.supabase.co') || /sb_secret_[A-Za-z0-9_-]{20,}/.test(js))
      fail('RELEASE_APP_CONFIGURATION_FAILED');
    if (base!=='/') { fs.copyFileSync(path.join(out,'index.html'),path.join(out,'404.html'));fs.writeFileSync(path.join(out,'.nojekyll'),''); }
    summaries.push(manifest(out,{kind:'app',sourceCommit:config.appCommit,base,apiOrigin:origin,buildTime:version.build,...versions}));
  }
  app('app-root','/',TARGET,config.anonKey);
  app('app-legacy','/bron-franchise/',TARGET,config.anonKey);
  const landingSource=path.join(root,'landing-source');
  archive(config.landingRepo,config.landingCommit,landingSource);
  function landing(name,origin,key) {
    const out=path.join(root,name);fs.mkdirSync(out,{mode:0o700});
    for (const file of files(landingSource)) if (file!=='README.md')
      fs.cpSync(path.join(landingSource,file),path.join(out,file),{recursive:true});
    const index=path.join(out,'index.html');
    fs.writeFileSync(index,transformLanding(fs.readFileSync(index,'utf8'),origin,key));
    summaries.push(manifest(out,{kind:'landing',sourceCommit:config.landingCommit,base:'/',apiOrigin:origin,
      transforms:['public_api_key','consent_unchecked','og_image_origin']}));
  }
  landing('landing-root',TARGET,config.anonKey);
  if (config.sourceAnonKey) {
    app('app-source-rollback','/bron-franchise/',SOURCE,config.sourceAnonKey);
    landing('landing-source-rollback',SOURCE,config.sourceAnonKey);
  }
  fs.rmSync(source,{recursive:true});
  fs.rmSync(landingSource,{recursive:true});
  fs.writeFileSync(path.join(root,'build-summary.json'),JSON.stringify({appCommit:config.appCommit,
    landingCommit:config.landingCommit,bundles:summaries},null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log('RELEASE_ARTIFACTS_READY',JSON.stringify({directory:root,bundles:summaries}));
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try { await main(); }
  catch(error) { console.error('RELEASE_BUILD_BLOCKED',/^RELEASE_[A-Z_]+$/.test(error.code??'')?error.code:'RELEASE_BUILD_FAILED');process.exitCode=1; }
}
