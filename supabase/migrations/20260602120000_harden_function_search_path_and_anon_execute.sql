-- Security hardening surfaced by Supabase advisors (security lints).
-- Idempotent: ALTER ... SET / REVOKE / GRANT can be re-applied safely.

-- 1) Pin search_path on functions flagged 0011_function_search_path_mutable.
--    "public, extensions" preserves current behavior exactly:
--    - search_memories / search_letters need pgvector's <=> operator (extensions)
--      plus the public.* tables they read.
--    - auto_embed_* already schema-qualify net.http_post; pg_catalog is implicit.
--    - set_updated_at only touches pg_catalog (now()).
--    Making the path fixed (instead of inheriting the caller's) closes the
--    search_path-injection vector on the SECURITY DEFINER trigger functions.
alter function public.auto_embed_memory() set search_path = public, extensions;
alter function public.auto_embed_diary() set search_path = public, extensions;
alter function public.auto_embed_handoff_letter() set search_path = public, extensions;
alter function public.auto_embed_timeline() set search_path = public, extensions;
alter function public.auto_embed_user_post() set search_path = public, extensions;
alter function public.auto_embed_user_reply() set search_path = public, extensions;
alter function public.set_updated_at() set search_path = public, extensions;
alter function public.search_letters(vector, integer, double precision)
  set search_path = public, extensions;
alter function public.search_memories(
  vector, integer, text, double precision, text, text[],
  timestamp with time zone, timestamp with time zone
) set search_path = public, extensions;

-- 2) Close the anon-executable SECURITY DEFINER hole flagged by
--    0028_anon_security_definer_function_executable. Revoking only FROM anon is
--    not enough: functions default to GRANT EXECUTE TO PUBLIC, and anon ∈ PUBLIC.
--    Revoke from PUBLIC + anon, then re-grant to authenticated (the app calls
--    these soft-delete / restore RPCs while signed in). service_role keeps access.
revoke execute on function public.soft_delete_user_post(uuid) from public, anon;
grant execute on function public.soft_delete_user_post(uuid) to authenticated;
revoke execute on function public.restore_user_post(uuid) from public, anon;
grant execute on function public.restore_user_post(uuid) to authenticated;
revoke execute on function public.soft_delete_user_reply(uuid) from public, anon;
grant execute on function public.soft_delete_user_reply(uuid) to authenticated;
