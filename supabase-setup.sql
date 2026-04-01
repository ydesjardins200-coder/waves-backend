-- ═══════════════════════════════════════════════════════════════════════════════
-- Waves Financial — Supabase Database Setup
-- Run this once in your Supabase project → SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════


-- ─── APPLICATIONS TABLE ───────────────────────────────────────────────────────

create table if not exists public.applications (
  -- Internal ID
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz default now(),

  -- Reference & metadata
  ref             text not null unique,           -- WF-XXXXXX
  submitted_at    timestamptz,
  type            text default 'new',             -- 'new' | 'renewal'

  -- Decision
  decision        text not null,                  -- 'auto_approved' | 'manual_review' | 'auto_declined'
  tier            text not null,                  -- 'gold' | 'green' | 'blue' | 'yellow' | 'orange' | 'red'
  risk_score      integer,                        -- 0–100
  approved_amount integer,
  feasible_amount integer,
  hard_decline    text,
  flags           jsonb default '[]',
  signals         jsonb default '{}',

  -- Applicant
  first_name      text,
  last_name       text,
  email           text,
  cell_phone      text,
  home_phone      text,
  dob             date,
  province        text,
  address         text,
  city            text,
  postal          text,
  -- SIN intentionally never stored

  -- Employment
  employment_status       text,
  employer                text,
  pay_frequency           text,
  next_pay_date           date,
  declared_monthly_income numeric(10,2),

  -- Loan
  requested_amount  integer,
  fund_method       text,

  -- Banking / Flinks
  flinks_login_id   text,
  bank_name         text,
  is_sandbox        boolean default false,

  -- Verified bank data snapshot (from Flinks)
  verified_income     numeric(10,2),
  fixed_obligations   numeric(10,2),
  avg_daily_balance   numeric(10,2),
  nsf_count           integer,
  opposition_count    integer,
  account_age_days    integer,
  income_regularity   text,

  -- E-signature
  esig_name       text,
  esig_timestamp  text,

  -- Analyst workflow
  reviewed_at     timestamptz,
  reviewed_by     text,
  analyst_notes   text,
  final_decision  text            -- analyst's final call if overriding auto decision
);

-- Indexes for common query patterns
create index if not exists idx_applications_email      on public.applications (email);
create index if not exists idx_applications_decision   on public.applications (decision);
create index if not exists idx_applications_tier       on public.applications (tier);
create index if not exists idx_applications_submitted  on public.applications (submitted_at desc);
create index if not exists idx_applications_ref        on public.applications (ref);


-- ─── ROW LEVEL SECURITY ───────────────────────────────────────────────────────
-- Applications are sensitive financial data.
-- Only service_role (your backend) can read/write.
-- Authenticated portal users can only see their own applications.

alter table public.applications enable row level security;

-- Backend (service_role) has full access — no policy needed, service_role bypasses RLS

-- Portal users can only read their own applications (matched by email)
create policy "Users can view own applications"
  on public.applications
  for select
  using (auth.jwt() ->> 'email' = email);

-- No policy for insert/update from portal — only the backend service_role can write


-- ─── ANALYST VIEW ─────────────────────────────────────────────────────────────
-- A convenient view for the review queue, ordered by priority

create or replace view public.review_queue as
select
  id,
  ref,
  submitted_at,
  first_name,
  last_name,
  email,
  province,
  tier,
  risk_score,
  requested_amount,
  feasible_amount,
  flags,
  signals,
  verified_income,
  fixed_obligations,
  avg_daily_balance,
  nsf_count,
  opposition_count,
  case tier
    when 'green'  then 1
    when 'blue'   then 2
    when 'yellow' then 3
    when 'orange' then 4
    else 9
  end as priority
from public.applications
where decision = 'manual_review'
  and reviewed_at is null
order by priority asc, submitted_at asc;
