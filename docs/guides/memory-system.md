# 给 Claude 造一个长期记忆：原理 + 实战指南

> 面向所有人的通用教程，不依赖任何具体 App。只要你想给自己的 Claude 对话加上跨会话的长期记忆，都能用得上。
> 适用：AI 陪伴、个人助理、知识库问答、角色扮演——凡是「希望 AI 记住你」的场景。

---

## 一、为什么 Claude 默认"失忆"

Claude 是**无状态**的：每次对话从零开始，上一次聊了什么它完全不知道。哪怕你昨天告诉它"我不喜欢香菜"，今天重新开窗口，它依然会在菜单里推荐你带香菜的菜。

根本原因：大模型本质上是一个**函数**，输入是你发的那一整段上下文，输出是这次的回复。没有"持久化状态"的概念。想让它记住，只有一种办法——**把要记住的东西塞进下一次的输入里**。

这就是 AI 记忆系统要解决的问题：**把值得保留的信息存起来，并在合适的时机送回给 Claude。**

---

## 二、两类记忆：常驻注入 vs 按需搜索

所有 AI 记忆系统，本质上都是这两种模式的组合：

### 模式一：常驻注入（小而重要）

把少量核心信息**直接写进每次请求的 system prompt**：

```
你现在和以下用户对话：
- 她叫可可，24岁，住天津
- 不喜欢香菜
- 养了一只叫豆豆的橘猫
- 正在备考研究生
```

**优点**：Claude 每次都"知道"，不需要搜索，回复自然流畅。
**缺点**：放不了太多。Claude 的 context window 是有限的，放了记忆就少了对话空间；而且每次发送都要花 token 钱。

**适合存什么**：稳定的、长期有效的、高频用到的——身份信息、核心偏好、重要关系、不能忘的规则。

### 模式二：按需搜索（多而存档）

把大量信息存进数据库，每次根据当前对话语境**检索出最相关的几条**塞进请求：

```
[用户发消息] "我今天去了咖啡馆，点了手冲"
  → 搜索: "咖啡 饮品 偏好"
  → 找到: "她喜欢浅烘单品，不喜欢加糖"
  → 把这条附加在本轮消息里送给 Claude
```

**优点**：可以存几千条，不受 context 限制。
**缺点**：需要搜索才能用到，召回率不是 100%；实现复杂度高。

**适合存什么**：日记、具体事件、各种偏好细节、历史对话摘要、关系细节——平时用不到、但偶尔很关键的信息。

### 实践中怎么分层

```
┌─────────────────────────────────────────┐
│  常驻注入（system prompt）               │
│  少量（建议 < 20 条）、高度稳定的核心事实 │
│  每次请求都送给 Claude                   │
└──────────────┬──────────────────────────┘
               │ 余下的全部
               ▼
┌─────────────────────────────────────────┐
│  向量数据库（可搜索归档）                 │
│  大量、长期积累的记忆、日记、聊天摘要     │
│  按需搜索，相关时注入当轮上下文           │
└─────────────────────────────────────────┘
```

---

## 三、向量搜索：怎么找到"语义相关"的记忆

关键词搜索（LIKE '%咖啡%'）有个致命缺陷：用户说"我今天去星巴克了"，你搜"咖啡"就找不到它。

向量搜索解决这个问题：把文字转换成一串数字（**embedding 向量**），意思相近的词在数学上也"靠近"。

### 工作原理

```
"不喜欢香菜" → embedding 模型 → [0.12, -0.83, 0.47, ...]
"讨厌芫荽"   → embedding 模型 → [0.11, -0.81, 0.45, ...]  ← 很近！
"喜欢猫咪"   → embedding 模型 → [0.78,  0.33, -0.22, ...]  ← 很远
```

存记忆时，同时存一条 embedding；搜索时，把查询词也转成 embedding，找最近的几条。

### 选 embedding 模型

| 场景 | 推荐 |
|------|------|
| 主要是中文 | BAAI/bge-m3（多语言，中文效果好）|
| 主要是英文 | text-embedding-3-small |
| 低延迟/低成本 | BAAI/bge-small-zh |

中文 embedding 特别注意：**分词很重要**。"北京烤鸭"不能被拆成"北京"+"烤"+"鸭"，要整体理解。bge-m3 对此处理较好。

### 数据库选型

存向量需要支持向量索引的数据库：

