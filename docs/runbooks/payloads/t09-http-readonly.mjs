// Temporary target gateway check. No login, email, successful submission or row writes.
import { execFileSync } from 'node:child_process';
import os from 'node:os';

export async function runTargetHttpChecks(db) {
  const fail = code => { throw Object.assign(new Error(code), { code }); };
  if (process.getuid?.() !== 0 || !Object.values(os.networkInterfaces()).flat()
    .some(x => x?.family === 'IPv4' && x.address === '152.228.115.115')) fail('HTTP_WRONG_VPS');
  const containers = JSON.parse(execFileSync('docker', ['--host','unix:///var/run/docker.sock',
    'inspect','supabase-db','supabase-envoy'], { encoding:'utf8',timeout:15000,
    stdio:['ignore','pipe','pipe'],maxBuffer:2*1024*1024 }));
  const database = containers.find(x=>x.Name==='/supabase-db');
  const gateway = containers.find(x=>x.Name==='/supabase-envoy');
  if (containers.length !== 2 || !database?.State?.Running || !gateway?.State?.Running)
    fail('HTTP_CONTAINER_IDENTITY_FAILED');
  const common = Object.keys(database.NetworkSettings?.Networks ?? {})
    .filter(name=>gateway.NetworkSettings?.Networks?.[name]?.IPAddress);
  if (common.length !== 1) fail('HTTP_GATEWAY_NETWORK_AMBIGUOUS');
  const address = gateway.NetworkSettings.Networks[common[0]].IPAddress;
  if (!/^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(address))
    fail('HTTP_GATEWAY_ADDRESS_UNEXPECTED');
  const entries = gateway.Config.Env.filter(x=>x.startsWith('ANON_KEY='));
  if (entries.length !== 1 || !entries[0].slice(9)) fail('HTTP_ANON_KEY_UNAVAILABLE');
  const anon = entries[0].slice(9);
  const counts = async () => (await db.query(`SELECT
    (SELECT count(*)::text FROM public.franchise_lead) AS leads,
    (SELECT count(*)::text FROM auth.users) AS users,
    (SELECT count(*)::text FROM auth.sessions) AS sessions`)).rows[0];
  const before = await counts();
  async function request(path, method='GET', body) {
    const response = await fetch(`http://${address}:8000${path}`, {
      method,redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{ apikey:anon,Authorization:`Bearer ${anon}`,
        Host:'api.bronservis.ru','Content-Type':'application/json' },
      body:body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json;
    try { json = JSON.parse(text); } catch { json = null; }
    return { status:response.status,json };
  }
  const health = await request('/auth/v1/health');
  if (health.status !== 200) fail('HTTP_AUTH_HEALTH_FAILED');
  const settings = await request('/auth/v1/settings');
  if (settings.status !== 200 || settings.json?.disable_signup !== true ||
      settings.json?.external?.email !== true) fail('HTTP_AUTH_SETTINGS_FAILED');
  const leadRead = await request('/rest/v1/franchise_lead?select=id&limit=1');
  const partnerRead = await request('/rest/v1/partner?select=id&limit=1');
  if (![401,403].includes(leadRead.status) || ![401,403].includes(partnerRead.status))
    fail('HTTP_ANONYMOUS_READ_NOT_DENIED');
  const validation = await request('/rest/v1/rpc/lead_submit','POST',{p_lead:{}});
  if (validation.status !== 400 || validation.json?.message !== 'validation')
    fail('HTTP_LEAD_VALIDATION_FAILED');
  const after = await counts();
  if (JSON.stringify(before) !== JSON.stringify(after)) fail('HTTP_ROW_COUNTS_CHANGED');
  return { scope:'INTERNAL_GATEWAY_ONLY',status:'PASS',authHealth:true,authSettings:true,
    anonymousLeadReadDenied:true,anonymousPartnerReadDenied:true,
    leadRpcValidation:true,rowCountsUnchanged:true,loginTested:false,
    successfulLeadSubmissionTested:false };
}
