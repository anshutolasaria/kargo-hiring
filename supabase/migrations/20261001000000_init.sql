-- Kargo hiring dashboard schema
create extension if not exists pgcrypto;

create table if not exists rubric_criteria (
  id          serial primary key,
  role        text not null check (role in ('PM','SPM')),
  name        text not null,
  description text not null,
  weight      int  not null check (weight > 0 and weight <= 100),
  unique (role, name)
);

create table if not exists candidates (
  id           uuid primary key default gen_random_uuid(),
  applied_role text not null check (applied_role in ('PM','SPM')),
  cv_content   text not null,                 -- REDACTED text only
  file_name    text not null,
  file_hash    text not null unique,          -- dedupe key (emails are shared test addresses)
  pm_score     numeric(5,1),
  spm_score    numeric(5,1),
  score_json   jsonb,
  brief        text,
  draft_subject text,
  draft_body   text,                          -- contains literal {{NAME}}
  draft_type   text check (draft_type in ('invite','rejection')),
  status       text not null default 'pending'
               check (status in ('pending','needs_review','scored','drafted','sent')),
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);

create table if not exists candidate_pii (
  candidate_id uuid primary key references candidates(id) on delete cascade,
  name  text not null,
  email text,          -- NOT unique: many candidates share the same test email
  phone text
);

-- Row Level Security: no policies = no access for anon/authenticated roles.
-- Only the service role (server routes) bypasses RLS.
alter table candidate_pii   enable row level security;
alter table candidates      enable row level security;
alter table rubric_criteria enable row level security;

revoke all on candidate_pii from anon, authenticated;
revoke all on candidates    from anon, authenticated;
revoke all on rubric_criteria from anon, authenticated;

-- Newer Supabase projects don't auto-grant table access to service_role; grant it explicitly.
grant usage on schema public to service_role;
grant all on rubric_criteria, candidates, candidate_pii to service_role;
grant usage, select on all sequences in schema public to service_role;

create index if not exists candidates_role_idx on candidates (applied_role);
