import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source=fs.readFileSync(new URL('../../docs/runbooks/payloads/t56-cloud-broker.js',import.meta.url),'utf8');
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
    value={status:'BLOCKED',code:'T56_BROKER_MCP_RPC_FAILED'};
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
 vm.runInContext(source+'\nthis.run=runT56CloudBroker;',context);
 return {run:()=>context.run({tools,notify:value=>notifications.push(value),yieldControl:async()=>{},manifestSha256:'c'.repeat(64)}),calls,queries,rawReplies,notifications};
}
test('broker issues exactly five ordered calls and retains each actual reply before response publication',async()=>{
 const f=fixture();const result=await f.run();
 assert.deepEqual(f.calls,stages);assert.equal(f.queries.length,5);assert.equal(f.rawReplies.length,5);
 assert.equal(result.sourceMcpCalls,5);assert.equal(result.dataSnapshotsByBroker,0);
 assert.equal(result.status,'ALL_FIVE_TECHNICAL_RESPONSES_PUBLISHED');
 assert.match(f.notifications[0],/^T56_BROKER_ARMED/);
});
test('a rejected actual MCP call is recorded once and blocks later stages without a retry',async()=>{
 const f=fixture('before-target-write');
 await assert.rejects(f.run(),{code:'T56_BROKER_MCP_RPC_FAILED'});
 assert.deepEqual(f.calls,stages.slice(0,3));assert.equal(f.queries.length,3);assert.equal(f.rawReplies.length,2);
});
