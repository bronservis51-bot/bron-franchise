-- Retail returns are reported alongside sales, outside the payroll and royalty bases.
alter table public.work_shift add column return_minor bigint not null default 0
  check (return_minor between 0 and 100000000000);
