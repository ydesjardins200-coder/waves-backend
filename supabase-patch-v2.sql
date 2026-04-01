-- ═══════════════════════════════════════════════════════════════════════════════
-- Waves Financial — Schema patch: add missing apply.html fields
-- Run in Supabase → SQL Editor
-- Safe to run multiple times (uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS)
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── loan_applications: missing employment + personal fields ──────────────────
alter table public.loan_applications
  add column if not exists apt               text,           -- unit/apartment number
  add column if not exists work_phone        text,           -- employer phone
  add column if not exists job_desc          text,           -- job title / description
  add column if not exists supervisor        text,           -- supervisor name
  add column if not exists hire_date         date,           -- employment start date
  add column if not exists ei_start_date     date,           -- EI benefit start date
  add column if not exists paid_by           text,           -- 'direct' | 'cheque'
  add column if not exists other_income_type text,           -- other income source type
  add column if not exists sex               text,           -- 'male' | 'female' | 'other'
  add column if not exists safety_contact_first_name text,   -- split safety contact first name
  add column if not exists safety_contact_last_name  text;   -- split safety contact last name

-- ─── clients: add apt field ───────────────────────────────────────────────────
alter table public.clients
  add column if not exists apt               text,
  add column if not exists work_phone        text,
  add column if not exists job_desc          text,
  add column if not exists hire_date         date,
  add column if not exists paid_by           text;

-- ─── Confirm ──────────────────────────────────────────────────────────────────
select 'loan_applications columns added' as status;

-- ─── clients: add notes column ────────────────────────────────────────────────
alter table public.clients
  add column if not exists notes text;
