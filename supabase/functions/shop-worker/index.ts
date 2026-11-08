import { makeHandler } from './core.ts';

// The platform JWT check is disabled for cron's narrow secret; makeHandler always authorizes the caller.
// SUPABASE_* credentials are provided only by the server runtime. MOYSKLAD_TOKEN must be configured separately.
Deno.serve(makeHandler(name => Deno.env.get(name)));
