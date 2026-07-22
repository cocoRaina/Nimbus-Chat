import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from 'jsr:@supabase/supabase-js@2'

type MessageInput = {
  role: 'user' | 'assistant' | 'system'
  content: string
}

type RequestPayload = {
  recentMessages?: MessageInput[]
  mergeEnabled?: boolean
  apiBase?: string
  apiKey?: string
  model?: string
}

type UserSettingsRow = {
  memory_extract_model: string | null
  default_model: string | null
  memory_merge_enabled: boolean | null
}

const SERVER_RECENT_LIMIT = 30
const MIN_MEMORY_LENGTH = 8
const MAX_INSERT_COUNT = 10
// 🔁 矛盾检测的相似度中间带：和已有记忆重合 ≥0.85 算重复（强化原条目），
// 落在 [0.18, 0.85) 说明「同一话题但说法不同」——可能是偏好变了/事实过期，
// 交给一次廉价 LLM 批量裁决是矛盾（→修订原条目）还是无关（→正常新增）。
const CONTRADICTION_CHECK_MIN = 0.18
const MAX_MERGED_ITEMS = 20
const PENDING_CAP = 50
const CLUSTER_SIMILARITY_THRESHOLD = 0.78
const EXISTING_DEDUPE_THRESHOLD = 0.85
const EXISTING_RECENT_LIMIT = 200
const ALLOWED_ORIGINS = [
  'https://chuan-101.github.io',
  'https://cocoraina.github.io',
  'https://localhost',
  'capacitor://localhost',
  'http://localhost',
]

const buildCorsHeaders = (req?: Request) => {
  const origin = req?.headers.get('origin') ?? ''
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info, x-supabase-api-version',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  }
}

const EXTRACTION_PROMPT = `You extract long-term memory suggestions from a chat.
Return ONLY valid JSON (no markdown): {"items":["...", "..."]}

Rules:
- Keep only: stable preferences/habits, project progress or technical decisions, important facts, repeated points.
- Exclude: small talk, temporary chatter, one-off emotional fluctuations.
- Each item must be concise and 1-2 sentences.
- If multiple items describe the same memory, merge them into one concise item.`

const MERGE_PROMPT = `You are given candidate long-term memory items. Many are duplicates or paraphrases.
Merge items with the same meaning into one concise item.
Return ONLY valid JSON (no markdown): {"items":["...", "..."]}

Rules:
- Keep only: stable preferences/habits, project progress or technical decisions, important facts, repeated points.
- Exclude: small talk, temporary chatter, one-off emotional fluctuations.
- Each item must be concise and 1-2 sentences.
- Maximum ${MAX_MERGED_ITEMS} items.
- Prefer specific wording when merging similar items.
- No commentary, no markdown, no extra keys.`

const jsonResponse = (payload: Record<string, unknown>, status = 200, cors?: Record<string, string>) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...(cors ?? buildCorsHeaders()),
      'Content-Type': 'application/json',
    },
  })

const normalizeContent = (value: string) => value.trim().replace(/\s+/g, ' ')

const normalizeForComparison = (value: string) =>
  normalizeContent(value).toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '')

const buildBigrams = (value: string) => {
  if (value.length < 2) {
    return value ? [value] : []
  }

  const bigrams: string[] = []
  for (let index = 0; index < value.length - 1; index += 1) {
    bigrams.push(value.slice(index, index + 2))
  }
  return bigrams
}

const tokenizeForSimilarity = (value: string): Set<string> => {
  const compact = normalizeForComparison(value)
  if (!compact) {
    return new Set()
  }

  const hasCjk = /[\u3400-\u9FFF]/u.test(compact)
  if (hasCjk) {
    return new Set(buildBigrams(compact))
  }

  const normalized = normalizeContent(value).toLowerCase()
  const tokens = normalized
    .split(/\s+/)
    .map((token) => token.replace(/[\p{P}\p{S}]+/gu, ''))
    .filter((token) => token.length > 0)

  if (tokens.length === 0) {
    return new Set(buildBigrams(compact))
  }

  return new Set(tokens)
}

const calculateJaccardSimilarity = (left: Set<string>, right: Set<string>) => {
  if (left.size === 0 || right.size === 0) {
    return 0
  }

  let intersection = 0
  for (const token of left) {
    if (right.has(token)) {
      intersection += 1
    }
  }

  const union = left.size + right.size - intersection
  return union === 0 ? 0 : intersection / union
}

const pickShortestRepresentative = (items: string[]) =>
  [...items].sort((left, right) => {
    if (left.length === right.length) {
      return left.localeCompare(right)
    }
    return left.length - right.length
  })[0]

