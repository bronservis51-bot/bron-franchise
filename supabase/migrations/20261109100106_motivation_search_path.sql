-- Pure calculation helpers resolve built-ins only; do not inherit a caller's schema path.
alter function app_private.motivation_default() set search_path = pg_catalog, pg_temp;
alter function app_private.motivation_pay(bigint,jsonb) set search_path = pg_catalog, pg_temp;
