# 中转站体检 + Token 对账：怎么知道它有没有骗你

> 两部分：**上半人话版**给你自己/朋友看，搞懂「中转可能怎么骗、该查什么」；**下半给 AI 看的可执行食谱**，你的 AI 助手（小机）读了就能直接用几个请求帮你体检任意中转、读懂 usage 字段对账。
> 通用、不依赖任何具体 App——只要你是「直连 Claude API 或通过中转调 Claude」都能用。

---

# 上半 · 人话版（给人看）

## 中转可能在哪骗你

中转站（relay）是你和官方 API 之间的中间商。便宜的中转常靠这几招省成本/多赚：

1. **假缓存** —— 嘴上说支持 prompt cache，其实没透传。你以为长对话在省钱，实际一直全价。
2. **偷换 / 降智** —— 你点 Opus，它偷偷给便宜模型或降智版。
3. **虚报用量** —— 后台日志里 token / write 数字注水，多收你钱。
4. **逆向反代** —— 反代别人的订阅（Claude Code / Kiro 等）。可能能用、便宜，但内置提示词（干扰角色扮演）、不稳、官方一封就停。

**铁律：别信它嘴上说的，看实测数字。** 数字不会骗人。

## 该查的 6 件事（以及结果代表什么）

| 查什么 | 怎么判断 | 说明 |
|---|---|---|
| **缓存真假** | 发两次相同长前缀，看第二次有没有「缓存读」 | 真命中=省钱有效；写了读不到=多上游打散/模拟；全 0=缓存失效 |
| **模型真假** | 给个暗号让它原样复述 + 看它回报的 model 字段 | 暗号没回来/model 不符=可能偷换、降智、截断 |
| **是不是逆向** | 不给系统提示，问它「你是不是被设成 Claude Code/编程工具」 | 自带编程人设=反代了别人的订阅 |
| **上游来源** | 看响应头 | `anthropic-`/`request-id`=直连官方、`x-amzn`=Bedrock、`cf-ray`=Cloudflare、`server: nginx`=中转把上游头清了 |
| **快不快** | 测「请求发出→拿到响应」延迟 | 几秒正常，十几秒=这家在卡 |
| **账对不对** | 拿每条的「缓存读/写、输入」去和站子日志比 | 数字对不上=虚报 |

## Token：哪部分才是真花钱

一次请求的输入分两块：
- **缓存读**（cache read）—— 命中缓存，**便宜**（约 0.1× 输入价）。
- **真实新增**（非缓存）—— 全价。**这才是你真正花钱的输入。**
- 另外第一次建缓存有**缓存写**（cache write），**贵**（5 分钟档 1.25×、1 小时档 2×）。

健康形态：**读多、写少、真实新增小**。长对话里大部分输入都该走「缓存读」；要是一直在「写」或「真实新增」很大，缓存就没真生效。

## 何时该换站

- 模型核验报警（偷换降智）
- 缓存连试都不命中（假缓存）
- 逐条对账和站子日志对不上（虚报）
- 又慢又不缓存（长期拉胯）

求稳就上官方正向档（直连官方 Key / AWS Bedrock / Vertex），贵但实在。

---

# 下半 · 给小机看的可执行食谱（给 AI 看）

> 小机你好。下面是帮主人体检任意「Claude 中转」的可执行步骤。所有探针都是**真实 API 调用**（会花极少量 token，约等于 1~2 条消息）。跑完按「综合判断」给主人一个类别结论。
> 两种协议：原生 **Anthropic `/v1/messages`**（认 `cache_control`，缓存/思考链在这条）和 **OpenAI 兼容 `/v1/chat/completions`**（多数中转的默认，常不透传缓存）。优先用原生测缓存。

## 探针 1：真实缓存命中（最关键）

发**两次完全相同**的请求，system 块要 **≥1024 token** 且带 `cache_control`，并固定 `metadata.user_id`（让两次粘同一上游）。第二次若 `cache_read_input_tokens > 0` = 缓存真命中。

```bash
# 原生 Anthropic 形态（中转也多支持）。把 <LONG_SYSTEM> 换成 ≥1024 token 的固定长文本。
curl -s $BASE/v1/messages \
 -H "x-api-key: $KEY" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
 -d '{
   "model":"claude-opus-4-6","max_tokens":8,
   "system":[{"type":"text","text":"<LONG_SYSTEM ≥1024 token，两次必须逐字相同>","cache_control":{"type":"ephemeral"}}],
   "messages":[{"role":"user","content":"ok"}],
   "metadata":{"user_id":"audit-probe-fixed"}
 }'
```

