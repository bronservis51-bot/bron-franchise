// Temporary witness-only version. No Auth/business snapshot, writes, client SQL,
// function slug, filesystem or logging. The same slug may later serve a separately
// rendered final-data version; protocol-specific HKDF prevents envelope confusion.
import pg from "npm:pg@8.23.1";
import { lookup } from "node:dns/promises";
import { freshOwnerWitnessSql, validateFenceContext, validateFenceWitness } from "./fence-witness.mjs";
import { encryptWitness } from "./encrypt-witness.mjs";

const CAPABILITY_SHA256 = "{{CAPABILITY_SHA256}}";
const EXPIRES_EPOCH_MS = Number("{{EXPIRES_EPOCH_MS}}");
const FENCE_CONTEXT: unknown = {{FENCE_CONTEXT_JSON}};
const FENCE_CONTEXT_SHA256 = "{{FENCE_CONTEXT_SHA256}}";
const PROJECT = "vkkqffvmztpzgygzfxhq", DESTINATION_VPS = "152.228.115.115";
const PROTOCOL = "BRON_SOURCE_FENCE_WITNESS_V1";
const reply = (body: Record<string, unknown>, status = 200) => Response.json({protocol: PROTOCOL, ...body}, {
 status, headers: {"Cache-Control": "no-store", "Content-Type": "application/json"},
});
const identitySql = `SELECT current_database() AS database, current_user AS role, session_user AS session_role,
 (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()) AS owner,
 current_setting('transaction_read_only') AS read_only, current_setting('transaction_isolation') AS isolation,
 current_setting('statement_timeout') AS statement_timeout,
 current_setting('idle_in_transaction_session_timeout') AS idle_timeout,
 pg_backend_pid() AS pid, clock_timestamp()::text AS database_time`;

