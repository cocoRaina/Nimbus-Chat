-- Storage bucket for user-imported sticker packs (batch import from the
-- sticker tray). Separate from chat-images on purpose: tidy_images prunes
-- chat-images older than 30 days, and stickers must never be garbage-
-- collected. Public bucket (sticker URLs render without auth headers),
-- write/delete restricted to authenticated users.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'stickers',
  'stickers',
  true,
  2097152,  -- 2 MB per file; imports are 256px webp, ~10-30 KB each
  ARRAY['image/webp', 'image/jpeg', 'image/png']
)
ON CONFLICT (id) DO NOTHING;

DO $$ BEGIN
  CREATE POLICY stickers_bucket_insert ON storage.objects
    FOR INSERT TO authenticated
    WITH CHECK (bucket_id = 'stickers');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY stickers_bucket_select ON storage.objects
    FOR SELECT TO authenticated
    USING (bucket_id = 'stickers');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE POLICY stickers_bucket_delete ON storage.objects
    FOR DELETE TO authenticated
    USING (bucket_id = 'stickers');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
