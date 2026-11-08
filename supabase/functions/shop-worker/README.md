# shop-worker

Server-only Edge Function. It is not called by the partner's browser.

Deployment must use `verify_jwt = false`; the handler requires either an exact server
credential (`apikey` for a named secret or legacy service-role `Authorization: Bearer`)
or `x-shop-worker-key` verified by the service-only `shop_worker_authorize` RPC.
No caller can choose the remote endpoint, product payload or partner through this HTTP body.

Runtime configuration: `SUPABASE_URL`, platform-provided `SUPABASE_SECRET_KEYS`
(`shop_worker`, falling back to `default`) or `SUPABASE_SERVICE_ROLE_KEY`, and a dedicated
`MOYSKLAD_TOKEN` with read access plus customer-order creation. No token is included here.
Missing credentials, disabled database settings and incomplete verified partner policies
stop processing. Do not reuse the token held by the ChatGPT connector.

Body: `{ "action": "sync" }`, `{ "action": "dispatch" }` or `{ "action": "run" }`.
`sync` reads a complete catalog and individual prices. `dispatch` claims at most one
durable outbox item. `run` dispatches first, then synchronizes. A successful response is a completed worker pass;
individual orders can still be awaiting review or reconciliation. Monitor database state.

All customer orders use the database-frozen payload and `syncId`, with reserve zero.
Every attempt checks for an existing `syncId` first. A lost POST response is recorded as
ambiguous. Reconciliation never changes an existing document or replaces its positions.
An absent order during reconciliation is held for further lookup/manual review; it does not
authorize another POST. Transient lookup failures retain this read-only state.
The order is marked created only after its canonical counterparty, organization, warehouse,
currency, prices and quantities are verified. No payments, shipments or purchase orders
are created by this function.

Automatic pricing supports only an explicitly verified price type, no active discounts,
matching currency with two decimal places, direct exchange rate and multiplicity one.
VAT must be included in the displayed price, or disabled by the verified document policy;
missing inherited item VAT is not interpreted as zero. Missing/zero prices become unavailable
prices, never free items. Such products remain eligible for an explicitly accepted offer only
when their tax policy is known.
Unsupported pricing remains blocked; there is no fallback to retail prices or zero prices.
Negotiated accepted offers keep their frozen prices. Checkout orders recheck current
individual prices and physical stock before creation, without claiming an inventory reservation.
Both kinds recheck source activity, category, the immutable accepted unit and current tax.

Scheduler setup and deployment are separate operations. Creating these files does not
enable the integration. Source and network responses are never written to logs.
Each invocation has a 42-second MoySklad request budget. Paginated expanded products use
100-row pages with at most three concurrent pages; partner validation is also bounded.
One transport semaphore caps all MoySklad requests at four; backend requests have a
47-second invocation deadline so cron's 50-second timeout leaves time to return safely.
Stock/reserve reports are sequential source reads, not an atomic stock lock. The resulting
quantity remains indicative until the manager allocates in MoySklad. Failed or incomplete
sync never imports a partial snapshot, and timestamps/configuration versions protect replacements.
