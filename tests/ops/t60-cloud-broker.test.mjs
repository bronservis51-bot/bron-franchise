import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createCoordinatorFenceAck} from '../../docs/runbooks/payloads/coordinator-fence-ack-t60.mjs';

const source=fs.readFileSync(new URL('../../docs/runbooks/payloads/t60-cloud-broker.js',import.meta.url),'utf8');
const stages=['ready','start','before-target-write','before-final-audit','end'];
function fixture(failStage){
 const calls=[],queries=[],rawReplies=[],notifications=[];
 const tools={
  async exec_command({cmd}){
   const stage=cmd.match(/'--stage' '([^']+)'/)?.[1];
   let value;
   if(cmd.includes("'--prepare'"))value={status:'BROKER_PREPARED',projectId:'vkkqffvmztpzgygzfxhq',stages};
   else if(cmd.includes("'--poll-and-claim'")){
    calls.push(stage);value={status:'MCP_CLAIMED',stage,projectId:'vkkqffvmztpzgygzfxhq',query:'fixed technical SQL '+stage};
   }else if(cmd.includes("'--record-mcp-failure'")){
    value={status:'BLOCKED',code:'T60_BROKER_MCP_RPC_FAILED'};
   }else{
    const raw=cmd.match(/'--receive-raw-json' '([^']+)'/)?.[1];
    assert.ok(raw);rawReplies.push(JSON.parse(raw));
    value={status:'RESPONSE_PUBLISHED',stage,responseSha256:'a'.repeat(64),rawSha256:'b'.repeat(64)};
   }
   return {output:JSON.stringify(value),exit_code:0};
  },
  async mcp__codex_apps__supabase_execute_sql({project_id,query}){
   assert.equal(project_id,'vkkqffvmztpzgygzfxhq');queries.push(query);
   if(query.endsWith(failStage??'__never__'))throw new Error('offline fixture failure');
   return {content:[{type:'text',text:JSON.stringify([{status:'SOURCE_FENCE_CURRENTLY_VERIFIED',source_checked_micros:'1794739000000000'}])}]};
  },
 };
 const context=vm.createContext({setTimeout});
 vm.runInContext(source+'\nthis.run=runT60CloudBroker;',context);
 return {run:()=>context.run({tools,notify:value=>notifications.push(value),yieldControl:async()=>{},manifestSha256:'c'.repeat(64)}),calls,queries,rawReplies,notifications};
}
test('broker issues exactly five ordered calls and retains each actual reply before response publication',async()=>{
 const f=fixture();const result=await f.run();
 assert.deepEqual(f.calls,stages);assert.equal(f.queries.length,5);assert.equal(f.rawReplies.length,5);
 assert.equal(result.sourceMcpCalls,5);assert.equal(result.dataSnapshotsByBroker,0);
 assert.equal(result.status,'ALL_FIVE_TECHNICAL_RESPONSES_PUBLISHED');
 assert.match(f.notifications[0],/^T60_BROKER_ARMED/);
});
test('a rejected actual MCP call is recorded once and blocks later stages without a retry',async()=>{
 const f=fixture('before-target-write');
 await assert.rejects(f.run(),{code:'T60_BROKER_MCP_RPC_FAILED'});
 assert.deepEqual(f.calls,stages.slice(0,3));assert.equal(f.queries.length,3);assert.equal(f.rawReplies.length,2);
});

test('T60 ACK custody accepts all four bound stages with unchanged 60-second windows',async()=>{
 const directory=fs.mkdtempSync('/tmp/t60-ack-fixture-');fs.chmodSync(directory,0o700);
 const hash=value=>createHash('sha256').update(value).digest('hex'),seen=[];
 const activation={reviewed:true,actionId:'T60.final_https_window',manifestSha256:'a'.repeat(64),
  sourceProject:'vkkqffvmztpzgygzfxhq',sourceBarrierActionId:'T40.http_source_admission',
  sourceBarrierReceiptSha256:'0231b2ad09cb0a4fb11ff285c41b66a1274a3666ffe2889e37a49cd8ec41a1a6',
  verifyFencedSqlSha256:'fe7da8192bc58f7a95ca40851e4af15d1a7023d8b405bea08ca1da279c6e6782'};
 const barrierProof={sourceBarrierActionId:activation.sourceBarrierActionId,
  sourceBarrierReceiptSha256:activation.sourceBarrierReceiptSha256,normalConnectDenied:true,
  existingClientsDrained:true,freshOwnerReconnect:true,providerBoundaryReviewed:true,durableOnVps:true,sourcePaused:false};
 const ack=createCoordinatorFenceAck({activation,barrierProof,onChallenge:request=>{
  seen.push(request.stage);assert.equal(request.expiresEpochMs-request.createdEpochMs,60000);
  assert.ok(request.ackPath.startsWith('/root/bron-secrets/t60-release/'));
  const payload={format:1,protocol:'BRON_COORDINATOR_FENCE_ACK_V1',actionId:activation.actionId,
   manifestSha256:activation.manifestSha256,sourceProject:activation.sourceProject,
   sourceBarrierActionId:activation.sourceBarrierActionId,sourceBarrierReceiptSha256:activation.sourceBarrierReceiptSha256,
   verifyFencedSqlSha256:activation.verifyFencedSqlSha256,stage:request.stage,nonceSha256:request.nonceSha256,
   sourceCheckedMicros:String(BigInt(request.createdEpochMs)*1000n),expiresEpochMs:request.expiresEpochMs,
   normalConnectDenied:true,existingClientsDrained:true,providerBoundaryReviewed:true};
  const ackJson=JSON.stringify(Object.fromEntries(Object.keys(payload).sort().map(k=>[k,payload[k]])))+'\n';
  fs.writeFileSync(path.join(directory,path.basename(request.ackPath)),JSON.stringify({ackJson,rootAckSha256:hash(ackJson)}),{flag:'wx',mode:0o600});
 }},{directory,uid:process.getuid(),gid:process.getgid()});
 try{for(const stage of stages.slice(1))assert.equal((await ack.assertFence(stage)).currentAck.stage,stage);
  assert.deepEqual(seen,stages.slice(1));}finally{ack.close();fs.rmSync(directory,{recursive:true,force:true});}
});