| 选项 | 适合 |
|------|------|
| **Supabase (pgvector)** | 已经在用 Postgres、想一个服务搞定 |
| **Pinecone** | 纯向量存储、无需其他功能 |
| **Qdrant** | 自托管、大规模 |
| **本地 SQLite + sqlite-vec** | 个人项目、不想联网 |

最简单的方案：**Supabase**，免费套餐够个人用，自带认证和 REST API，pgvector 一行 SQL 开启。

---

## 四、混合检索：向量 + 关键词 RRF

纯向量搜索有时会遗漏包含特定词的结果（比如人名）；纯关键词搜索又找不到语义近义词。实践中最好的方案是**混合检索**：两种结果各自召回，用 RRF（Reciprocal Rank Fusion）融合排名。

```sql
-- 简化版伪 SQL
WITH vector_results AS (
  SELECT id, content, 1 - (embedding <=> query_vec) AS score
  FROM memories ORDER BY score DESC LIMIT 20
),
keyword_results AS (
  SELECT id, content, 1.0 AS score
  FROM memories WHERE content ILIKE '%关键词%' LIMIT 20
)
-- RRF 融合：score = 1/(rank_from_vector + k) + 1/(rank_from_keyword + k)
SELECT ..., sum(1.0 / (rank + 60)) AS rrf_score
FROM (SELECT * FROM vector_results UNION ALL SELECT * FROM keyword_results)
GROUP BY id ORDER BY rrf_score DESC LIMIT 5
```

这样人名（向量不稳定）靠关键词兜底，语义近义词靠向量补充，两者取长补短。

---

## 五、记忆的生命周期

### 1. 提取：从对话里抽出值得记的东西

手动记忆（用户主动说"记住我不喜欢香菜"）最简单，直接存。

自动提取更有意思：每隔一定轮次，把最近 N 条对话送给一个便宜的小模型，让它提取长期价值的事实：

**Prompt 示例：**
```
从以下对话里提取长期记忆条目（用户的稳定偏好/习惯/事实）。
只提取稳定的、长期有效的——不要一次性的情绪和闲聊。
返回 JSON：{"items": ["...", "..."]}

对话：
用户：最近睡眠很差，每天不到6小时
AI：听起来压力很大...
用户：对，论文快截止了，还有两章没写完
AI：...
```

模型可能返回：`{"items": ["正在写论文，压力较大，睡眠差"]}`

### 2. 去重：不要存重复的

积累几个月后，重复记忆是大问题——同一件事被提取了 30 次。

**去重策略：**

**方法一：Jaccard 相似度（快，适合中文）**
```python
def tokenize(text):
    # 中文：2-char bigram（"不喜欢香菜" → {"不喜", "喜欢", "欢香", "香菜"}）
    return set(text[i:i+2] for i in range(len(text)-1))

def jaccard(a, b):
    tokens_a, tokens_b = tokenize(a), tokenize(b)
    return len(tokens_a & tokens_b) / len(tokens_a | tokens_b)

# 新记忆和已有记忆比，相似度 > 0.85 就认为重复
if any(jaccard(new_item, existing) > 0.85 for existing in recent_memories):
    skip()  # 重复，不存
```

**方法二：向量余弦相似度（更准，但需要调 embedding API）**

存之前先搜一次，如果有非常近的向量（similarity > 0.95），说明这条记忆已经有了。

**方法三：AI 合并（最准，但最慢最贵）**

把新提取的候选和已有记忆一起送给模型，让它直接合并去重后输出。适合批量整理，不适合实时。

### 3. 确认：让用户参与

AI 自动提取的记忆不一定准确，建议加一个「待确认」状态：

```
提取 → 待确认队列 → 用户逐条确认/忽略/编辑 → 存入长期记忆
```

这样用户可以过滤掉误判，同时有一种"我的记忆是我自己决定的"的掌控感。

### 4. 锁定：常驻注入的门槛

不是所有确认的记忆都值得常驻注入。建议设一个"锁定"机制：

- **未锁定**（默认）：存在数据库，按需搜索，不占 context window
- **锁定**（手动选）：进入常驻注入，每次请求都送给 AI

判断要不要锁定的标准：**这条信息是不是每轮对话都用得到？** 名字、核心偏好 → 锁定；三个月前的某次具体对话 → 不锁定，搜索就够了。

---

## 六、注入策略：怎么把记忆送给 Claude

