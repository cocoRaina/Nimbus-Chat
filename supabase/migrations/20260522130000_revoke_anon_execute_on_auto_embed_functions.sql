-- The auto_embed_* functions are trigger functions — they're meant to be
-- called by AFTER INSERT triggers (running as the table owner), not as
-- public RPCs. Postgres grants EXECUTE to PUBLIC by default, which means
-- anon could POST /rest/v1/rpc/auto_embed_memory and potentially trigger
-- an external embedding API call. Revoke from public + anon + authenticated.
-- Triggers continue to work because trigger execution runs as the table
-- owner regardless of grants.

revoke execute on function public.auto_embed_memory() from public, anon, authenticated;
revoke execute on function public.auto_embed_diary() from public, anon, authenticated;
revoke execute on function public.auto_embed_handoff_letter() from public, anon, authenticated;
revoke execute on function public.auto_embed_timeline() from public, anon, authenticated;
revoke execute on function public.auto_embed_user_post() from public, anon, authenticated;
revoke execute on function public.auto_embed_user_reply() from public, anon, authenticated;
