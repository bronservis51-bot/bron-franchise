// GENERATED pure validator from admission-metadata-custody.mjs. No runtime Node imports.
// Regenerate only with its parity test; shared normalization is required for exact SQL SHA.
const MAX=1048576,encoder=new TextEncoder();
export const validatorSourceSha256="f65ce4f95fcc2ef916520b9bee66c3774b0783dbcbd73db038596646a2fd8124";
const ownError=Symbol('safe-custody-error');
const fail=code=>{throw Object.assign(new Error(code),{code,[ownError]:true});};
const exact=(x,keys)=>{
 if(x===null||typeof x!=='object'||Array.isArray(x)||![Object.prototype,null].includes(Object.getPrototypeOf(x)))
  fail('ADMISSION_CUSTODY_SHAPE');
 const own=Reflect.ownKeys(x);
 if(own.length!==keys.length||own.some(k=>typeof k!=='string'||!keys.includes(k)||
  !Object.hasOwn(Object.getOwnPropertyDescriptor(x,k),'value')||!Object.getOwnPropertyDescriptor(x,k).enumerable))
  fail('ADMISSION_CUSTODY_SHAPE');
};
const integer=(x,max=2147483647)=>Number.isSafeInteger(x)&&x>=0&&x<=max;
const text=x=>typeof x==='string'&&encoder.encode(x).length>0&&encoder.encode(x).length<=63&&!/[\x00-\x1f\x7f]/.test(x);
const array=(x,max)=>{
 if(!Array.isArray(x)||x.length>max||Reflect.ownKeys(x).length!==x.length+1)fail('ADMISSION_CUSTODY_METADATA_BOUND');
 for(let i=0;i<x.length;i++)if(!Object.hasOwn(x,i)||!Object.hasOwn(Object.getOwnPropertyDescriptor(x,i),'value')||
  !Object.getOwnPropertyDescriptor(x,i).enumerable)
  fail('ADMISSION_CUSTODY_METADATA_BOUND');
};
const canonical=x=>JSON.stringify(x,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?
 Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
const bytes=x=>{
 const result=encoder.encode(canonical(x)+'\n');
 if(result.length>MAX)fail('ADMISSION_CUSTODY_METADATA_BOUND');
 return result;
};

const roleKeys=['name','super','login','createRole','createDb','replication','bypass','connect','ownerPath'];
const backendKeys=['pid','role','type','state','openTransaction','super','providerAppKnown'];
const stateKeys=['db','actor','session','pid','readOnly','owner','signal','prepared','netQueued','runJobsExists',
 'unexpectedActiveCron','acl','roles','lookupOtherSetRoles','lookupCriticalWrites','lookupSequenceWrites',
 'lookupCriticalDefiners','backends','capturedMicros'];
// PostgreSQL extensions supply their own technical backend_type labels (cron/net
// included). Bound this existing field without pretending a closed enum fences workers.
const backendType=value=>typeof value==='string'&&/^[A-Za-z0-9_. -]{1,63}$/.test(value);
const backendStates=new Set(['active','idle','idle in transaction','idle in transaction (aborted)',
 'fastpath function call','disabled']);

// Exact stateSql fields only. In particular no Auth rows, hashes, role passwords,
// queries, cron command text, application names, client addresses or arbitrary data.
export function validateAdmissionMetadata(state){
 exact(state,stateKeys);
 if(['db','actor','session','owner'].some(k=>state[k]!=='postgres')||state.readOnly!=='on'||
  state.signal!==true||!integer(state.pid)||state.pid===0||typeof state.runJobsExists!=='boolean'||
  typeof state.capturedMicros!=='string'||!/^\d{12,20}$/.test(state.capturedMicros))fail('ADMISSION_CUSTODY_METADATA_IDENTITY');
 for(const k of ['prepared','netQueued','unexpectedActiveCron','lookupOtherSetRoles','lookupCriticalWrites',
  'lookupSequenceWrites','lookupCriticalDefiners'])if(!integer(state[k]))fail('ADMISSION_CUSTODY_METADATA_BOUND');
 array(state.roles,1024);array(state.acl,4096);array(state.backends,2048);
 for(const r of state.roles){exact(r,roleKeys);if(!text(r.name)||roleKeys.slice(1).some(k=>typeof r[k]!=='boolean'))
  fail('ADMISSION_CUSTODY_METADATA_SHAPE');}
 for(const e of state.acl){exact(e,['grantee','grantor','privilege','grantable']);
  if(!text(e.grantee)||!text(e.grantor)||!['CONNECT','CREATE','TEMPORARY'].includes(e.privilege)||typeof e.grantable!=='boolean')
   fail('ADMISSION_CUSTODY_METADATA_SHAPE');}
 for(const b of state.backends){exact(b,backendKeys);
  if(!integer(b.pid)||b.pid===0||(b.role!==null&&!text(b.role))||!backendType(b.type)||
   (b.state!==null&&!backendStates.has(b.state))||['openTransaction','super'].some(k=>typeof b[k]!=='boolean')||
   (b.providerAppKnown!==null&&typeof b.providerAppKnown!=='boolean'))
   fail('ADMISSION_CUSTODY_METADATA_SHAPE');}
 if(new Set(state.roles.map(r=>r.name)).size!==state.roles.length||
  new Set(state.backends.map(b=>b.pid)).size!==state.backends.length||
  new Set(state.acl.map(canonical)).size!==state.acl.length)fail('ADMISSION_CUSTODY_METADATA_DUPLICATE');
 // Canonical file readback and JSONB/MCP can have different object key order.
 // Common plan embeds JSON text: normalize identically on VPS AND Root first.
 bytes(state);return JSON.parse(canonical(state));
}