### 常驻记忆（锁定的）

直接放 system prompt，越稳定越好——**因为 system prompt 不变，prompt cache 才能命中**（见《Prompt Caching 入门》）。

```python
system = base_persona  # 人设本体，永远不变

# 锁定记忆按 id 排序（保证逐字节稳定！）
locked_memories = fetch_locked_memories()
locked_memories.sort(key=lambda m: m.id)  # ← 必须，用创建时间排序会随时间漂移

if locked_memories:
    system += "\n\n## 关于用户的核心记忆\n"
    system += "\n".join(f"- {m.content}" for m in locked_memories)
```

> ⚠️ 绝对不能按"最近访问时间"或"相关度"排序！一排序顺序就变，缓存就废了。按 id 排序，记忆增减时最多改变一次，不影响缓存的其他部分。

### 按需记忆（搜索到的）

放在**本轮用户消息的前面**，作为动态上下文：

```python
# 搜索与本轮消息相关的记忆
relevant = search_memory(user_message, top_k=5)

# 注入到本轮的 user 消息里，不放 system
user_content = ""
if relevant:
    user_content += f"[相关记忆]\n"
    user_content += "\n".join(f"- {m.content}" for m in relevant)
    user_content += "\n\n"
user_content += user_message
```

这样动态内容**不破坏 system 的 prompt cache**，同时 Claude 也能看到相关记忆。

---

## 七、访问追踪：哪些记忆真正有用

随着时间积累，数据库里会有很多"从来没被搜到过"的记忆——要么过时了，要么当时记错了，要么太细碎没价值。

建议给每条记忆加两个字段：
```sql
access_count      integer  default 0,    -- 被搜索命中的次数
last_accessed_at  timestamptz            -- 最后一次命中时间
```

每次搜索后更新（fire-and-forget，不阻塞主流程）：
```python
# 搜索返回结果后
memory_ids = [r.id for r in results]
asyncio.create_task(bump_access_count(memory_ids))  # 不等待
```

有了这两个字段，就能定期做"记忆健康检查"：

```sql
-- 找 90 天没被访问过的未锁定记忆
SELECT id, content, access_count, last_accessed_at
FROM memories
WHERE locked = false
  AND created_at < now() - interval '30 days'  -- 排除太新的
  AND coalesce(last_accessed_at, created_at) < now() - interval '90 days'
ORDER BY last_accessed_at ASC NULLS FIRST
LIMIT 20
```

拿到这个列表，让 AI 判断每条是否还有价值——过时的归档，还有效的保留。**不要全量自动删，AI 的判断也不是 100% 准确，保留人工确认的机会。**

---

## 八、常见坑

| 现象 | 原因 | 解决 |
|------|------|------|
| 记忆越来越多但从不被搜到 | 去重失效，大量重复记忆淹没有效结果 | 加强去重，定期运行 garden（扫近重复对） |
| 每次都搜到几十年前的不相关内容 | 搜索没有时间衰减权重 | 在 RRF 分数里叠加一个时间近度加权（越近越加分） |
| 自动提取把临时状态当成长期记忆 | 提取 prompt 没限定"稳定的、长期有效的" | 在 prompt 里明确排除情绪波动、一次性事件 |
| 锁定了太多记忆，context window 装不下 | 没有锁定门槛 | 设上限（建议 ≤ 20 条），或加锁前提醒用户当前 token 预算 |
| 常驻记忆每次都缓存 miss | 按时间/相关度排序导致顺序变动 | 改成按 id 排序，保证字节级稳定 |
| 提取的记忆包含用户不想被记住的内容 | 自动提取无监督 | 加「待确认」中间状态，让用户有机会过滤 |
| 同一件事被提取了 10 次 | 去重只检查了正在提取的批次，没查已有库 | 提取前同时查 `memory_entries`（待确认队列）和 `memories`（已确认库） |

---

## 九、进阶：让 AI 自己整理记忆

记忆系统成熟后，可以给 AI 配几个"管理工具"，让它主动维护自己的记忆库：

**工具一：`search_memory`** — 主动搜索，而不只是等记忆被注入

**工具二：`manage_memory`** — lock / unlock / update（修正过时内容）/ archive（归档没用的）

**工具三：`garden_memories`** — 扫描记忆库找近重复对，AI 决定合并/归档哪条

