// Bounded read-only probe of the existing approved source route. Never log config or payload.
const SOURCE_HOST='aws-1-us-west-2.pooler.supabase.com';
const SOURCE_USER='postgres.vkkqffvmztpzgygzfxhq';
const LIMITS={connect:15000,begin:5000,serverDeadline:5000,identity:5000,small:5000,bulk:20000,rollback:5000};
const fail=code=>{throw Object.assign(new Error(code),{code});};
const safeCode=error=>{
  if(error?.message==='Query read timeout')return 'PG_QUERY_READ_TIMEOUT';
  if(error?.message==='Connection terminated due to connection timeout')return 'PG_CONNECT_TIMEOUT';
  if(error?.message==='Connection terminated unexpectedly')return 'PG_CONNECTION_TERMINATED';
  if(/^[0-9A-Z]{5}$/.test(error?.code??''))return error.code;
  if(['SOURCE_PROBE_DEADLINE','SOURCE_PROBE_IDENTITY','SOURCE_PROBE_PAYLOAD','SOURCE_BULK_SLOW',
    'ECONNRESET','ECONNREFUSED','EPIPE','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','EAI_AGAIN'].includes(error?.code))return error.code;
  return 'SOURCE_PROBE_FAILED';
};

export async function probeExistingSource({sourceConfig,Client,now=()=>Date.now(),deadlines=LIMITS}){
  if(sourceConfig?.database!=='postgres'||sourceConfig.user!==SOURCE_USER||typeof sourceConfig.password!=='function'||
    sourceConfig.connectionString||sourceConfig.ssl?.rejectUnauthorized!==true||sourceConfig.ssl.servername!==SOURCE_HOST||
    !sourceConfig.ssl.ca||typeof sourceConfig.ssl.checkServerIdentity!=='function'||
    !((sourceConfig.host==='127.0.0.1'&&sourceConfig.port===15432)||(sourceConfig.host===SOURCE_HOST&&sourceConfig.port===5432)))
    fail('SOURCE_PROBE_CONFIG_UNSAFE');
  for(const [stage,max] of Object.entries(LIMITS))if(!Number.isFinite(deadlines[stage])||deadlines[stage]<1||deadlines[stage]>max)
    fail('SOURCE_PROBE_DEADLINES_UNSAFE');
  const client=new Client({...sourceConfig,connectionTimeoutMillis:deadlines.connect,query_timeout:60000});
  client.on?.('error',()=>{});
  const stages=[];let failedStage=null,bulkPass=false;
  const phase=async(stage,operation,bytes)=>{
    failedStage=stage;const start=now();let timer;
    try{
      const result=await Promise.race([Promise.resolve().then(operation),new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(Object.assign(new Error('SOURCE_PROBE_DEADLINE'),{code:'SOURCE_PROBE_DEADLINE'})),deadlines[stage]);
      })]);
      const elapsedMs=now()-start;
      stages.push({stage,elapsedMs,...(bytes===undefined?{}:{bytes})});
      return {result,elapsedMs};
    }catch(error){stages.push({stage,elapsedMs:now()-start,code:safeCode(error)});throw error;}
    finally{clearTimeout(timer);}
  };
  try{
    await phase('connect',()=>client.connect());
    await phase('begin',()=>client.query('BEGIN READ ONLY'));
    await phase('serverDeadline',()=>client.query("SET LOCAL statement_timeout='5000'"));
    await phase('identity',async()=>{
      const row=(await client.query("SELECT current_database() AS db,current_user AS role,current_setting('transaction_read_only') AS read_only")).rows[0];
      if(row?.db!=='postgres'||row.role!=='postgres'||row.read_only!=='on')fail('SOURCE_PROBE_IDENTITY');
    });
    const dummy=async bytes=>{
      const value=(await client.query(`SELECT repeat('x',${bytes}) AS payload`)).rows[0]?.payload;
      if(typeof value!=='string'||Buffer.byteLength(value)!==bytes||!/^[x]+$/.test(value))fail('SOURCE_PROBE_PAYLOAD');
    };
    await phase('small',()=>dummy(1024),1024);
    const bulk=await phase('bulk',()=>dummy(1048576),1048576);
    bulkPass=bulk.elapsedMs<=10000;
    if(!bulkPass)fail('SOURCE_BULK_SLOW');
    await phase('rollback',()=>client.query('ROLLBACK'));
    failedStage=null;
    return {passed:true,failedStage,code:null,stages,bulkPass};
  }catch(error){return {passed:false,failedStage,code:safeCode(error),stages,bulkPass};}
  finally{
    // Disconnect our own connection, including when work is still pending. Do not
    // queue rollback behind a timed-out query or wait for a stalled stream to drain.
    client.connection?.stream?.destroy();
    let timer;
    try{await Promise.race([Promise.resolve(client.end()),new Promise(resolve=>{timer=setTimeout(resolve,100);})]);}
    catch{}finally{clearTimeout(timer);}
  }
}
