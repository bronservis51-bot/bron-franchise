// Trusted functions.exec orchestration. No Source/GitHub work occurs on file import.
// Invoke runT55CloudBroker({tools,notify,manifestSha256,jobDirectory}) only after pins.
async function runT55CloudBroker({tools, notify, yieldControl=async()=>{}, manifestSha256, jobDirectory,
  repoDirectory='/workspace/work/bron-franchise', maxWaitMs=480000}) {
  const fail = code => { throw Object.assign(new Error(code), {code}); };
  if (!/^[a-f0-9]{64}$/.test(manifestSha256 ?? '') ||
      jobDirectory!=='/workspace/artifacts/t55-relay' ||
      repoDirectory !== '/workspace/work/bron-franchise' || maxWaitMs !== 480000)
    fail('T55_BROKER_EXPLICIT_INPUT_REQUIRED');
  if(typeof tools?.mcp__codex_apps__supabase_execute_sql!=='function' ||
     typeof tools?.exec_command!=='function' ||typeof notify!=='function'||typeof yieldControl!=='function')
    fail('T55_BROKER_TOOLS_UNAVAILABLE');
  // POSIX single-quote escaping, not JSON-as-shell-escaping. No eval/command substitution.
  const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
  const prefix = ['python3', '-I', repoDirectory+'/docs/runbooks/payloads/t55-cloud-broker-io.py',
    '--manifest',repoDirectory+'/docs/runbooks/payloads/t55-relay-readiness.json',
    '--sha256',manifestSha256,'--job-directory',jobDirectory];
  const io = async args => {
    const r = await tools.exec_command({cmd: [...prefix,...args].map(quote).join(' '),
      workdir:repoDirectory, max_output_tokens:6000, yield_time_ms:10000});
    if (r.session_id) fail('T55_BROKER_IO_UNEXPECTED_ASYNC');
    let value; try { value=JSON.parse(r.output); } catch { fail('T55_BROKER_IO_JSON'); }
    if(r.exit_code!==0 || value.status==='BLOCKED') fail(value.code ?? 'T55_BROKER_IO_FAILED');
    return value;
  };
  const prepared=await io(['--prepare']);
  if(prepared.status!=='BROKER_PREPARED' || typeof prepared.query!=='string' ||
     prepared.projectId!=='vkkqffvmztpzgygzfxhq')fail('T55_BROKER_PREPARE_INVALID');
  notify('T55_BROKER_ARMED: automatic watcher running; no Source call made.');
  await yieldControl();
  const began=Date.now();let lastUpdate=began,claimed;
  while(Date.now()-began<maxWaitMs){
    const value=await io(['--poll-and-claim']);
    if(value.status==='MCP_CLAIMED'){claimed=value;break;}
    if(value.status!=='WAITING')fail('T55_BROKER_POLL_STATE');
    if(Date.now()-lastUpdate>=15000){notify('T55_BROKER_WAITING: Source calls=0; maintenance remains.');lastUpdate=Date.now();await yieldControl();}
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  if(!claimed)fail('T55_BROKER_WAIT_TIMEOUT');
  notify('T55_BROKER_REQUEST_CLAIMED: issuing one pinned technical MCP verification.');
  // Exactly one real MCP call. A thrown/error result never permits a retry or fake clock.
  let reply;
  try {reply=await tools.mcp__codex_apps__supabase_execute_sql({project_id:prepared.projectId,
    query:prepared.query});}
  catch (error) {
    const detail=JSON.stringify({name:typeof error?.name==='string'?error.name:'Error',
      message:typeof error?.message==='string'?error.message.slice(0,16000):'MCP call rejected or failed',
      code:typeof error?.code==='string'?error.code:null});
    try{await io(['--record-mcp-failure','MCP_RPC_FAILED','--failure-json',detail]);}catch{}
    fail('T55_BROKER_MCP_RPC_FAILED');
  }
  const raw=JSON.stringify(reply);
  if(typeof raw!=='string'||raw.length>65536){try{await io(['--record-mcp-failure','MCP_RAW_BOUND']);}catch{}fail('T55_BROKER_RAW_BOUND');}
  const published=await io(['--receive-raw-json',raw]);
  notify(JSON.stringify({task:'T55',status:published.status,responseSha256:published.responseSha256,
    rawSha256:published.rawSha256,brokerMcpCalls:1}));
  return published;
}
