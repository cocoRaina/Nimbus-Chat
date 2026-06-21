# 用 Supabase 给 AI 做一个记忆库：手把手实操（小白版）

> 面向**完全没碰过后端**的人。读完你能：建一个 Supabase 项目、建一张能"按意思搜索"的记忆表、写一段云端代码把它串起来。
> 这是**实操篇**。只想懂原理（为什么 AI 会失忆、常驻注入 vs 按需搜索）的，看姊妹篇《给 Claude 造一个长期记忆：原理 + 实战指南》。
> 全程不依赖任何具体 App，照着做就行。

---

## 0. 先说人话：我们要做的是什么

你想让 AI"记住"你说过的话。最朴素的办法是：把值得记的话**存进一个数据库**，下次聊天时**把相关的几条翻出来**塞回给 AI。

难点只有一个：**怎么"翻出相关的"？**

传统数据库只能按关键词找——你存了"她养了只橘猫叫豆豆",下次问"你还记得我的宠物吗",关键词"宠物"和"橘猫"对不上,就搜不到。

解决办法叫**向量搜索**:让电脑按**意思**找,而不是按字面。这正是这篇教程的核心。

我们会用到三样东西,下面逐个用大白话解释:

| 名字 | 一句话理解 |
|---|---|
| **Supabase** | 一个免费的云后端,帮你托管数据库 + 跑代码,不用自己买服务器 |
| **向量(embedding)** | 把一句话变成一串数字,意思相近的句子数字也相近——于是能"按意思搜" |
| **Edge Function** | 一段跑在云上的代码,你给它发请求它就执行——用来藏密钥、调外部服务、连数据库 |

---

## 1. 注册 Supabase + 建项目

