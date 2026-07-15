-- 📞 callhome 二期：服务端来电邀请 + 升级拨号（沉默 ≥5h 自动打）。
--
-- call_state：每用户一行的通话状态。proactive_dispatch cron 靠它知道
--   功能开没开、勿扰状态、时区（12-23 点窗口按本地时间算）、今天升级
--   拨号打过没有。客户端在开关变化 / 进聊天页时 upsert（fire-and-forget）。
--
-- call_invites：服务端发起的来电邀请（升级拨号写 pending 行）。客户端
--   8s 轮询认领：pending→ringing（响铃）→ accepted/declined/missed；
--   过期没人认领的 pending/ringing 由客户端下次打开时认领成 missed 并
--   触发语音留言。AI 用 [call:] 标记的即时拨号仍走纯客户端路径，不经这表。

CREATE TABLE IF NOT EXISTS call_state (
  user_id            uuid        PRIMARY KEY REFERENCES auth.users ON DELETE CASCADE,
  enabled            boolean     NOT NULL DEFAULT false,
  dnd                boolean     NOT NULL DEFAULT false,
  tz_offset_minutes  integer     NOT NULL DEFAULT 480,
  last_escalation_at timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE call_state ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage their own call state"
  ON call_state
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE TABLE IF NOT EXISTS call_invites (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid        NOT NULL REFERENCES auth.users ON DELETE CASCADE,
  reason     text        NOT NULL,
  status     text        NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'ringing', 'accepted', 'declined', 'missed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

ALTER TABLE call_invites ENABLE ROW LEVEL SECURITY;

-- 客户端要 SELECT（轮询）+ UPDATE（认领状态），INSERT 只有服务端
-- （service role，绕 RLS）会做；FOR ALL 顺带允许用户手动清理自己的行。
CREATE POLICY "Users manage their own call invites"
  ON call_invites
  FOR ALL
  USING  (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- 轮询热路径：某用户还活着的邀请
CREATE INDEX IF NOT EXISTS call_invites_live
  ON call_invites (user_id, created_at DESC)
  WHERE (status IN ('pending', 'ringing'));
