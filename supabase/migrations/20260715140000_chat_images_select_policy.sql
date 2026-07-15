-- chat-images 桶原本只有 INSERT/DELETE 策略，没有 SELECT → 客户端 storage
-- list() 被 RLS 挡成空，导致 list_photos / tidy_images 列不出任何图（明明有
-- 一百多张）。公开 URL 显示图不走 objects RLS，所以一直没暴露这个洞。补 SELECT。
CREATE POLICY "chat_images_authenticated_select"
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (bucket_id = 'chat-images');