1. 打开 [supabase.com](https://supabase.com),用 GitHub 登录(免费)。
2. 点 **New Project**,填:
   - **Name**:随便起,比如 `my-memory`
   - **Database Password**:数据库密码,**存好别丢**(以后连数据库要用)
   - **Region**:选离你近的,比如 `Southeast Asia (Singapore)`
3. 等 1~2 分钟,项目就建好了。

建好后你会看到左边一排菜单,这篇只用到三个:
- **Table Editor** — 看/建表(就是 Excel 那样的数据)
- **SQL Editor** — 运行 SQL 命令(建表、建函数都在这敲)
- **Edge Functions** — 部署云端代码

> 💡 **数据库是什么?** 就是一堆"表"。一张表像一个 Excel:每行是一条记录,每列是一个字段。我们要建的"记忆表",每行就是一条记忆。

---

## 2. 开启向量扩展 + 建记忆表

进 **SQL Editor**,点 **New query**,把下面整段粘进去,点 **Run**:

```sql
-- 第一步:开启 pgvector 扩展(让数据库支持"向量"这种数据类型)
create extension if not exists vector;

-- 第二步:建一张记忆表
create table memories (
  id          bigserial primary key,   -- 自动编号
  content     text not null,           -- 记忆内容(一句话)
  category    text default '日常',      -- 分类(可选)
  created_at  timestamptz default now(),-- 写入时间
  embedding   vector(1024)             -- ⭐ 这一句话的"向量",1024 个数字
);
```

关键就是最后那列 `embedding vector(1024)`:
- `vector` 是 pgvector 提供的类型,专门存向量。
- `1024` 是**维度**——也就是用多少个数字来表示一句话。这个数字必须和你用的 embedding 模型对上(下面会用 `bge-m3`,它正好输出 1024 维)。换模型就要换这个数,别记错。

跑完去 **Table Editor**,能看到一张空的 `memories` 表了。

---

## 3. 向量到底怎么"按意思搜"

先建立直觉,再写代码。

**embedding(向量)** = 把一句话喂给一个 AI 模型,它吐出一串数字(这里是 1024 个)。神奇之处:**意思相近的句子,数字也相近**。

```
"她养了只橘猫"        → [0.12, -0.03, 0.88, ...]  ┐ 这两串数字
"你还记得我的宠物吗"   → [0.10, -0.01, 0.85, ...]  ┘ 非常接近!
"明天天气怎么样"       → [-0.7, 0.4, 0.02, ...]    ← 差很远
```

"接近"是可以用数学算出来的(余弦距离)。所以搜索流程变成:

```
把"查询句"也变成向量 → 在表里找向量最接近的几条 → 返回
```

pgvector 用一个特殊符号 `<=>` 算两个向量的距离(越小越近)。距离转成"相似度"就是 `1 - 距离`(越大越像)。

**给表建个索引**(数据多了搜得快),回 SQL Editor 跑:

```sql
create index on memories
  using hnsw (embedding vector_cosine_ops);
```

> `hnsw` 是一种向量专用索引,几万条以内搜起来都是毫秒级。

---

## 4. 写一个"搜索函数"(数据库里的 function)

这里出现第一个 **function**。先解释:

> **数据库 function 是什么?** 就是一段**存在数据库里、可以反复调用的 SQL**。你给它传参数,它返回结果。好处是把复杂查询封装起来,外面一句话就能调。

我们写一个 `match_memories`:传入一个查询向量,返回最像的 N 条。回 SQL Editor 跑:

```sql
create or replace function match_memories(
  query_embedding vector(1024),   -- 传进来的查询向量
  match_count int default 5       -- 返回几条
)
returns table (id bigint, content text, similarity float)
language sql stable as $$
  select
    m.id,
    m.content,
    1 - (m.embedding <=> query_embedding) as similarity  -- 距离转相似度
  from memories m
  where m.embedding is not null
  order by m.embedding <=> query_embedding   -- 按"最近"排序
  limit match_count;
$$;
```

现在数据库已经会搜了。但还差一步:**"查询句"怎么变成向量?** 这一步要调一个外部的 embedding 模型,而且会用到 API key——这就轮到 Edge Function 上场。

---

## 5. Edge Function 是什么、为什么需要它

> **Edge Function = 一段跑在 Supabase 云上的代码(用 TypeScript 写)。** 你给它发一个网络请求,它就执行一次,然后返回结果。它跑在"服务器端",所以能做前端不方便或不安全做的事。

为什么搜记忆**必须**用它,不能让 App 直接干?三个原因:

1. **藏密钥**:把文字变向量要调 embedding 模型(要 API key)。key 绝不能写进手机 App / 网页——会被人扒走盗刷。放在 Edge Function 的环境变量里才安全。
2. **串流程**:一次搜索要"调 embedding → 再查数据库"两步,放云端一气呵成。
3. **统一出口**:以后换模型、加逻辑,只改这一处,App 不用动。

### 先存一个 embedding 模型的 key

这篇用 [SiliconFlow(硅基流动)](https://siliconflow.cn) 的 `BAAI/bge-m3`——中文友好、便宜、1024 维正好对上我们的表。注册拿一个 API key,然后在 Supabase 项目里存为环境变量(**Project Settings → Edge Functions → Secrets**,或用 CLI),名字叫 `SILICONFLOW_API_KEY`。

### 写函数

Edge Function 用 [Supabase CLI](https://supabase.com/docs/guides/cli) 部署。建一个文件 `supabase/functions/search_memory/index.ts`:

```ts
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

Deno.serve(async (req) => {
  // 接收 App 发来的查询文字,例如 { "query": "我的宠物" }
  const { query } = await req.json()

  // ── 第一步:文字 → 向量(调 embedding 模型)──
  const embRes = await fetch('https://api.siliconflow.cn/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('SILICONFLOW_API_KEY')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: 'BAAI/bge-m3', input: query }),
  })
  const queryEmbedding = (await embRes.json()).data[0].embedding

  // ── 第二步:向量 → 数据库搜索(调第 4 步那个 SQL 函数)──
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,  // 服务端专用密钥
  )
  const { data, error } = await supabase.rpc('match_memories', {
    query_embedding: queryEmbedding,
    match_count: 5,
  })

  if (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500 })
  }

  // 把搜到的记忆返回给 App
  return new Response(JSON.stringify({ memories: data }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
```

部署:

```bash
supabase functions deploy search_memory
```

> `supabase.rpc('match_memories', {...})` 就是"调用数据库里那个 function"。云代码 + 数据库 function,各管一段,串起来。

---

## 6. 跑通一次完整流程

### 写入一条记忆

写入时也要先把内容变成向量再存。最简单的做法:在 SQL Editor 手动插一条试试(向量这里先用占位,真实场景由代码生成):

实际项目里,**写入**和**搜索**一样要先过一次 embedding。可以再写一个 `add_memory` 的 Edge Function,逻辑是"文字 → 向量 → `insert into memories`"。偷懒的话,也可以用**数据库触发器**:每当插入一行就自动调 embedding 把 `embedding` 列填上(进阶,见下)。

### 搜索

App(或你用 `curl`)给 Edge Function 发:

```bash
curl -X POST 'https://<你的项目>.supabase.co/functions/v1/search_memory' \
  -H 'Authorization: Bearer <你的 anon key>' \
  -H 'Content-Type: application/json' \
  -d '{"query": "我的宠物"}'
```

返回:

```json
{ "memories": [
  { "id": 1, "content": "她养了只橘猫叫豆豆", "similarity": 0.82 },
  ...
] }
```

把这几条塞进你给 AI 的下一轮 prompt 里,AI 就"记起来"了。**整个记忆库的闭环就成了。**

---

## 7. 进阶(知道有这些就行,需要再展开)

- **自动 embedding**:别让 App 每次手动算向量。用数据库**触发器(trigger)**——一插入新记忆就自动调 Edge Function 把 `embedding` 填好。写入方零心智负担。
- **混合检索(更准)**:纯向量搜偶尔会漏掉"必须精确命中"的词(人名、专有名词)。实战常把**向量搜**和**关键词搜(ILIKE / 全文索引)**两路结果用 RRF 算法融合,再加一点"时间近度"加权,让新记忆更容易被翻出来。
- **常驻 vs 按需**:身份、铁打的偏好这种**少而重要**的,别丢进搜索库——直接写死在 system prompt 里常驻。搜索库留给**多而存档**的(日记、具体事件、历史摘要)。两者分层,详见原理篇。
- **让 AI 自己管记忆**:把"写记忆/搜记忆/归档"做成 AI 的**工具(tool/function calling)**,AI 聊着聊着自己决定要不要记、要不要查。

---

## 8. 这套东西能拿来做什么

向量搜索 + Edge Function 这套组合,远不止 AI 记忆:

- **AI 陪伴 / 角色扮演**:记住用户的身份、喜好、过往对话。
- **知识库问答(RAG)**:把文档切片存进向量库,提问时检索相关段落喂给 AI——这就是市面上"喂资料给 AI"的标准做法。
- **语义搜索**:商品、文章、笔记的"按意思搜",而不是死板的关键词。
- **去重 / 找相似**:找出内容相近的两条记录(向量距离很小)。

核心心法就一句:**把任何文字变成向量存起来,就能按"意思"检索。**

---

## 9. 避坑清单

| 坑 | 说明 |
|---|---|
| **维度对不上** | 表里写 `vector(1024)`,但模型输出别的维度 → 插入报错。建表前先确认模型维度。`bge-m3` 是 1024。 |
| **API key 写进前端** | 绝对不要。embedding key 只能放 Edge Function 的 Secrets,否则被扒走盗刷。 |
| **忘了建索引** | 几百条没感觉,几万条不建 HNSW 索引会越搜越慢。 |
| **搜不到旧数据** | 多半是那几行 `embedding` 列是空的(写入时没生成向量)。补嵌入即可。 |
| **RLS 拦截** | Supabase 表默认开 Row Level Security,没配策略时前端**静默返回 0 行**。自己单租户用可先 `using (true)` 全开,多用户务必按 `user_id` 配策略。 |
| **成本** | embedding 很便宜(百万 token 几毛钱),但别在循环里无脑重复算同一句话。能缓存就缓存。 |

---

## 10. Supabase 到底能做多少 · 什么时候够用 · 什么时候上 VPS

很多人(包括做之前的我)以为 Supabase 只是个"云数据库"。其实它能扛的事**比想象多得多**——一个相当完整的 App 后端,常常**全程不需要任何服务器**。

### Supabase 一个人能干的事

| 你想做 | Supabase 怎么扛 |
|---|---|
| 存数据 | Postgres 数据库 |
| 用户登录注册 | Auth(邮箱/手机验证码/Google 等,自带) |
| 存图片/音频/文件 | Storage |
| 自动生成 API | 建完表**自动**有一套增删改查 API,前端直接调,不用自己写后端 |
| 藏密钥 / 调外部服务 / 自定义逻辑 | Edge Functions |
| 数据变了实时推给前端 | Realtime(聊天、在线状态都靠它) |
| 定时任务 | `pg_cron`——数据库里定时跑(每 5 分钟、每天凌晨…) |
| 向量搜索 / AI 记忆 | `pgvector`(就是这篇全程在用的) |

把这几块拼起来,**一个聊天 App、一个带登录的工具、一个 AI 助理,后端可以全用 Supabase 搞定,一台服务器都不用租**。这也是为什么"感觉它做了不少"——它确实做了不少。

> 💡 真实例子:本系列对应的 Nimbus Chat,**记忆、认证、聊天存储、缓存保活、主动消息派发、定时任务**全在 Supabase 上,服务端代码几乎都是 Edge Function + 数据库函数。

### 它的天花板在哪(这些得上 VPS)

Edge Function 的本质是"**来一个请求,跑一下,结束**",所以凡是需要"**一直跑着**"或"**重活**"的,它就够不着:

- 🚫 **常驻进程**:挂机机器人、长连接 WebSocket 服务器、一直在跑的监听/爬虫
- 🚫 **重计算**:本地跑大模型、视频转码、训练
- 🚫 **装任意软件 / 跑任意语言**:Python 脚本、Redis、ffmpeg、连智能家居
- 🚫 **完全掌控**:要 root、要自定义系统环境

这些是 **VPS(一台你说了算的 Linux 机器)** 的地盘。

### 一句话决策

```
只用 Supabase 就够 —— 如果你的后端 = 存数据 + 登录 + 文件 + 轻量云逻辑 + 定时任务
                       (90% 的 App / 工具 / AI 助理都在这个范围内)

加一台 VPS         —— 当你需要「一直跑着的程序」或「跑任意东西 / 重计算」
                       (挂机服务、本地模型、要装软件、要完全掌控)
```

### 最佳实践:混用,各取所长

不是二选一。聪明的做法是 **Supabase 当主力,VPS 补那一小块它够不着的**:

```
        ┌──────────── Supabase(省心、零运维)────────────┐
App ──→ │ 数据库 · 登录 · 文件 · 记忆搜索 · 定时任务 · 云逻辑 │
        └───────────────────────┬───────────────────────┘
                                 │ 只有"要一直跑/要跑任意东西"的那点活
                                 ▼
                         VPS(挂机服务 · 本地模型 · 沙盒 · 智能家居)
```

> Nimbus 就是这么干的:绝大部分在 Supabase,只有"跑用户任意代码的沙盒"放在 Mac mini / VPS 上——因为那件事 Supabase 天生做不了。

**小白结论**:**先只用 Supabase 起步**,能覆盖你绝大多数需求、还免运维。等真撞到"我需要一个一直跑着的程序"或"我要跑模型/装软件"那天,再加一台 VPS 专门接那一块——不用一开始就上服务器。

---

## 11. 进阶福利:用 MCP 让 AI 直接帮你操作 Supabase

前面所有 SQL、建表、部署 Edge Function,你都得自己去网页点。其实有个更爽的方式:**让 AI(Claude、Cursor 等)直接连上你的 Supabase,你说人话它就帮你建表、跑 SQL、部署函数、查日志。**

> **MCP 是什么?** Model Context Protocol,一个"让 AI 接外部工具"的标准。Supabase 官方做了一个 MCP 服务器,把它接到你的 AI 客户端,AI 就多了一双手能直接操作你的项目。
> (这篇教程对应的项目,作者就是让 AI 通过 MCP 部署的 Edge Function——不用自己敲命令。)

### ⚠️ 先分清两件事(最容易搞混,务必看)

很多人会问:"我自己做的网页/App,是不是要靠 MCP 连 Supabase?" —— **不是!** 这是两件完全不同的事,千万别混:

| | 谁在用 | 什么时候 | 用什么连 |
|---|---|---|---|
| **MCP** | **你(开发者)+ AI** | **做东西的时候** | MCP 服务器 |
| **你的 App** | **你做出来的网页/App** | **用户真正使用的时候** | Supabase 客户端库(SDK)+ anon key |

打个比方:
- **MCP** = 装修时你请的**师傅**。帮你砌墙、改水电(=建表、部署函数)。房子装好了,师傅就走了——**用户住进来不需要师傅。**
- **App 连 Supabase(SDK)** = 房子里的**水管电线**。住进来之后,日常用水用电(=App 读写数据)走的是这套管线,**跟当初那个师傅没关系。**

所以:
- MCP **跟你用什么前端框架毫无关系**(React、Vue、纯 HTML、Flutter…都行),它只是"开发时让 AI 帮你管后端"的工具。**谁都能用。**
- 你的 App 真正连 Supabase,**不靠 MCP**,而是装一个客户端库,用项目网址 + anon key,几行代码:

```js
import { createClient } from '@supabase/supabase-js'
const supabase = createClient('https://你的项目.supabase.co', '你的 anon key')

// 读数据
const { data } = await supabase.from('memories').select('*')
```

(连 `@supabase/supabase-js` 都不想装的话,纯 HTML 直接发 HTTP 请求也行——Supabase 建完表会**自动**给你一套 API。)

**一句话**:MCP 是给"你 + AI"开发用的;App 连数据库是另一套(SDK + anon key)。两者不冲突,经常同时用——你用 MCP 让 AI 帮你把后端搭好,然后你的 App 用 SDK 去读写它。下面讲怎么连 MCP。

### 它接上后能干什么

建表 / 改表、跑任意 SQL、部署 Edge Function、看数据、读日志排错、查官方文档…基本上你在网页能干的,变成"跟 AI 说一句"。

### 连接三步(以 Claude / Cursor 为例)

**① 拿一个 Personal Access Token(个人访问令牌)**

Supabase 网页右上角头像 → **Account → Access Tokens**(或 Settings 里找 Access Tokens)→ **Generate new token** → 复制存好(**只显示一次**)。
> ⚠️ 这个 token 等于你整个 Supabase 账号的钥匙,别发给别人、别提交进代码。

**② 找到项目的 Reference ID(项目编号)**

打开项目,看浏览器地址 `https://supabase.com/dashboard/project/`**`xxxxxxxx`** 里那串,就是 project-ref;或 **Project Settings → General → Reference ID**。

**③ 把配置填进 AI 客户端的 MCP 配置文件**

配置长这样(三个客户端格式一样,只是文件位置不同):

```json
{
  "mcpServers": {
    "supabase": {
      "command": "npx",
      "args": [
        "-y",
        "@supabase/mcp-server-supabase@latest",
        "--read-only",
        "--project-ref=你的项目编号"
      ],
      "env": {
        "SUPABASE_ACCESS_TOKEN": "你刚复制的token"
      }
    }
  }
}
```

放哪个文件:
| 客户端 | 配置文件 |
|---|---|
| **Claude Desktop** | 设置 → Developer → Edit Config(`claude_desktop_config.json`) |
| **Cursor** | 项目根目录建 `.cursor/mcp.json`,或设置里的 MCP 面板 |
| **Claude Code(命令行)** | 跑 `claude mcp add`,或编辑 `.mcp.json` |

填好**重启客户端**,就连上了。之后直接跟 AI 说"帮我在 memories 表加一列 tags"、"把这个 Edge Function 部署上去",它就动手。

### 两个安全要点(重要)

- **先用 `--read-only`**:加上这个参数,AI **只能读不能改**(查数据、看结构、排错都行,但删不了你的表)。等你信得过了再去掉。新手强烈建议先只读。
- **用 `--project-ref` 锁死单个项目**:AI 的手只能伸到这一个项目,碰不到你账号里别的项目,炸了也只炸这一个。
- **别让它读不可信内容**:MCP 让 AI 能执行操作,如果你把它指向陌生人的数据/留言,理论上有"提示词注入"风险(内容里藏指令骗 AI 乱操作)。自己的项目、自己掌控的数据,放心用。

> 小白建议:**先 `--read-only` + 锁单项目**起步。让 AI 帮你看表、写 SQL、解释报错,你复制去网页执行;熟了再开放写权限让它直接动手。

---

> 写完这篇你已经掌握了一个完整 AI 记忆库的全部骨架:**表(存) → 向量(按意思找) → 数据库函数(封装搜索) → Edge Function(串起来 + 藏密钥)**,也知道了 Supabase 的能力边界、什么时候该上 VPS,还学会了用 MCP 让 AI 直接帮你干活。剩下的都是在这副骨架上加肉。祝玩得开心 🎈
