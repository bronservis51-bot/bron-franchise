// Fixed upstream, original publishable key and JWT. No credentials stored, logged or cached.
import http from 'node:http';
import {pathToFileURL} from 'node:url';
export function createGateway({upstream,key,origins,fetchImpl=fetch,timeoutMs=30_000}){
 const base=new URL(upstream);if(base.protocol!=='https:'||base.pathname!=='/')throw Error('An exact HTTPS API origin is required');
 if(!key?.startsWith('sb_publishable_'))throw Error('A publishable key is required');
 const allowed=new Set(origins);
 return http.createServer(async(req,res)=>{
  const cors=req.headers.origin;
  const end=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
  if(req.url==='/healthz'&&req.method==='GET')return end(200,{ok:true});
  if(cors&&!allowed.has(cors))return end(403,{error:'origin-not-allowed'});
  if(cors){res.setHeader('Access-Control-Allow-Origin',cors);res.setHeader('Vary','Origin');}
  res.setHeader('Access-Control-Expose-Headers','content-range,sb-request-id,x-request-id');
  if(req.method==='OPTIONS'){
   res.writeHead(204,{'Access-Control-Allow-Methods':'GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS','Access-Control-Allow-Headers':'apikey,authorization,content-type,x-client-info,x-request-id,prefer,range,range-unit,accept-profile,content-profile,x-upsert,x-supabase-api-version','Access-Control-Max-Age':'600'});res.end();return;
  }
  if(!['GET','HEAD','POST','PUT','PATCH','DELETE'].includes(req.method??''))return end(405,{error:'method-not-allowed'});
  // Reject absolute URLs, dot-segment escapes, other Supabase services and Auth admin routes.
  if(!req.url?.startsWith('/')||req.url.startsWith('//')||/%2e|%2f|%5c|\\|\.\./i.test(req.url))return end(400,{error:'invalid-path'});
  const target=new URL(req.url,base);
  const auth=/^\/auth\/v1\/(health|token|user|logout)$/.test(target.pathname);
  const data=target.pathname.startsWith('/rest/v1/');
  const storage=/^\/storage\/v1\/object\//.test(target.pathname);
  if(target.origin!==base.origin||(!auth&&!data&&!storage))return end(404,{error:'path-not-allowed'});
  if(req.headers.apikey!==key)return end(401,{error:'invalid-public-key'});
  const headers=new Headers({apikey:key});
  for(const name of ['authorization','content-type','x-client-info','x-request-id','prefer','range','range-unit','accept-profile','content-profile','x-upsert','x-supabase-api-version'])if(req.headers[name])headers.set(name,String(req.headers[name]));
  if(headers.get('authorization')?.startsWith('Bearer sb_secret_'))return end(403,{error:'secret-key-not-allowed'});
  let size=0;const chunks=[];
  try{
   for await(const chunk of req){size+=chunk.length;if(size>20*1024*1024)return end(413,{error:'body-too-large'});chunks.push(chunk);}
   const response=await fetchImpl(target,{method:req.method,headers,body:chunks.length?Buffer.concat(chunks):undefined,redirect:'manual',signal:AbortSignal.timeout(timeoutMs)});
   // Never follow a redirect containing credentials or proxy arbitrary destinations.
   if(response.status>=300&&response.status<400)return end(502,{error:'upstream-redirect'});
   for(const h of ['content-type','content-range','sb-request-id','x-request-id','content-disposition'])if(response.headers.has(h))res.setHeader(h,response.headers.get(h));
   res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
   res.writeHead(response.status);
   const reader=response.body?.getReader();if(reader){for(;;){const {done,value}=await reader.read();if(done)break;res.write(value);}}res.end();
  }catch{if(!res.headersSent)end(502,{error:'upstream-unavailable'});else res.destroy();}
 });
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const server=createGateway({upstream:process.env.SUPABASE_URL??'',key:process.env.SUPABASE_PUBLISHABLE_KEY??'',origins:(process.env.ALLOWED_ORIGINS??'').split(',').filter(Boolean)});
 server.requestTimeout=40_000;server.headersTimeout=15_000;
 server.listen(Number(process.env.PORT??8080),'0.0.0.0');
}