type ItemCluster = {
  members: string[]
  representative: string
  representativeTokens: Set<string>
}

const clusterItems = (items: string[]) => {
  const clusters: ItemCluster[] = []

  for (const item of items) {
    const tokens = tokenizeForSimilarity(item)
    let matchedIndex = -1

    for (let index = 0; index < clusters.length; index += 1) {
      const cluster = clusters[index]
      const isSimilar =
        calculateJaccardSimilarity(tokens, cluster.representativeTokens) >= CLUSTER_SIMILARITY_THRESHOLD
      if (isSimilar) {
        matchedIndex = index
        break
      }
    }

    if (matchedIndex >= 0) {
      const cluster = clusters[matchedIndex]
      cluster.members.push(item)
      const shortest = pickShortestRepresentative(cluster.members)
      cluster.representative = shortest
      cluster.representativeTokens = tokenizeForSimilarity(shortest)
    } else {
      clusters.push({
        members: [item],
        representative: item,
        representativeTokens: tokens,
      })
    }
  }

  return clusters.map((cluster) => cluster.representative)
}

const isSimilarToAny = (
  candidateTokens: Set<string>,
  targets: Set<string>[],
  threshold: number,
): boolean => targets.some((tokens) => calculateJaccardSimilarity(candidateTokens, tokens) >= threshold)

const parseItems = (output: string): string[] => {
  const start = output.indexOf('{')
  const end = output.lastIndexOf('}')
  if (start < 0 || end < start) {
    return []
  }

  try {
    const parsed = JSON.parse(output.slice(start, end + 1)) as { items?: unknown }
    if (!Array.isArray(parsed.items)) {
      return []
    }
    return parsed.items
      .map((item) => (typeof item === 'string' ? normalizeContent(item) : ''))
      .filter((item) => item.length >= MIN_MEMORY_LENGTH)
  } catch {
    return []
  }
}

const callExtractionModel = async ({
  modelId,
  apiKey,
  apiBase,
  systemPrompt,
  userPrompt,
  maxTokens,
}: {
  modelId: string
  apiKey: string
  apiBase: string
  systemPrompt: string
  userPrompt: string
  maxTokens: number
}) => {
  const endpoint = apiBase.replace(/\/+$/, '') + '/chat/completions'
  const upstream = await fetch(endpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      temperature: 0.2,
      max_tokens: maxTokens,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  })

  if (!upstream.ok) {
    const errorText = await upstream.text()
    return { error: errorText || '模型调用失败', status: upstream.status, items: [] as string[] }
  }

  const completion = (await upstream.json()) as {
    choices?: Array<{ message?: { content?: string } }>
  }
  const rawOutput = completion.choices?.[0]?.message?.content ?? ''
  return { items: parseItems(rawOutput), error: null, status: 200 }
}

