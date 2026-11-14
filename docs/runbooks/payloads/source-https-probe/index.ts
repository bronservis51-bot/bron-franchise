// Temporary probe only: no application/Auth rows, arbitrary SQL, writes, or logging.
import pg from "npm:pg@8.23.1";
import { lookup } from "node:dns/promises";

const CAPABILITY_SHA256 = "{{CAPABILITY_SHA256}}";
const EXPIRES_EPOCH_MS = Number("{{EXPIRES_EPOCH_MS}}");
const PROJECT = "vkkqffvmztpzgygzfxhq";
const reply = (value: Record<string, unknown>, status = 200) => Response.json({
  probe_protocol: "BRON_HTTPS_PROBE_V1", ...value,
}, {
  status, headers: { "Cache-Control": "no-store", "Content-Type": "application/json" },
});

Deno.serve(async (req) => {
  const started = Date.now(), clients = new Set<InstanceType<typeof pg.Client>>();
  const deadline = Math.min(started + 24000, Number.isSafeInteger(EXPIRES_EPOCH_MS) ? EXPIRES_EPOCH_MS : started);
  let stage = "authorization", reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
  const stop = () => {
    stopped = true;
    reader?.cancel().catch(() => {});
    for (const client of clients) client.connection?.stream?.destroy();
  };
  const check = () => {
    if (stopped || req.signal.aborted || Date.now() >= deadline) throw Error("deadline");
  };
  const run = async () => {
    if (req.method !== "POST" || new URL(req.url).search ||
        !/^[a-f0-9]{64}$/.test(CAPABILITY_SHA256) ||
        !Number.isSafeInteger(EXPIRES_EPOCH_MS) || EXPIRES_EPOCH_MS <= started ||
        EXPIRES_EPOCH_MS - started > 7200000 || req.signal.aborted)
      return reply({ ok: false }, 403);
    if (req.headers.has("content-length") && req.headers.get("content-length") !== "64")
      return reply({ ok: false }, 403);
    reader = req.body?.getReader();
    if (!reader) return reply({ ok: false }, 403);
    const bytes = new Uint8Array(64);
    let length = 0;
    while (true) {
      const part = await reader.read();
      check();
      if (part.done) break;
      if (length + part.value.length > 64) return reply({ ok: false }, 403);
      bytes.set(part.value, length); length += part.value.length;
    }
    if (length !== 64 || !bytes.every(b => b >= 48 && b <= 57 || b >= 97 && b <= 102))
      return reply({ ok: false }, 403);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    let difference = 0;
    for (let i = 0; i < 32; i++)
      difference |= digest[i] ^ parseInt(CAPABILITY_SHA256.slice(i * 2, i * 2 + 2), 16);
    if (difference) return reply({ ok: false }, 403);
    check(); stage = "configuration";
    const u = new URL(Deno.env.get("SUPABASE_DB_URL") ?? "");
    const host = u.hostname, port = Number(u.port || 5432), user = decodeURIComponent(u.username);
    const direct = host === `db.${PROJECT}.supabase.co` && user === "postgres" && port === 5432;
    const pooler = /^aws-[0-2]-us-west-2\.pooler\.supabase\.com$/.test(host) &&
      user === `postgres.${PROJECT}` && [5432, 6543].includes(port);
    if (!["postgres:", "postgresql:"].includes(u.protocol) || (!direct && !pooler) ||
        u.pathname !== "/postgres" || !u.password || u.hash) throw Error("scope");
    stage = "dns";
    const { address } = await lookup(host); // One IP for both tests; pg preserves explicit SNI for IP hosts.
    check();
    const makeClient = (servername: string) => {
      const client = new pg.Client({ host: address, port, user,
        password: decodeURIComponent(u.password), database: "postgres",
        ssl: { rejectUnauthorized: true, servername },
        connectionTimeoutMillis: 6000, query_timeout: 6000,
        application_name: "bron-source-https-dummy-probe" });
      client.on("error", () => {}); clients.add(client); return client;
    };
    stage = "tls-negative";
    const negative = makeClient("bron-tls-negative.invalid");
    let negativeRejected = false;
    try { await negative.connect(); }
    catch (e) { negativeRejected = /cert|NotValidForName|dnsname|hostname/i.test(String(e instanceof Error ? e.message : e)); }
    finally { negative.connection?.stream?.destroy(); negative.end().catch(() => {}); }
    check();
    if (!negativeRejected) throw Error("identity-verification");
    stage = "connect";
    const client = makeClient(host);
    await client.connect(); check(); stage = "read-only";
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); check();
    await client.query("SET LOCAL statement_timeout = '5s'; SET LOCAL idle_in_transaction_session_timeout = '10s'");
    check(); stage = "dummy";
    const { rows: [identity] } = await client.query(`SELECT current_database() AS database,
      current_user AS role, session_user AS session_role,
      (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner,
      current_setting('transaction_read_only') AS read_only,
      current_setting('transaction_isolation') AS isolation,
      current_setting('statement_timeout') AS statement_timeout,
      current_setting('idle_in_transaction_session_timeout') AS idle_timeout,
      pg_backend_pid() AS pid, host(inet_server_addr()) AS server_address,
      clock_timestamp()::text AS database_time, repeat('x', 524288) AS dummy`);
    check();
    if (identity.database !== "postgres" || identity.role !== "postgres" ||
        identity.session_role !== "postgres" || identity.owner !== "postgres" ||
        identity.read_only !== "on" || identity.isolation !== "repeatable read" ||
        identity.statement_timeout !== "5s" || identity.idle_timeout !== "10s" ||
        identity.dummy !== "x".repeat(524288)) throw Error("invariant");
    stage = "rollback"; await client.query("ROLLBACK"); check();
    return reply({ ok: true, projectRef: PROJECT, host, port, resolved_address: address,
      tls_negative_rejected: true, tls_verification: "native-ca-and-hostname",
      started_epoch_ms: started, finished_epoch_ms: Date.now(), expires_epoch_ms: EXPIRES_EPOCH_MS,
      identity });
  };
  req.signal.addEventListener("abort", stop, { once: true });
  try {
    return await Promise.race([run(), new Promise<Response>(resolve => {
      timer = setTimeout(() => { stop(); resolve(reply({ ok: false, stage: "deadline" }, 504)); },
        Math.max(1, Math.min(24000, deadline - Date.now())));
    })]);
  } catch { return reply({ ok: false, stage }, 502); }
  finally {
    clearTimeout(timer); req.signal.removeEventListener("abort", stop); stop();
    for (const client of clients) client.end().catch(() => {});
  }
});