**工具四：`check_memory_health`** — 查出长期未被搜到的休眠记忆，AI 判断是否归档

配好这四个工具后，AI 可以在对话里**主动整理**——用户说"帮我清理一下记忆库"，AI 先用 `garden_memories` 找重复，再用 `manage_memory` 逐一处理，全程不需要你写额外代码。

工具描述里的触发条件很重要——告诉 AI **什么时候主动调**，不要只说"当用户让你搜记忆时调用"，而是"当用户提到之前的事情、或者你需要想起某件事时，主动调用"。

---

## 十、一句话总结

**常驻注入（少量锁定）+ 向量搜索（大量按需）+ 提取去重 + 访问追踪**，四件事加在一起，就是一个够用的 AI 长期记忆系统。其他都是优化细节。

---

## 附录：最小可用实现（Supabase + Python）

### 1. 建表

```sql
-- 开启向量扩展
create extension if not exists vector;

-- 记忆表
create table memories (
  id          bigserial primary key,
  content     text not null,
  category    text default '日常',
  tags        text[] default '{}',
  embedding   vector(1024),          -- bge-m3 输出维度
  locked      boolean default false, -- 是否常驻注入
  access_count     integer default 0,
  last_accessed_at timestamptz,
  created_at  timestamptz default now()
);

-- 向量索引（HNSW，速度比 IVFFlat 更快）
create index on memories using hnsw (embedding vector_cosine_ops);
```

### 2. 存记忆（含 embedding）

```python
import httpx

async def store_memory(content: str, category: str = "日常"):
    # 1. 生成 embedding
    resp = await httpx.post("https://api.siliconflow.cn/v1/embeddings",
        headers={"Authorization": f"Bearer {SILICONFLOW_KEY}"},
        json={"model": "BAAI/bge-m3", "input": content}
    )
    embedding = resp.json()["data"][0]["embedding"]

    # 2. 去重检查（Jaccard）
    recent = await supabase.table("memories").select("content").limit(200).execute()
    for row in recent.data:
        if jaccard_similarity(content, row["content"]) > 0.85:
            return None  # 重复，跳过

    # 3. 存入
    await supabase.table("memories").insert({
        "content": content,
        "category": category,
        "embedding": embedding
    }).execute()
```

### 3. 搜索记忆

```python
async def search_memory(query: str, top_k: int = 5) -> list:
    # 查询向量
    resp = await httpx.post("https://api.siliconflow.cn/v1/embeddings",
        headers={"Authorization": f"Bearer {SILICONFLOW_KEY}"},
        json={"model": "BAAI/bge-m3", "input": query}
    )
    query_embedding = resp.json()["data"][0]["embedding"]

    # 向量搜索（pgvector 余弦距离）
    results = await supabase.rpc("match_memories", {
        "query_embedding": query_embedding,
        "match_count": top_k
    }).execute()

    # 更新访问计数（fire-and-forget）
    ids = [r["id"] for r in results.data]
    asyncio.create_task(bump_access(ids))

    return results.data
```

```sql
-- match_memories RPC
create function match_memories(query_embedding vector(1024), match_count int)
returns table(id bigint, content text, similarity float)
language sql stable as $$
  select id, content, 1 - (embedding <=> query_embedding) as similarity
  from memories
  order by embedding <=> query_embedding
  limit match_count;
$$;
```

### 4. 组装给 Claude 的请求

```python
async def chat(user_message: str, history: list) -> str:
    # 常驻注入（锁定的记忆，按 id 排序！）
    locked = await supabase.table("memories").select("*")\
        .eq("locked", True).order("id").execute()
    core_section = ""
    if locked.data:
        core_section = "\n\n## 关于用户的核心记忆\n"
        core_section += "\n".join(f"- {m['content']}" for m in locked.data)

    system = BASE_PERSONA + core_section  # BASE_PERSONA 固定不变

    # 按需注入（搜到的相关记忆，加在本轮消息前）
    relevant = await search_memory(user_message)
    prefix = ""
    if relevant:
        prefix = "[相关记忆]\n" + "\n".join(f"- {m['content']}" for m in relevant) + "\n\n"

    messages = history + [{"role": "user", "content": prefix + user_message}]

    # 发给 Claude（记得带 metadata.user_id 让 prompt cache 命中）
    resp = await call_claude(system=system, messages=messages,
                              metadata={"user_id": USER_ID})
    return resp
```
