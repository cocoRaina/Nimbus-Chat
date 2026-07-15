-- 📞 schedule_call（预约拨号）：给 call_invites 加 fire_at。
-- 到点才响铃。默认 now() → 存量行和升级拨号行立即生效，向后兼容。
-- 客户端轮询改成"fire_at <= now 且未过期"才响。
ALTER TABLE call_invites ADD COLUMN IF NOT EXISTS fire_at timestamptz NOT NULL DEFAULT now();
