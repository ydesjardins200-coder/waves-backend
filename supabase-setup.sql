-- ═══════════════════════════════════════════════════════════════════════════════
-- Waves Financial — Full Schema v2
-- Replaces the old applications table with a proper client/loan/repayment model
-- Run in Supabase → SQL Editor
-- WARNING: Drops existing tables. Back up any data you need first.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── CLEANUP ──────────────────────────────────────────────────────────────────
drop view  if exists public.review_queue    cascade;
drop view  if exists public.active_loans    cascade;
drop table if exists public.repayment_schedule cascade;
drop table if exists public.contracts       cascade;
drop table if exists public.loan_applications cascade;
drop table if exists public.loans           cascade;
drop table if exists public.clients         cascade;
drop table if exists public.applications    cascade;


-- ═══════════════════════════════════════════════════════════════════════════════
-- clients — one row per unique borrower
-- ═══════════════════════════════════════════════════════════════════════════════
create table public.clients (
  id                      uuid primary key default gen_random_uuid(),
  created_at              timestamptz default now(),
  updated_at              timestamptz default now(),
  email                   text not null unique,
  first_name              text,
  last_name               text,
  cell_phone              text,
  home_phone              text,
  dob                     date,
  sex                     text,
  address                 text,
  city                    text,
  province                text,
  postal                  text,
  employment_status       text,
  employer                text,
  pay_frequency           text,
  declared_monthly_income numeric(10,2),
  latest_tier             text,
  latest_score            integer,
  latest_decision         text,
  total_applications      integer default 0,
  total_loans             integer default 0,
  total_borrowed          numeric(10,2) default 0,
  total_repaid            numeric(10,2) default 0,
  status                  text default 'active'   -- active | suspended | blacklisted
);
create index idx_clients_email    on public.clients (email);
create index idx_clients_province on public.clients (province);
create index idx_clients_status   on public.clients (status);


-- ═══════════════════════════════════════════════════════════════════════════════
-- loan_applications — one row per form submission
-- ═══════════════════════════════════════════════════════════════════════════════
create table public.loan_applications (
  id                      uuid primary key default gen_random_uuid(),
  created_at              timestamptz default now(),
  submitted_at            timestamptz,
  ref                     text not null unique,
  type                    text default 'new',
  client_id               uuid references public.clients(id) on delete set null,
  loan_id                 uuid,
  decision                text not null,
  tier                    text not null,
  risk_score              integer,
  approved_amount         integer,
  feasible_amount         integer,
  hard_decline            text,
  flags                   jsonb default '[]',
  signals                 jsonb default '{}',
  requested_amount        integer,
  fund_method             text,
  bankrupt_now            text,
  bankrupt_past           text,
  employment_status       text,
  employer                text,
  pay_frequency           text,
  next_pay_date           date,
  declared_monthly_income numeric(10,2),
  flinks_login_id         text,
  bank_name               text,
  is_sandbox              boolean default false,
  verified_income         numeric(10,2),
  fixed_obligations       numeric(10,2),
  avg_daily_balance       numeric(10,2),
  nsf_count               integer,
  opposition_count        integer,
  account_age_days        integer,
  income_regularity       text,
  esig_name               text,
  esig_timestamp          text,
  safety_contact_name     text,
  safety_contact_phone    text,
  safety_contact_rel      text,
  reviewed_at             timestamptz,
  reviewed_by             text,
  analyst_notes           text,
  final_decision          text
);
create index idx_apps_client_id on public.loan_applications (client_id);
create index idx_apps_decision  on public.loan_applications (decision);
create index idx_apps_tier      on public.loan_applications (tier);
create index idx_apps_submitted on public.loan_applications (submitted_at desc);
create index idx_apps_ref       on public.loan_applications (ref);


-- ═══════════════════════════════════════════════════════════════════════════════
-- loans — one row per funded loan
-- ═══════════════════════════════════════════════════════════════════════════════
create table public.loans (
  id                  uuid primary key default gen_random_uuid(),
  created_at          timestamptz default now(),
  client_id           uuid not null references public.clients(id) on delete restrict,
  application_id      uuid references public.loan_applications(id) on delete set null,
  ref                 text not null unique,
  type                text default 'new',
  principal           numeric(10,2) not null,
  apr                 numeric(5,4) default 0.23,
  term_days           integer default 112,
  payment_count       integer default 8,
  payment_frequency   text default 'biweekly',
  payment_amount      numeric(10,2),
  total_repayable     numeric(10,2),
  status              text default 'pending_disbursement',
  fund_method         text,
  disbursed_at        timestamptz,
  due_date            date,
  paid_off_at         timestamptz,
  total_paid          numeric(10,2) default 0,
  remaining_balance   numeric(10,2),
  missed_payments     integer default 0,
  notes               text
);
create index idx_loans_client_id on public.loans (client_id);
create index idx_loans_status    on public.loans (status);
create index idx_loans_ref       on public.loans (ref);
create index idx_loans_due       on public.loans (due_date);


