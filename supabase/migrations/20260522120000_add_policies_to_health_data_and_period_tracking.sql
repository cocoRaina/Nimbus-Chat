-- Single-user app: keep RLS posture consistent with memories/diaries/timeline.
-- Without these policies, RLS-enabled-but-no-policy = default deny, so
-- log_health and log_period tool inserts from the client get rejected.

drop policy if exists health_data_authenticated_all on public.health_data;
create policy health_data_authenticated_all on public.health_data
  for all to authenticated
  using (true)
  with check (true);

drop policy if exists period_tracking_authenticated_all on public.period_tracking;
create policy period_tracking_authenticated_all on public.period_tracking
  for all to authenticated
  using (true)
  with check (true);
