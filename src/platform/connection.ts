// Read-only probes. A timeout describes the observation, never its unproven cause.
export type Probe = { ok: boolean; code: string; ms: number };
export type Connection = { checkedAt: string; auth: Probe; data: Probe };
export async function probe(url: string, key: string, service: 'auth' | 'data', signal?: AbortSignal, timeoutMs = 20_000): Promise<Probe> {
  const start = performance.now(); const ctrl = new AbortController();
  const abort = () => ctrl.abort(); signal?.addEventListener('abort', abort, {once:true});
  const timer = setTimeout(abort, timeoutMs);
  try {
    if (signal?.aborted) ctrl.abort();
    const r = await fetch(`${url}${service === 'auth' ? '/auth/v1/health' : '/rest/v1/rpc/ping'}`, {
      method: service === 'auth' ? 'GET' : 'POST', headers: {apikey:key,'Content-Type':'application/json'},
      ...(service === 'data' ? {body:'{}'} : {}), signal:ctrl.signal, cache:'no-store', credentials:'omit',
    });
    if (!r.ok) return {ok:false,code:`${service.toUpperCase()}-HTTP-${r.status}`,ms:Math.round(performance.now()-start)};
    let body: unknown;
    try { body=await r.json(); } catch { return {ok:false,code:`${service.toUpperCase()}-RESPONSE`,ms:Math.round(performance.now()-start)}; }
    const valid = service === 'auth' ? typeof body === 'object' && body !== null && 'name' in body && body.name==='GoTrue' : body === 'ok';
    return {ok:valid,code:valid ? 'OK' : `${service.toUpperCase()}-RESPONSE`,ms:Math.round(performance.now()-start)};
  } catch {
    return {ok:false,code:`${service.toUpperCase()}-${ctrl.signal.aborted ? 'TIMEOUT' : 'NETWORK'}`,ms:Math.round(performance.now()-start)};
  } finally { clearTimeout(timer); signal?.removeEventListener('abort',abort); }
}
export async function checkConnection(url: string, key: string, signal?: AbortSignal): Promise<Connection> {
  const [auth,data] = await Promise.all([probe(url,key,'auth',signal),probe(url,key,'data',signal)]);
  return {checkedAt:new Date().toISOString(),auth,data};
}
export function connectionSummary(c: Connection): string {
  if(c.auth.ok && c.data.ok) return 'С этого устройства сервер входа и база данных отвечают.';
  if(c.auth.ok) return 'Сервер входа отвечает, но проверка базы данных не прошла.';
  if(c.data.ok) return 'База данных отвечает, но проверка сервера входа не прошла.';
  return 'Проверка связи с сервером не прошла. Причиной могут быть задержка, сеть или сбой сервиса.';
}
export function diagnosticText(c: Connection | null, online: boolean, version: string): string {
  // Allowlisted fields only: no login, password, URL query, token, customer data or storage.
  return JSON.stringify({at:new Date().toISOString(),version,online,connection:c},null,2);
}