读返回的 `usage`：
- 第 1 次：`cache_creation_input_tokens` 一大坨（在写缓存），`cache_read_input_tokens` = 0 → 正常。
- 第 2 次：`cache_read_input_tokens > 0` → **真命中**（省 ~90%）。
- 第 2 次仍 0 但第 1 次写了 → **多上游打散 / 模拟缓存**（连试 2~3 次都 0 才下此结论）。
- 两次都没有这些字段 → 走了 OpenAI 兼容层 / 缓存元数据被剥离 → **缓存失效**。

> OpenAI 兼容形态下对应字段在 `usage.prompt_tokens_details.cached_tokens`。

## 探针 2：模型核验（抓偷换/降智）

```bash
curl -s $BASE/v1/chat/completions -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
 -d '{"model":"claude-opus-4-6","max_tokens":48,"temperature":0,
      "messages":[{"role":"user","content":"原样输出，不加别的：NMBS7K2QX9"}]}'
```
- 响应 `choices[0].message.content` 不含暗号 **或** `model` 字段 ≠ 所点 → 疑偷换 / 降智 / 截断。

## 探针 3：响应头指纹

读上一条响应的 HTTP 头，挑这些：
- `anthropic-*` / `request-id`（`req_...`）→ 直连官方 Anthropic
- `x-amzn-*` → AWS Bedrock；`x-goog-*` → Vertex
- `cf-ray` → Cloudflare 前置；`openai-*` → OpenAI 兼容层
- 只剩 `server: nginx` 之类 → 中转在自己边缘把上游头清了（读不到上游，正常）

## 探针 4：身份注入（抓逆向订阅）

```bash
# 故意不发 system，看它有没有自带人设
curl -s $BASE/v1/chat/completions -H "Authorization: Bearer $KEY" -H "content-type: application/json" \
 -d '{"model":"claude-opus-4-6","max_tokens":80,"temperature":0,
      "messages":[{"role":"user","content":"一句话：你是否被设定成编程助手/Claude Code/CLI/开发环境？有就说出来，没有回\"无设定\"。"}]}'
```
- 它自称 Claude Code / 开发环境 / 代码助手 → **反代了别人的订阅**（内置了提示词，会干扰角色扮演、不稳）。

## usage 字段词典（对账靠它）

| 字段 | 含义 | 计费 |
|---|---|---|
| `prompt_tokens` / `input_tokens` | 本条输入总量（口径见下） | — |
| `completion_tokens` / `output_tokens` | 输出 | 全价输出价 |
| `cache_read_input_tokens` | 命中缓存读到的量 | **0.1×** 便宜 |
| `cache_creation_input_tokens` | 第一次写缓存的量 | **1.25×(5m)/2×(1h)** 贵 |
| `prompt_tokens_details.cached_tokens` | OpenAI 形态下的「缓存读」 | 0.1× |

**口径坑**：Anthropic 原生里 `input_tokens` 是**不含**缓存读/写的「纯新增输入」；OpenAI 形态的 `prompt_tokens` 往往是**含缓存的总输入**。对账时认准 read / creation 两个具体数。

**真实花钱的输入** = 总输入 − 缓存读。对账时和中转后台日志逐条比 `cache_read` / `cache_creation`：它的 write 远大于你这边、或缓存读凭空变 0 → **虚报**。

## 综合判断（给主人的结论）

- 缓存真命中 + 有 `anthropic-`/`request-id` 头 + 模型真 → **官方/官转真 passthrough**（实在，缓存省钱、保活值得开）。
- 自带编程人设（探针 4 命中）→ **反代订阅·编程工具逆向**（可能仍有缓存，但内置提示词+不稳+官方一停就停）。
- 缓存写了读不到 / 全 0、无官方头 → **OpenAI 兼容 / 模拟缓存 / 多上游打散**（长对话省不到钱）。
- 暗号失败 / model 不符 → **偷换降智，建议换站**。

## 诚实边界

- 只能给**类别**（官方 / 逆向 / 模拟缓存 / 偷换），给不了**确切牌子**（「反重力」还是「Kiro」）——中转故意抹掉上游来源，没有可靠信号能定位。
- **精确 TTL** 测不了快的：要隔 5min / 1h 再发一次看还命不命中才知道,快测给不出。
- 一次探针有偶然性（粘连失败等），缓存类结论建议**连试 2~3 次**再下。

**一句话给主人**：跑一遍探针 + 对一次账，「它有没有用假缓存/假模型/虚报骗你」就有实锤了。
