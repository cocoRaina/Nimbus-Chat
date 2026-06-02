-- Server-side cache keepalive state. The client-side 55min keepalive timer
-- dies when the app is killed / backgrounded (mobile JS limitation). This
-- table lets a pg_cron + Edge Function combo refresh the cache from the
-- server side, so the Anthropic prompt cache stays warm across APK
-- reinstalls, phone sleep, and hours-long gaps within the 8:00-23:00 window.
--
-- One row per user — overwritten on each successful OR Claude chat (the
-- latest body is what we want kept warm; older conversations naturally fade).

create table if not exists public.cache_keepalive_state (
  user_id uuid primary key references auth.users(id) on delete cascade,
  -- The full request body that produced the cache write/read. The Edge
  -- Function strips reasoning/tool_choice/usage and sets max_tokens:1
  -- before pinging — but the messages + tools + system + cache_control
  -- prefix must stay identical for the cache key to match.
  body jsonb not null,
  -- Per-user OpenRouter key. Stored here because Edge Functions can't
  -- read localStorage. RLS keeps it readable only by the owner; the
  -- Edge Function reads via service_role.
  openrouter_key text not null,
  -- Last successful chat. The Edge Function only pings users whose
  -- last_chat_at is within the active window (default 4h) — keeps
  -- the cache warm only when the user is likely to come back.
  last_chat_at timestamptz not null default now(),
  -- Last keepalive ping. Used to enforce a ~50min cooldown so we don't
  -- ping the same user twice when cron fires every 5min.
  last_ping_at timestamptz,
  -- Diagnostic counter.
  ping_count integer not null default 0,
  updated_at timestamptz not null default now()
);

alter table public.cache_keepalive_state enable row level security;

-- Per-user access. Owner can read/write own row; the Edge Function uses
-- service_role which bypasses RLS.
drop policy if exists cache_keepalive_state_owner on public.cache_keepalive_state;
create policy cache_keepalive_state_owner on public.cache_keepalive_state
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- updated_at auto-touch using the existing helper.
drop trigger if exists cache_keepalive_state_set_updated_at on public.cache_keepalive_state;
create trigger cache_keepalive_state_set_updated_at
before update on public.cache_keepalive_state
for each row execute function public.set_updated_at();
