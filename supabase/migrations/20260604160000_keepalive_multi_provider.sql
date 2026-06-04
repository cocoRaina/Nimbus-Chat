-- Extend cache_keepalive_state to support 中转站 (msuicode-style relays)
-- in addition to OpenRouter. Without this, only OR chats trigger keepalive;
-- a user who switches to a relay sees their cache go cold after 1h, paying
-- a ~$0.21 cold write on the first message back.
--
-- Adds provider/base_url/auth_style so the Edge Function can route each
-- user's ping to the right upstream with the right header style. Existing
-- rows default to OR settings, matching their historical behavior.

alter table public.cache_keepalive_state
  add column if not exists provider text not null default 'openrouter',
  add column if not exists base_url text not null default 'https://openrouter.ai/api/v1',
  add column if not exists auth_style text not null default 'bearer';

-- Defense in depth: a row that somehow lands an unknown provider value
-- would have the Edge Function fall through to an unhandled branch — better
-- to reject the upsert at the DB level so the bug surfaces immediately.
alter table public.cache_keepalive_state
  drop constraint if exists cache_keepalive_state_provider_check;
alter table public.cache_keepalive_state
  add constraint cache_keepalive_state_provider_check
  check (provider in ('openrouter', 'msuicode'));

-- Same for auth_style — only two valid header shapes for /messages.
alter table public.cache_keepalive_state
  drop constraint if exists cache_keepalive_state_auth_style_check;
alter table public.cache_keepalive_state
  add constraint cache_keepalive_state_auth_style_check
  check (auth_style in ('bearer', 'x-api-key'));

-- Defense in depth: HTTPS-only for base_url. If an attacker somehow modifies
-- a row (RLS bypassed, service-role key stolen, etc.) they could redirect
-- the keepalive ping — which carries the user's API key in the Authorization
-- header — to a plaintext endpoint they control. Forcing https stops that
-- exfiltration vector.
alter table public.cache_keepalive_state
  drop constraint if exists cache_keepalive_state_base_url_https_check;
alter table public.cache_keepalive_state
  add constraint cache_keepalive_state_base_url_https_check
  check (base_url ~ '^https://');

-- The column name openrouter_key is now historical — it stores the API key
-- for whichever provider this row uses. A comment makes that searchable.
comment on column public.cache_keepalive_state.openrouter_key is
  'API key for the provider named in `provider`. Originally OR-only — column name kept for compatibility, value is now generic relay key.';
