-- memory_entries had INSERT / SELECT / UPDATE policies but NO DELETE policy.
-- With RLS enabled, a missing policy = default deny, so the "忽略" action in
-- MemoryVaultPage (which hard-deletes the pending row) was silently rejected:
-- PostgREST DELETE under a blocking RLS policy returns success with zero rows
-- affected, so the entry just stayed put and the button looked dead. Confirm
-- worked because it's an UPDATE (status='confirmed'), which did have a policy.
--
-- Add the missing DELETE policy, scoped to the owner like the other three.
drop policy if exists "Users can delete own memory entries" on public.memory_entries;
create policy "Users can delete own memory entries" on public.memory_entries
  for delete
  using (auth.uid() = user_id);
