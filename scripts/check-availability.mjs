// No real submissions, passwords or personal data. A honeypot exercises the landing contract without inserting a lead.
import {writeFileSync} from 'node:fs';
const url=process.env.VITE_SUPABASE_URL, key=process.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if(!url?.startsWith('https://')||!key||key.startsWith('sb_secret_'))throw Error('Public connection variables are missing or invalid');
async function check(target, init, valid){
 const start=Date.now();
 try{const r=await fetch(target,{...init,signal:AbortSignal.timeout(20_000),redirect:'error',cache:'no-store'});let body;try{body=await r.json();}catch{}
  return {ok:r.ok&&valid(body),http:r.status,ms:Date.now()-start};
 }catch{return{ok:false,http:0,ms:Date.now()-start};}
}
const headers={apikey:key,'Content-Type':'application/json'};
const [frontend,auth,data,landing]=await Promise.all([
 check('https://bronservis51-bot.github.io/bron-franchise/app-version.json',{},b=>typeof b?.build==='string'&&Number.isFinite(Date.parse(b.build))),
 check(`${url}/auth/v1/health`,{headers},b=>b?.name==='GoTrue'),
 check(`${url}/rest/v1/rpc/ping`,{method:'POST',headers,body:'{}'},b=>b==='ok'),
 check(`${url}/rest/v1/rpc/lead_submit`,{method:'POST',headers,body:JSON.stringify({p_lead:{website:'availability-check'}})},b=>b?.ok===true),
]);
const report={checked_at:new Date().toISOString(),checks:{frontend,auth,data,landing}};
writeFileSync(process.env.STATUS_OUTPUT??'/tmp/bron-status.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
if(Object.values(report.checks).some(v=>!v.ok))process.exitCode=1;
