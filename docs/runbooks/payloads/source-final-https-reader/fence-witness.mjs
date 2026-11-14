// Pure fixed metadata validation only. No Source effects, client SQL or credentials.
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const keys=(value,names)=>object(value)&&Object.keys(value).sort().join(',')===[...names].sort().join(',');
const positivePid=value=>Number.isInteger(value)&&value>0;
const fail=code=>{throw Object.assign(new Error(code),{code});};
const micros=value=>typeof value==='string'&&/^\d{12,20}$/.test(value);

// Byte-for-byte SQL parity is checked against the reviewed HTTP admission helper.
export const freshOwnerWitnessSql=`SELECT jsonb_build_object('db',current_database(),
 'actor',current_user,'session',session_user,'readOnly',current_setting('transaction_read_only'),
 'isolation',current_setting('transaction_isolation'),
 'owner',(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()),
 'pid',pg_backend_pid(),'backendStartMicros',floor(extract(epoch FROM backend_start)*1000000)::numeric::text)
 AS witness FROM pg_stat_activity WHERE pid=pg_backend_pid()`;

// Root renders a JSON object literal, then pins exactly JSON.stringify(context),
// as final-https-window.mjs does. The private capability is checked before this.
export async function validateFenceContext(context,expectedSha256){
 if(!keys(context,['sourceBarrierActionId','sourceBarrierReceiptSha256','before','boundary'])||
  !/^T[1-9][0-9]{1,3}\.http_source_admission$/.test(context.sourceBarrierActionId??'')||
  !/^[a-f0-9]{64}$/.test(context.sourceBarrierReceiptSha256??'')||
  !/^[a-f0-9]{64}$/.test(expectedSha256??'')||
  !keys(context.before,['backends'])||!Array.isArray(context.before.backends)||context.before.backends.length>1000||
  !context.before.backends.every(b=>keys(b,['pid'])&&positivePid(b.pid))||
  !keys(context.boundary,['capturedMicros','ownerPids'])||!micros(context.boundary.capturedMicros)||
  !Array.isArray(context.boundary.ownerPids)||context.boundary.ownerPids.length>1000||
  !context.boundary.ownerPids.every(positivePid))fail('FINAL_READER_FENCE_CONTEXT_INVALID');
 const bytes=new TextEncoder().encode(JSON.stringify(context));
 if(bytes.length>65536)fail('FINAL_READER_FENCE_CONTEXT_INVALID');
 const computed=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
 if(computed!==expectedSha256)fail('FINAL_READER_FENCE_CONTEXT_SHA');
 return structuredClone(context);
}

// Same fresh PID/start predicates as validateFreshOwnerWitness, plus RR and positive PID.
export function validateFenceWitness(context,witness){
 const oldPids=new Set([...context.boundary.ownerPids,...context.before.backends.map(b=>b.pid)]);
 if(!object(witness)||witness.db!=='postgres'||witness.actor!=='postgres'||witness.session!=='postgres'||
  witness.owner!=='postgres'||witness.readOnly!=='on'||witness.isolation!=='repeatable read'||
  !positivePid(witness.pid)||oldPids.has(witness.pid)||!micros(witness.backendStartMicros)||
  BigInt(witness.backendStartMicros)<=BigInt(context.boundary.capturedMicros))
  fail('FINAL_READER_FRESH_PHYSICAL_BACKEND_NOT_PROVED');
 return {...witness,preDataValidated:true,sourceBarrierActionId:context.sourceBarrierActionId,
  sourceBarrierReceiptSha256:context.sourceBarrierReceiptSha256};
}