-- ═══════════════════════════════════════════════════════════════════════════════
-- repayment_schedule — one row per scheduled payment (8 per loan)
-- ═══════════════════════════════════════════════════════════════════════════════
create table public.repayment_schedule (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz default now(),
  loan_id          uuid not null references public.loans(id) on delete cascade,
  client_id        uuid not null references public.clients(id) on delete cascade,
  payment_number   integer not null,
  due_date         date not null,
  scheduled_amount numeric(10,2) not null,
  status           text default 'scheduled',   -- scheduled | paid | missed | partial | waived
  paid_at          timestamptz,
  paid_amount      numeric(10,2),
  payment_method   text,
  attempt_count    integer default 0,
  last_attempt_at  timestamptz,
  failure_reason   text,
  notes            text,
  unique(loan_id, payment_number)
);
create index idx_sched_loan_id   on public.repayment_schedule (loan_id);
create index idx_sched_client_id on public.repayment_schedule (client_id);
create index idx_sched_due_date  on public.repayment_schedule (due_date);
create index idx_sched_status    on public.repayment_schedule (status);


-- ═══════════════════════════════════════════════════════════════════════════════
-- contracts — legal terms locked at signing
-- ═══════════════════════════════════════════════════════════════════════════════
create table public.contracts (
  id                 uuid primary key default gen_random_uuid(),
  created_at         timestamptz default now(),
  loan_id            uuid not null unique references public.loans(id) on delete cascade,
  client_id          uuid not null references public.clients(id) on delete cascade,
  application_id     uuid references public.loan_applications(id),
  principal          numeric(10,2) not null,
  apr                numeric(5,4) not null,
  term_days          integer not null,
  payment_count      integer not null,
  payment_amount     numeric(10,2) not null,
  total_repayable    numeric(10,2) not null,
  payment_frequency  text not null,
  first_payment_date date,
  final_payment_date date,
  fund_method        text,
  borrower_name      text not null,
  borrower_email     text not null,
  borrower_address   text,
  borrower_province  text,
  esig_name          text not null,
  esig_timestamp     text not null,
  pad_authorized     boolean default false,
  pad_institution    text,
  pdf_url            text,
  pdf_generated_at   timestamptz
);
create index idx_contracts_loan_id   on public.contracts (loan_id);
create index idx_contracts_client_id on public.contracts (client_id);


-- ═══════════════════════════════════════════════════════════════════════════════
-- ROW LEVEL SECURITY
-- ═══════════════════════════════════════════════════════════════════════════════
alter table public.clients             enable row level security;
alter table public.loan_applications   enable row level security;
alter table public.loans               enable row level security;
alter table public.repayment_schedule  enable row level security;
alter table public.contracts           enable row level security;

-- Admin (anon key) — full read + update
create policy "Admin read clients"        on public.clients            for select to anon using (true);
create policy "Admin update clients"      on public.clients            for update to anon using (true);
create policy "Admin read applications"   on public.loan_applications  for select to anon using (true);
create policy "Admin update applications" on public.loan_applications  for update to anon using (true);
create policy "Admin read loans"          on public.loans              for select to anon using (true);
create policy "Admin update loans"        on public.loans              for update to anon using (true);
create policy "Admin read schedule"       on public.repayment_schedule for select to anon using (true);
create policy "Admin update schedule"     on public.repayment_schedule for update to anon using (true);
create policy "Admin read contracts"      on public.contracts          for select to anon using (true);

-- Portal (authenticated) — own data only
create policy "Client read own"           on public.clients            for select to authenticated using (auth.jwt()->>'email' = email);
create policy "Client read own apps"      on public.loan_applications  for select to authenticated using (client_id in (select id from public.clients where email = auth.jwt()->>'email'));
create policy "Client read own loans"     on public.loans              for select to authenticated using (client_id in (select id from public.clients where email = auth.jwt()->>'email'));
create policy "Client read own schedule"  on public.repayment_schedule for select to authenticated using (client_id in (select id from public.clients where email = auth.jwt()->>'email'));
create policy "Client read own contracts" on public.contracts          for select to authenticated using (client_id in (select id from public.clients where email = auth.jwt()->>'email'));


-- ═══════════════════════════════════════════════════════════════════════════════
-- VIEWS
-- ═══════════════════════════════════════════════════════════════════════════════

-- Analyst review queue
create or replace view public.review_queue as
select
  a.id, a.ref, a.submitted_at, a.type,
  a.tier, a.risk_score, a.requested_amount, a.feasible_amount,
  a.flags, a.signals, a.decision,
  c.first_name, c.last_name, c.email, c.province,
  c.total_loans, c.total_borrowed,
  case a.tier when 'green' then 1 when 'blue' then 2 when 'yellow' then 3 when 'orange' then 4 else 9 end as priority
from public.loan_applications a
left join public.clients c on c.id = a.client_id
where a.decision = 'manual_review' and a.reviewed_at is null
order by priority asc, a.submitted_at asc;

-- Active loans with payment progress
create or replace view public.active_loans as
select
  l.id, l.ref, l.type, l.status,
  l.principal, l.payment_amount, l.total_repayable,
  l.total_paid, l.remaining_balance, l.missed_payments,
  l.disbursed_at, l.due_date, l.client_id,
  c.first_name, c.last_name, c.email, c.province,
  (select count(*) from public.repayment_schedule s where s.loan_id = l.id and s.status = 'paid')   as payments_made,
  (select count(*) from public.repayment_schedule s where s.loan_id = l.id and s.status = 'missed') as payments_missed,
  l.payment_count as payments_total
from public.loans l
join public.clients c on c.id = l.client_id
where l.status in ('active', 'pending_disbursement')
order by l.disbursed_at desc;