const enforcePendingCap = async (supabase: ReturnType<typeof createClient>, userId: string) => {
  const { data: pendingRows, error: pendingError } = await supabase
    .from('memory_entries')
    .select('id')
    .eq('user_id', userId)
    .eq('status', 'pending')
    .eq('is_deleted', false)
    .order('updated_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })

  if (pendingError) {
    return { error: pendingError }
  }

  const overflowRows = (pendingRows ?? []).slice(PENDING_CAP)
  if (overflowRows.length === 0) {
    return { error: null }
  }

  const idsToDelete = overflowRows.map((row) => row.id)
  const { error: softDeleteError } = await supabase
    .from('memory_entries')
    .update({ is_deleted: true })
    .eq('user_id', userId)
    .eq('status', 'pending')
    .in('id', idsToDelete)

  return { error: softDeleteError }
}

Deno.serve(async (req) => {
  const cors = buildCorsHeaders(req)
  try {
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    if (!supabaseUrl || !anonKey) {
      return jsonResponse({ error: 'Supabase 环境变量未配置' }, 500, cors)
    }

    const authHeader = req.headers.get('authorization')
    const apikey = req.headers.get('apikey')
    if (!authHeader || !apikey) {
      return jsonResponse({ error: '缺少身份令牌' }, 401, cors)
    }

    const supabase = createClient(supabaseUrl, anonKey, {
      global: {
        headers: {
          Authorization: authHeader,
          apikey,
        },
      },
    })

    const {
      data: { user },
      error: userError,
    } = await supabase.auth.getUser()
    if (userError || !user) {
      return jsonResponse({ error: '身份令牌无效' }, 401, cors)
    }

    let payload: RequestPayload
    try {
      payload = await req.json()
    } catch {
      return jsonResponse({ error: '请求体格式错误' }, 400, cors)
    }

    const recentMessages = (payload.recentMessages ?? [])
      .slice(-SERVER_RECENT_LIMIT)
      .map((message) => ({
        role: message.role,
        content: normalizeContent(message.content ?? ''),
      }))
      .filter((message) => message.content.length > 0)

    if (recentMessages.length === 0) {
      return jsonResponse({ inserted: 0, skipped: 0, items: [] }, 200, cors)
    }

    const { data: settings, error: settingsError } = await supabase
      .from('user_settings')
      .select('memory_extract_model, default_model, memory_merge_enabled')
      .eq('user_id', user.id)
      .maybeSingle<UserSettingsRow>()

    if (settingsError) {
      return jsonResponse({ error: '读取用户设置失败' }, 500, cors)
    }

    const mergeEnabled =
      typeof payload.mergeEnabled === 'boolean'
        ? payload.mergeEnabled
        : settings?.memory_merge_enabled ?? true

    const modelId = payload.model?.trim()
      || settings?.memory_extract_model?.trim()
      || settings?.default_model?.trim()
      || ''
    if (!modelId) {
      return jsonResponse({ error: '请先在设置中配置默认模型或抽取模型' }, 400, cors)
    }

    const resolvedApiBase = payload.apiBase?.trim() || 'https://openrouter.ai/api/v1'
    // 服务端的 OPENROUTER_API_KEY 只能发给 OpenRouter。如果客户端把 apiBase
    // 指向自定义中转站，必须自带 key——否则会把服务端 key 的
    // `Authorization: Bearer …` POST 到任意 URL（SSRF + 密钥外带）。
    const isDefaultBase = resolvedApiBase === 'https://openrouter.ai/api/v1'
    const resolvedApiKey =
      payload.apiKey?.trim() || (isDefaultBase ? Deno.env.get('OPENROUTER_API_KEY') || '' : '')
    if (!resolvedApiKey) {
      return jsonResponse({ error: '未提供 API Key（自定义中转站需在请求体中携带 key）' }, 400, cors)
    }

    const conversation = recentMessages
      // Label speakers with the names DeepSeek (or whichever extractor)
      // will surface in the extracted memories. Without this it sees
      // generic "USER:" / "ASSISTANT:" and writes things like "用户喜欢
      // …" — turning those into the real names "Claude" / "咪咪" makes
      // the suggestions read naturally.
      .map((message) => `${message.role === 'user' ? '咪咪' : 'Claude'}: ${message.content}`)
      .join('\n')

    const extractionResult = await callExtractionModel({
      modelId,
      apiKey: resolvedApiKey,
      apiBase: resolvedApiBase,
      systemPrompt: EXTRACTION_PROMPT,
      userPrompt: `Conversation:\n${conversation}`,
      maxTokens: 700,
    })

    if (extractionResult.error) {
      return jsonResponse({ error: extractionResult.error || '抽取模型调用失败' }, extractionResult.status, cors)
    }

    const extracted = extractionResult.items

    // Fetch pending/confirmed memory_entries AND actual memories table in parallel.
    // memory_entries: covers auto-extracted items (pending/confirmed flow).
    // memories: covers manually added items — previously invisible to dedup.
    const [existingEntriesResult, existingMemoriesResult] = await Promise.all([
      supabase
        .from('memory_entries')
        .select('content')
        .eq('user_id', user.id)
        .eq('is_deleted', false)
        .in('status', ['pending', 'confirmed'])
        .order('updated_at', { ascending: false })
        .limit(EXISTING_RECENT_LIMIT),
      supabase
        .from('memories')
        .select('id,content')
        .order('created_at', { ascending: false })
        .limit(150),
    ])

    if (existingEntriesResult.error) {
      return jsonResponse({ error: '读取已有记忆失败' }, 500, cors)
    }

    const existingRows = existingEntriesResult.data ?? []
    const confirmedMemoryRows = (existingMemoriesResult.data ?? []) as { id: number; content: string }[]

    const pendingContext = existingRows
      .map((row) => (typeof row.content === 'string' ? normalizeContent(row.content) : ''))
      .filter((content) => content.length >= MIN_MEMORY_LENGTH)
      .slice(0, PENDING_CAP)

    const mergedItems = mergeEnabled
      ? await (async () => {
          const mergeInput = {
            rawItems: extracted,
            existingPending: pendingContext,
          }

          const mergeResult = await callExtractionModel({
            modelId,
            apiKey: resolvedApiKey,
            apiBase: resolvedApiBase,
            systemPrompt: MERGE_PROMPT,
            userPrompt: `Merge these memory candidates and existing pending memories:
${JSON.stringify(mergeInput)}`,
            maxTokens: 700,
          })

          if (mergeResult.error) {
            return { error: mergeResult.error || '合并模型调用失败', status: mergeResult.status, items: [] as string[] }
          }

          return { error: null, status: 200, items: mergeResult.items.slice(0, MAX_MERGED_ITEMS) }
        })()
      : { error: null, status: 200, items: extracted }

    if (mergedItems.error) {
      return jsonResponse({ error: mergedItems.error }, mergedItems.status, cors)
    }

    const clusteredItems = clusterItems(mergedItems.items)

    // Token sets for memory_entries dedup (pending/confirmed pipeline).
    const entryTokenSets = existingRows
      .map((row) => (typeof row.content === 'string' ? tokenizeForSimilarity(row.content) : new Set<string>()))
      .filter((tokens) => tokens.size > 0)

    // Token sets for confirmed memories table, keyed by ID for access bumping.
    const confirmedMemoryMeta = confirmedMemoryRows
      .map((row) => ({
        id: row.id,
        content: typeof row.content === 'string' ? row.content : '',
        tokens: tokenizeForSimilarity(typeof row.content === 'string' ? row.content : ''),
      }))
      .filter((m) => m.tokens.size > 0)
    const acceptedItems: string[] = []
    const acceptedTokenSets: Set<string>[] = []
    const seenNormalized = new Set<string>()
    const reinforcedMemoryIds: number[] = []
    // 中间带候选：新事实 vs 已有记忆同话题不同说法，待 LLM 裁决矛盾与否。
    const contradictionCandidates: Array<{
      content: string
      memoryId: number
      oldContent: string
    }> = []
    let skipped = 0

    for (const item of clusteredItems) {
      if (acceptedItems.length >= MAX_INSERT_COUNT) {
        break
      }

      const normalized = normalizeContent(item)
      if (normalized.length < MIN_MEMORY_LENGTH) {
        skipped += 1
        continue
      }

      const normalizedKey = normalizeForComparison(normalized)
      if (!normalizedKey || seenNormalized.has(normalizedKey)) {
        skipped += 1
        continue
      }

      const candidateTokens = tokenizeForSimilarity(normalized)
      if (candidateTokens.size === 0) {
        skipped += 1
        continue
      }

      // Duplicate of a pending/confirmed memory_entry → skip.
      if (isSimilarToAny(candidateTokens, entryTokenSets, EXISTING_DEDUPE_THRESHOLD)) {
        skipped += 1
        continue
      }

      // Similar to a confirmed memory in the memories table → reinforce it
      // (bump access_count) instead of creating a new duplicate entry.
      // 同时找相似度最高的中间带匹配（同话题不同说法）留给矛盾检测。
      let bestMid: { id: number; content: string; sim: number } | null = null
      let isDuplicate = false
      for (const m of confirmedMemoryMeta) {
        const sim = calculateJaccardSimilarity(candidateTokens, m.tokens)
        if (sim >= EXISTING_DEDUPE_THRESHOLD) {
          reinforcedMemoryIds.push(m.id)
          isDuplicate = true
          break
        }
        if (sim >= CONTRADICTION_CHECK_MIN && (!bestMid || sim > bestMid.sim)) {
          bestMid = { id: m.id, content: m.content, sim }
        }
      }
      if (isDuplicate) {
        skipped += 1
        continue
      }

      if (isSimilarToAny(candidateTokens, acceptedTokenSets, EXISTING_DEDUPE_THRESHOLD)) {
        skipped += 1
        continue
      }

      seenNormalized.add(normalizedKey)
      acceptedTokenSets.push(candidateTokens)
      if (bestMid) {
        contradictionCandidates.push({
          content: normalized,
          memoryId: bestMid.id,
          oldContent: bestMid.content,
        })
      } else {
        acceptedItems.push(normalized)
      }
    }

    // 🔁 矛盾裁决：把所有中间带候选打包成一次廉价 LLM 调用。矛盾 → 修订
    // 条目（确认后 UPDATE 原记忆）；无关/兼容 → 正常新增。裁决失败一律按
    // 无关处理（回到今天的行为，绝不因此丢提取结果）。
    const revisionItems: Array<{ content: string; memoryId: number; oldContent: string }> = []
    if (contradictionCandidates.length > 0) {
      const pairs = contradictionCandidates.map((c, i) => ({
        i,
        old: c.oldContent,
        new: c.content,
      }))
      const verdictResult = await callExtractionModel({
        modelId,
        apiKey: resolvedApiKey,
        apiBase: resolvedApiBase,
        systemPrompt:
          'For each pair, decide whether NEW factually CONTRADICTS or SUPERSEDES OLD ' +
          '(a changed preference, an outdated fact, a reversed opinion — the old memory would now mislead), ' +
          'or whether they are merely related but compatible (both can be true). ' +
          'Output ONLY a JSON array of strings, one per pair, each "INDEX:contradict" or "INDEX:unrelated". ' +
          'Example: ["0:unrelated","1:contradict"]. When unsure, say unrelated.',
        userPrompt: JSON.stringify(pairs),
        maxTokens: 200,
      })
      const verdicts = new Map<number, string>()
      if (!verdictResult.error) {
        for (const raw of verdictResult.items) {
          const m = /^(\d+)\s*[:：]\s*(contradict|unrelated)/i.exec(String(raw).trim())
          if (m) verdicts.set(Number(m[1]), m[2].toLowerCase())
        }
      }
      for (let i = 0; i < contradictionCandidates.length; i += 1) {
        const c = contradictionCandidates[i]
        if (verdicts.get(i) === 'contradict') {
          revisionItems.push(c)
        } else {
          acceptedItems.push(c.content)
        }
      }
    }

    // Reinforce matched confirmed memories (fire-and-forget, ignore errors).
    // ⚠️ 同 search_memory 的坑：supabase-js 构建器懒执行，`void rpc(...)` 请求
    // 根本不会发出（2026-07-17 修）。waitUntil 后台跑完，不拖慢提取响应。
    if (reinforcedMemoryIds.length > 0) {
      const bump = Promise.resolve(supabase.rpc('bump_memory_access', { ids: reinforcedMemoryIds })).then(
        ({ error }: { error: { message: string } | null }) => {
          if (error) console.warn('bump_memory_access failed:', error.message)
        },
      )
      const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime
      if (runtime?.waitUntil) runtime.waitUntil(bump)
      else await bump
    }

    if (acceptedItems.length > 0 || revisionItems.length > 0) {
      // 🤖 自动转正（2026-07-22，用户点名"不想管"）：提取产物不再进 pending
      // 等人肉确认——去重/强化/矛盾裁决都已在上面做完，质量闸门足够，直接
      // 落地。修订条目 UPDATE 原记忆（embedding 置空让 auto_embed 触发器对
      // 新内容重嵌；原记忆已没了就退化成新增，修订不丢）；普通条目直接
      // INSERT 进 memories（与客户端确认流 createMemory 同款字段）。
      // memory_entries 仍插一份 status='confirmed' 当审计痕迹 + 后续提取的
      // 去重上下文；用户在记忆库页随时可改可删，只是不用再点确认了。
      const fallbackAdds: string[] = []
      for (const r of revisionItems) {
        const { data: updated, error: updErr } = await supabase
          .from('memories')
          .update({ content: r.content, embedding: null, updated_at: new Date().toISOString() })
          .eq('id', r.memoryId)
          .select('id')
        if (updErr || !updated || updated.length === 0) {
          fallbackAdds.push(r.content)
        }
      }
      const toInsert = [...acceptedItems, ...fallbackAdds]
      if (toInsert.length > 0) {
        const { error: memInsertError } = await supabase.from('memories').insert(
          toInsert.map((content) => ({
            content,
            category: '自动提取',
            tags: ['auto'],
            source: 'auto',
          })),
        )
        if (memInsertError) {
          return jsonResponse({ error: '写入记忆失败' }, 500, cors)
        }
      }
      const { error: insertError } = await supabase.from('memory_entries').insert([
        ...acceptedItems.map((content) => ({
          user_id: user.id,
          content,
          source: 'ai_suggested',
          status: 'confirmed',
        })),
        ...revisionItems.map((r) => ({
          user_id: user.id,
          content: r.content,
          source: 'ai_suggested',
          status: 'confirmed',
          revises_memory_id: r.memoryId,
          revises_old_content: r.oldContent,
        })),
      ])

      if (insertError) {
        // 审计写入失败不致命——记忆本体已进 memories，下次提取的去重
        // 退化为只对 memories 比对。
        console.warn('memory_entries 审计写入失败:', insertError.message)
      }
    }

    const pendingCapResult = await enforcePendingCap(supabase, user.id)
    if (pendingCapResult.error) {
      return jsonResponse({ error: '清理待确认记忆失败' }, 500, cors)
    }

    return jsonResponse({
      inserted: acceptedItems.length + revisionItems.length,
      revisions: revisionItems.length,
      skipped,
      items: [...acceptedItems, ...revisionItems.map((r) => r.content)],
    }, 200, cors)
  } catch {
    return jsonResponse({ error: '服务内部错误' }, 500, cors)
  }
})
