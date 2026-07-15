# 🖼 小机的相册 + 照片整理

> 小机自己收藏聊天里出现过的图,自己翻看。只存**书签**(图的引用 + 收藏理由),图本身早在 `chat-images` bucket 里,**零额外存储**——所以不用担心 Supabase 空间。

| 模块 | 文件 |
|---|---|
| 表 `assistant_album` | `supabase/migrations/20260715130000_add_assistant_album.sql` |
| storage CRUD | `src/storage/album.ts` |
| AI 工具（收藏/翻看） | `src/tools/definitions.ts` → `save_to_album` / `browse_album`，执行在 `App.tsx` |
| 照片整理工具 | `tidy_images`（`src/storage/imageUpload.ts` → `tidyOldImages`） |
| 相册页 UI | `src/pages/MemoryVaultPage.tsx` → `AlbumTab`（记忆库抽屉侧边栏里） |

## 数据模型

`assistant_album`:图 `image_url`（chat-images 公网 URL）+ `image_path`(bucket path,清理保护用)+ `note`(小机的收藏理由)+ `tags` + `created_at`。RLS `auth.uid()=user_id`。`(user_id, image_url)` 唯一 → 防重复收藏。

**为什么只存书签**:小机收藏的图是**聊天里已经出现过的**(用户发的、或历史里的),那些图早就上传到 `chat-images` 了。收藏 = 记一行引用 + 一句话,几十字节。真正占空间的图收不收藏都已经存过。这直接化解了"相册会不会撑爆 Supabase"的担心。

## 收藏怎么定位图（关键设计）

模型是**多模态"看到"图**的,但**不知道图的 URL 字符串**(URL 以 `image_url` 结构传,不作为文本给模型)。所以 `save_to_album` 不让模型传 URL,而是:

1. 模型只写收藏理由 `note`(+ 可选 tags)
2. 前端执行时从 `messagesRef` **倒序找最近一条带 image 附件的消息**,取它的 url
3. 收藏那张

覆盖 "这张我想留着" 的主场景(通常指刚发的图)。**note 必填**:执行层强制,没写理由直接返回 error 逼模型补一句(这是它自己的相册,留言是收藏的意义)。**补/改备注**:已收藏的图再调一次 `save_to_album` 带上不同的 note → 更新备注(返回 `updated_note`);同 note/没 note → `already_saved` 不动。这就是小机给旧图补备注的路径(旧版没有编辑口子,小机会说"加不上备注")。

`list_photos` 让小机"看"整个图库:列 storage 所有照片,靠 image_captions 的**文字描述**呈现(不重喂像素、便宜),带在不在相册。⚠️ **依赖 chat-images 的 SELECT RLS 策略**(`20260715140000_chat_images_select_policy.sql`)——桶原本只有 INSERT/DELETE 策略,客户端 `list()` 被挡成空,`list_photos`/`tidy_images` 都列不出图(公开 URL 显示图不走 objects RLS 所以没暴露)。补了 SELECT 才好使。`browse_album` 回传 note/tags/time,**不回传 url**(太长、对模型无意义)——它回看的是自己写的理由。

## 相册页(记忆库抽屉里)

记忆库(Memory Vault)从**顶部横 tab** 改成了**抽屉式侧边栏**:☰ 滑出,五个栏目(记忆/日记/交接信/时间轴/相册),遮罩压暗,选一项/点暗处/安卓返回键收起。相册页:3 列网格(图上叠收藏理由)→ 点开看大图 + 收藏时间 + 理由 + 标签,可「移出相册」(只删书签,图留在聊天记录)。

## 🧹 tidy_images(整理老照片)

真正会增长的是 `chat-images` 桶(每发一张图存一张、只增不减)。`tidy_images` 让小机整理:

- 删**超过 N 天**(默认30、最小7)**且没进相册**的老图
- 相册收藏的(`image_path` 交叉比对)**永远保护**
- `dry_run:true` 先预览会删几张、释放多少 MB,再真删
- 老气泡里被删的图变占位,但**文字描述(imageCaptions)还在**,上下文不丢
- 系统工具描述里要求:先 dry_run、告诉用户、别默默删

**取舍**:释放空间 vs 老气泡图变占位。陪伴场景里 30 天前的图很少回翻,captions 保住了语义,可接受;且是用户主动要的能力。

## 未做 / 边界

- `save_to_album` 只能收藏"最近一张图"。对话里刚发好几张、想收藏特定某张 → 收的是最新那张(边缘情况)
- 换手机后:书签(理由/标签)跟着云端走还在;但如果那张图被 `tidy_images` 清理过、或超期,真图可能已不在 bucket → 相册里显示占位。收藏的"理由"永远在
- `image_path` 目前只有保护作用(tidy 时跳过);没做"被收藏的图强制不被任何清理触碰"的 DB 级约束,靠应用层交叉比对