Deno.serve(async (req) => {
 const started = Date.now(), clients = new Set<InstanceType<typeof pg.Client>>();
 const deadline = Math.min(started + 30000, Number.isSafeInteger(EXPIRES_EPOCH_MS) ? EXPIRES_EPOCH_MS : started);
 let stage = "authorization", reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
 let timer: ReturnType<typeof setTimeout> | undefined, stopped = false;
 const capability = new Uint8Array(64);
 const stop = () => {
  stopped = true;reader?.cancel().catch(() => {});
  for (const client of clients) client.connection?.stream?.destroy();
 };
 const check = () => {if (stopped || req.signal.aborted || Date.now() >= deadline) throw Error("deadline");};
 const run = async () => {
  if (req.method !== "POST" || new URL(req.url).search || !/^[a-f0-9]{64}$/.test(CAPABILITY_SHA256) ||
   !Number.isSafeInteger(EXPIRES_EPOCH_MS) || EXPIRES_EPOCH_MS <= started ||
   EXPIRES_EPOCH_MS - started > 7200000 || req.signal.aborted) return reply({ok: false}, 403);
  if (req.headers.has("content-length") && req.headers.get("content-length") !== "64") return reply({ok: false}, 403);
  reader = req.body?.getReader();if (!reader) return reply({ok: false}, 403);
  let length = 0;
  while (true) {
   const part = await reader.read();check();if (part.done) break;
   if (length + part.value.length > 64) return reply({ok: false}, 403);
   capability.set(part.value, length);length += part.value.length;
  }
  if (length !== 64 || !capability.every(b => b >= 48 && b <= 57 || b >= 97 && b <= 102)) return reply({ok: false}, 403);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", capability));let difference = 0;
  for (let i = 0; i < 32; i++) difference |= digest[i] ^ parseInt(CAPABILITY_SHA256.slice(i * 2, i * 2 + 2), 16);
  if (difference) return reply({ok: false}, 403);
  check();stage = "fence-context";
  const context = await validateFenceContext(FENCE_CONTEXT, FENCE_CONTEXT_SHA256);
  if (context.before.backends.some((b: {pid: number}) => b.pid > 2147483647) ||
   context.boundary.ownerPids.some((pid: number) => pid > 2147483647)) throw Error("pid-bound");
  check();stage = "configuration";
  const u = new URL(Deno.env.get("SUPABASE_DB_URL") ?? "");
  const host = u.hostname, port = Number(u.port || 5432), user = decodeURIComponent(u.username);
  const direct = host === `db.${PROJECT}.supabase.co` && user === "postgres" && port === 5432;
  const pooler = /^aws-[0-2]-us-west-2\.pooler\.supabase\.com$/.test(host) &&
   user === `postgres.${PROJECT}` && [5432, 6543].includes(port);
  if (!["postgres:", "postgresql:"].includes(u.protocol) || (!direct && !pooler) ||
   u.pathname !== "/postgres" || !u.password || u.hash) throw Error("scope");
  stage = "dns";const {address} = await lookup(host);check();
  const makeClient = (servername: string) => {
   const client = new pg.Client({host: address, port, user, password: decodeURIComponent(u.password), database: "postgres",
    ssl: {rejectUnauthorized: true, servername}, connectionTimeoutMillis: 6000, query_timeout: 6000,
    application_name: "bron-source-fence-witness"});
   client.on("error", () => {});clients.add(client);return client;
  };
  stage = "tls-negative";const negative = makeClient("bron-tls-negative.invalid");let negativeRejected = false;
  try {await negative.connect();}
  catch (e) {negativeRejected = /cert|NotValidForName|dnsname|hostname/i.test(String(e instanceof Error ? e.message : e));}
  finally {negative.connection?.stream?.destroy();negative.end().catch(() => {});}
  check();if (!negativeRejected) throw Error("identity-verification");
  stage = "connect";const client = makeClient(host);await client.connect();check();
  const query = async (sql: string) => {check();const result = await client.query(sql);check();return result;};
  let identity: Record<string, unknown> | undefined, witness: ReturnType<typeof validateFenceWitness> | undefined;
  let transactionOpen = false;
  try {
   stage = "begin";await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");transactionOpen = true;
   await query("SET LOCAL statement_timeout = '5s'; SET LOCAL idle_in_transaction_session_timeout = '10s'; SET LOCAL timezone = 'UTC'; SET LOCAL search_path = pg_catalog");
   stage = "identity";const rows = (await query(identitySql)).rows;identity = rows.length === 1 ? rows[0] : undefined;
   if (!identity || Object.keys(identity).sort().join(",") !==
    "database,database_time,idle_timeout,isolation,owner,pid,read_only,role,session_role,statement_timeout" ||
    identity.database !== "postgres" || identity.role !== "postgres" || identity.session_role !== "postgres" ||
    identity.owner !== "postgres" || identity.read_only !== "on" || identity.isolation !== "repeatable read" ||
    identity.statement_timeout !== "5s" || identity.idle_timeout !== "10s" ||
    !Number.isInteger(identity.pid) || Number(identity.pid) <= 0 || Number(identity.pid) > 2147483647 ||
    typeof identity.database_time !== "string" || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00$/.test(identity.database_time))
    throw Error("identity");
   stage = "fresh-witness";const result = await query(freshOwnerWitnessSql),raw = result.rows[0]?.witness;
   if (result.rows.length !== 1 || !raw || typeof raw !== "object" || Array.isArray(raw) ||
    Object.keys(raw).sort().join(",") !== "actor,backendStartMicros,db,isolation,owner,pid,readOnly,session") throw Error("witness-shape");
   witness = validateFenceWitness(context, raw);
   if (witness.pid !== identity.pid) throw Error("physical-backend-mismatch");
  } catch {
   const failedStage = stage;
   if (transactionOpen) {transactionOpen = false;try {await query("ROLLBACK");} catch {}}
   stage = failedStage;throw Error("witness-read");
  }
  stage = "rollback";if (!transactionOpen) throw Error("transaction-not-open");
  await query("ROLLBACK");transactionOpen = false;
  check();if (!identity || !witness) throw Error("witness-missing");
  stage = "encryption";
  // This receipt hash is PRE-admission control custody, NOT a durable barrier PASS.
  // Root creates a new barrier receipt only after independently checking this witness.
  const envelope = await encryptWitness({ok: true, protocol: PROTOCOL, projectRef: PROJECT, destinationVps: DESTINATION_VPS,
   sourceBarrierActionId: context.sourceBarrierActionId, contextSha256: FENCE_CONTEXT_SHA256,
   sourceControlReceiptSha256: context.sourceBarrierReceiptSha256, bindingKind: "PRE_ADMISSION_CONTROL_RECEIPT", barrierPass: false,
   started_epoch_ms: started, finished_epoch_ms: Date.now(), expires_epoch_ms: EXPIRES_EPOCH_MS,
   tls_negative_rejected: true, tls_verification: "native-ca-and-hostname", rollback_completed: true, identity, witness},
   capability, CAPABILITY_SHA256);
  check();return reply(envelope);
 };
 req.signal.addEventListener("abort", stop, {once: true});
 try {
  return await Promise.race([run(), new Promise<Response>(resolve => {
   timer = setTimeout(() => {stop();resolve(reply({ok: false, stage: "deadline", code: "FENCE_WITNESS_DEADLINE"}, 504));},
    Math.max(1, Math.min(30000, deadline - Date.now())));
  })]);
 } catch {return reply({ok: false, stage, code: "FENCE_WITNESS_FAILED"}, 502);}
 finally {
  clearTimeout(timer);req.signal.removeEventListener("abort", stop);stop();capability.fill(0);
  for (const client of clients) client.end().catch(() => {});
 }
});
