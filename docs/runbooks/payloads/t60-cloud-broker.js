// Trusted, bounded functions.exec loop. Import alone performs no external action.
async function runT60CloudBroker({tools,notify,yieldControl=async()=>{},manifestSha256,
  jobDirectory='/workspace/artifacts/t60-final-relay',repoDirectory='/workspace/work/bron-franchise',
  maxWaitMs=1200000}) {
  const fail=code=>{throw Object.assign(new Error(code),{code});};
  const stages=['ready','start','before-target-write','before-final-audit','end'];
  if(!/^[a-f0-9]{64}$/.test(manifestSha256??'')||jobDirectory!=='/workspace/artifacts/t60-final-relay'||
    repoDirectory!=='/workspace/work/bron-franchise'||maxWaitMs!==1200000||
    typeof tools?.exec_command!=='function'||typeof tools?.mcp__codex_apps__supabase_execute_sql!=='function'||
    typeof notify!=='function'||typeof yieldControl!=='function')fail('T60_BROKER_EXPLICIT_INPUT_REQUIRED');
  const quote=v=>"'"+String(v).replaceAll("'","'\\''")+"'";
  const prefix=['python3','-I',repoDirectory+'/docs/runbooks/payloads/t60-cloud-broker-io.py',
    '--manifest',repoDirectory+'/docs/runbooks/payloads/t60-final-window.json','--sha256',manifestSha256,
    '--job-directory',jobDirectory];
  const io=async args=>{
    const r=await tools.exec_command({cmd:[...prefix,...args].map(quote).join(' '),workdir:repoDirectory,
      max_output_tokens:6500,yield_time_ms:10000});
    if(r.session_id)fail('T60_BROKER_IO_UNEXPECTED_ASYNC');
    let value;try{value=JSON.parse(r.output);}catch{fail('T60_BROKER_IO_JSON');}
    if(r.exit_code!==0||value.status==='BLOCKED')fail(value.code??'T60_BROKER_IO_FAILED');
    return value;
  };
  const prepared=await io(['--prepare']);
  if(prepared.status!=='BROKER_PREPARED'||prepared.projectId!=='vkkqffvmztpzgygzfxhq'||
    JSON.stringify(prepared.stages)!==JSON.stringify(stages))fail('T60_BROKER_PREPARE_INVALID');
  notify('T60_BROKER_ARMED: ordered automatic ready+four-ACK loop; Source calls=0; maintenance remains.');
  await yieldControl();
  const began=Date.now();let lastUpdate=began,calls=0;
  for(const stage of stages){
    let claimed;
    while(Date.now()-began<maxWaitMs){
      const value=await io(['--stage',stage,'--poll-and-claim']);
      if(value.status==='MCP_CLAIMED'){claimed=value;break;}
      if(value.status!=='WAITING'||value.stage!==stage)fail('T60_BROKER_POLL_STATE');
      if(Date.now()-lastUpdate>=15000){notify(JSON.stringify({task:'T60',status:'BROKER_WAITING',stage,
        sourceMcpCalls:calls,maintenance:true}));lastUpdate=Date.now();await yieldControl();}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    if(!claimed)fail('T60_BROKER_WAIT_TIMEOUT');
    if(claimed.stage!==stage||claimed.projectId!==prepared.projectId||typeof claimed.query!=='string')
      fail('T60_BROKER_CLAIM_INVALID');
    calls++;notify(JSON.stringify({task:'T60',status:'MCP_CHECK_STARTED',stage,sourceMcpCalls:calls}));
    let reply;
    try{reply=await tools.mcp__codex_apps__supabase_execute_sql({project_id:prepared.projectId,query:claimed.query});}
    catch(error){
      const detail=JSON.stringify({name:typeof error?.name==='string'?error.name:'Error',
        message:typeof error?.message==='string'?error.message.slice(0,16000):'MCP call rejected or failed',
        code:typeof error?.code==='string'?error.code:null});
      try{await io(['--stage',stage,'--record-mcp-failure','--failure-json',detail]);}catch{}
      fail('T60_BROKER_MCP_RPC_FAILED');
    }
    const raw=JSON.stringify(reply);
    if(typeof raw!=='string'||raw.length>65536){
      try{await io(['--stage',stage,'--record-mcp-failure','--failure-json','{"code":"RAW_BOUND"}']);}catch{}
      fail('T60_BROKER_RAW_BOUND');
    }
    const published=await io(['--stage',stage,'--receive-raw-json',raw]);
    if(published.status!=='RESPONSE_PUBLISHED'||published.stage!==stage)fail('T60_BROKER_PUBLISH_INVALID');
    notify(JSON.stringify({task:'T60',status:'RESPONSE_PUBLISHED',stage,sourceMcpCalls:calls,
      responseSha256:published.responseSha256,rawSha256:published.rawSha256}));
    await yieldControl();
  }
  return {task:'T60',status:'ALL_FIVE_TECHNICAL_RESPONSES_PUBLISHED',sourceMcpCalls:calls,
    dataSnapshotsByBroker:0,publicRelease:false};
}
