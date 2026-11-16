// Source transport probe only. Never print config, password, TLS material or payload.
export const SOURCE_HOST='aws-1-us-west-2.pooler.supabase.com';
const SOURCE_USER='postgres.vkkqffvmztpzgygzfxhq';
const fail=code=>{throw Object.assign(new Error(code),{code});};
const safeCode=error=>['SOURCE_ROUTE_DEADLINE','SOURCE_ROUTE_IDENTITY','SOURCE_ROUTE_PAYLOAD','ECONNREFUSED','ECONNRESET','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','EAI_AGAIN','28000','28P01','53300','57014','08P01','08006'].includes(error?.code)?error.code:
  error?.message==='Query read timeout'?'PG_QUERY_READ_TIMEOUT':'SOURCE_ROUTE_FAILED';

export async function chooseSourceRoute({sourceConfig,Client,timeoutMs=10000,now=()=>Date.now()}){
  if(sourceConfig?.database!=='postgres'||sourceConfig.user!==SOURCE_USER||typeof sourceConfig.password!=='function'||
    sourceConfig.connectionString||sourceConfig.ssl?.rejectUnauthorized!==true||sourceConfig.ssl.servername!==SOURCE_HOST||
    !sourceConfig.ssl.ca||typeof sourceConfig.ssl.checkServerIdentity!=='function'||
    !((sourceConfig.host==='127.0.0.1'&&sourceConfig.port===15432)||(sourceConfig.host===SOURCE_HOST&&sourceConfig.port===5432))||
    !Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>10000)fail('SOURCE_ROUTE_CONFIG_UNSAFE');
  const routes=[{name:'canonical-session',host:SOURCE_HOST,port:5432},
    {name:'canonical-transaction',host:SOURCE_HOST,port:6543},
    ...(sourceConfig.host==='127.0.0.1'?[{name:'existing-reverse',host:'127.0.0.1',port:15432}]:[])];
  const diagnostics=[];
  for(const route of routes){
    const config={...sourceConfig,host:route.host,port:route.port,connectionTimeoutMillis:Math.min(5000,timeoutMs),query_timeout:timeoutMs};
    // Transaction pooler may reject startup options. Actual transaction mode is enforced below.
    if(route.port===6543)delete config.options;
    const client=new Client(config);client.on?.('error',()=>{});
    const started=now();let timer,cancelled=false;
    const check=()=>{if(cancelled)fail('SOURCE_ROUTE_DEADLINE');};
    const operation=(async()=>{
      await client.connect();check();
      await client.query('BEGIN READ ONLY');check();
      await client.query("SET LOCAL statement_timeout='5000'");check();
      const identity=(await client.query("SELECT current_database() AS db,current_user AS role,current_setting('transaction_read_only') AS read_only")).rows[0];check();
      if(identity?.db!=='postgres'||identity.role!=='postgres'||identity.read_only!=='on')fail('SOURCE_ROUTE_IDENTITY');
      const payload=(await client.query("SELECT repeat('x',1048576) AS payload")).rows[0]?.payload;check();
      if(typeof payload!=='string'||Buffer.byteLength(payload)!==1048576||!/^[x]+$/.test(payload))fail('SOURCE_ROUTE_PAYLOAD');
      await client.query('ROLLBACK');check();
      return {route:route.name,status:'PASS',bytes:1048576,elapsedMs:now()-started,identityVerified:true,readOnly:true};
    })();
    try{
      const result=await Promise.race([operation,new Promise((_,reject)=>{timer=setTimeout(()=>{cancelled=true;reject(Object.assign(new Error('SOURCE_ROUTE_DEADLINE'),{code:'SOURCE_ROUTE_DEADLINE'}));},timeoutMs);})]);
      diagnostics.push(result);return {config,diagnostics,selectedRoute:route.name};
    }catch(error){cancelled=true;diagnostics.push({route:route.name,status:'FAIL',code:safeCode(error),elapsedMs:now()-started});}
    finally{
      clearTimeout(timer);
      // No rollback is queued behind a timed-out query: disconnect rolls back server state.
      client.connection?.stream?.destroy();
      try{await Promise.race([Promise.resolve(client.end()),new Promise(resolve=>setTimeout(resolve,100))]);}catch{}
    }
  }
  return {config:null,diagnostics,selectedRoute:null};
}
