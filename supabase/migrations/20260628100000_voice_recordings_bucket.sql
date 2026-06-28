-- Storage bucket for voice message recordings.
-- Public bucket (URLs are playable without auth); upload restricted to
-- authenticated users via path-based RLS (first folder = user UUID).

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'voice-recordings',
  'voice-recordings',
  true,
  10485760,  -- 10 MB per file
  ARRAY['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav']
)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY IF NOT EXISTS voice_recordings_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'voice-recordings'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

CREATE POLICY IF NOT EXISTS voice_recordings_select ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'voice-recordings');
