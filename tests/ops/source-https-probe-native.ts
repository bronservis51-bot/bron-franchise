// @ts-nocheck -- Standalone Deno runtime fixture, exercised by its Python runner.
/// <reference lib="deno.ns" />
// Synthetic loopback wire test only; no real database, credentials, or Source access.
import pg from "npm:pg@8.23.1";
import assert from "node:assert/strict";

const directory = Deno.env.get("PROBE_TLS_DIR")!;
const ca = await Deno.readTextFile(`${directory}/ca.crt`);
const wrong = await Deno.readTextFile(`${directory}/wrong.crt`);
const make = (trust: string, servername: string) => new pg.Client({
  host: "127.0.0.1", port: Number(Deno.env.get("PROBE_TLS_PORT")),
  user: "synthetic", database: "synthetic", password: "synthetic",
  ssl: { ca: trust, servername, rejectUnauthorized: true },
  connectionTimeoutMillis: 5000, query_timeout: 5000,
});
const negative = [];
for (const [trust, name] of [[ca, "wrong.invalid"], [wrong, "bron-probe.invalid"]]) {
  const client = make(trust, name);
  client.on("error", () => {});
  let failure: unknown;
  try {
    await client.connect();
  } catch (error) {
    failure = error;
  } finally {
    client.connection?.stream?.destroy();
    await client.end().catch(() => {});
  }
  assert.ok(failure, "negative TLS unexpectedly connected");
  assert.match(String(failure), /cert|tls|NotValidForName|dnsname|hostname|UnknownIssuer/i);
  negative.push(String(failure));
}
const client = make(ca, "bron-probe.invalid");
client.on("error", () => {});
try {
  await client.connect();
  const result = await client.query("SELECT repeat('x',524288) AS payload");
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].payload, "x".repeat(524288));
  console.log(JSON.stringify({
    status: "PASS", deno: Deno.version.deno, driver: "pg8.23.1",
    canonicalSniWithIp: true, wrongHostnameRejected: true, wrongCaRejected: true,
    dummyBytes: 524288, negativeErrors: negative,
  }));
} finally {
  client.connection?.stream?.destroy();
  await client.end().catch(() => {});
}
