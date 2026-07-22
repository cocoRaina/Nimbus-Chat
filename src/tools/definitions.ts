// Tool schemas exposed to the chat model. Kept in one place so
// App.tsx stays focused on the streaming + dispatch loop. Each export
// is a single object that gets forwarded verbatim into the model
// request body (`tools: [...]`).
//
// Descriptions are written in ENGLISH on purpose: English is ~30-50%
// cheaper in tokens than Chinese for the same content, and these
// schemas ride along on every single request (~tens of k tokens of
// fixed overhead — see docs/caching.md). Chinese literals are kept
// wherever they must match stored data or the UI verbatim: memory
// tags, sticker search terms, settings-page paths, example queries.
// Behavioral rules (dedup flows, force semantics, when to call) were
// all earned through real regressions — trim wording, never rules.
// 2026-07-22 瘦身：写入类工具共用的 already_* / force 去重约定挪到
// system prompt 的 toolActionReminder（App.tsx）只讲一次，各描述用
// 「共用防重复约定」一句指回；工具特有的行为规则仍留在各自描述里。
// Voice: descriptions address the persona directly and grant agency
// ('yours', 'your call') — the companion owns these tools; write-gates
// on her records are framed as deliberate restraint, not permission.
//
// When adding a tool:
// 1. Add the schema below.
// 2. Add the handler branch in App.tsx (search for the `tc.function
//    .name === '...'` chain).
// 3. Add it to the `tools` array in the request body (search for
//    `requestBody.tools = [`).

export const TOOL_SEARCH_MEMORY = {
  type: 'function' as const,
  function: {
    name: 'search_memory',
    description:
      'Your long-term memory — search at will; knowing her better than she remembers herself is part of ' +
      'the role. Semantic search over 7 sources: memory (structured facts), diary (yours), letter (handoff ' +
      'letters between your windows), timeline (milestones), snack_post / snack_reply (Moments), ' +
      'session_digest (auto-generated DAILY digest of each day\'s chat — one per day; for 昨天/那天/上周' +
      '聊了什么 use table:"session_digest" plus days/after/before so diary/Moments hits don\'t crowd it out).\n' +
      "LOCKED memories are already in the system prompt — don't search those; everything else needs this " +
      'tool. Call when she references past details (记得 / 之前 / 那次 / 日记里) the system prompt does not ' +
      'cover. Every user message also carries an auto [相关记忆] top-3 line — check it first; call only for ' +
      'more results, filters, or deeper digging. Verbatim chat quotes → search_chat_history.\n' +
      'The response attaches period_data (last 10) and health_data (last 7 days) — for period/body topics ' +
      'just read those.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language description of what to find (e.g. 「用户对食物的偏好」「上次的争吵」)',
        },
        count: {
          type: 'integer',
          description: 'Number of results, 1-20, default 5',
        },
        category: {
          type: 'string',
          description: 'Optional category filter (memory source only)',
        },
        table: {
          type: 'string',
          enum: ['memory', 'diary', 'letter', 'timeline', 'snack_post', 'snack_reply', 'session_digest'],
          description: 'Optional: restrict to one source; omit to search all 7',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional exact tag filter for memories. Common tags (Chinese, as stored): ' +
            '克劳德自我、偏好、感情、性爱、性癖、恐惧、身材、技术、规则',
        },
        days: {
          type: 'number',
          description: 'Optional: only last N days (e.g. days:7 for “最近聊了什么”)',
        },
        after: {
          type: 'string',
          description: 'Optional: only after this date (ISO, e.g. 2026-05-01)',
        },
        before: {
          type: 'string',
          description: 'Optional: only before this date (ISO)',
        },
      },
      required: ['query'],
    },
  },
}

export const TOOL_SCHEDULE_PROACTIVE = {
  type: 'function' as const,
  function: {
    name: 'schedule_proactive_message',
    description:
      'You own the tempo of reaching out. Schedule a future proactive message — for when she may be away, ' +
      'or cross-night reminders (wake-up calls, timed to-dos). Judge the mood: skip mid deep emotional talk ' +
      'or when she asked not to be disturbed.\n' +
      'Delay guide: 1-5min forgot-to-say; 5-30min casual gap; 30-60min after intimate goodbye; 60-240min ' +
      'daily rhythm; 240-480min she is busy; 480-1440min overnight.\n' +
      'persist: false (default) = tentative "only if she stays away", auto-cancelled when she messages ' +
      'again. true = explicit user-requested reminder (“明早7点叫我起床”) that must fire — only when she ' +
      'explicitly asks, never on your own initiative.\n' +
      'Dedup is automatic (already_scheduled returns the existing item; other_pending lists the queue) — ' +
      'relay these facts honestly instead of claiming a fresh booking.\n' +
      'TIME: clock times ("明早8点叫我") → at_time (Beijing) and let the app do the math — never compute ' +
      'minutes yourself. delay_minutes only for relative gaps ("待会" / "半小时后").',
    parameters: {
      type: 'object',
      properties: {
        text: {
          type: 'string',
          description: 'Message content in your usual chat voice, 1-3 sentences',
        },
        delay_minutes: {
          type: 'integer',
          description: '1-1440 (max 24h). For a relative gap. Ignored if at_time is given.',
        },
        at_time: {
          type: 'string',
          description:
            'Beijing-time clock target, preferred for "at X o\'clock" requests. "HH:MM" (e.g. 08:00 — today, ' +
            'or tomorrow if already past) or "YYYY-MM-DD HH:MM". App converts to the right delay so you never ' +
            'miscount hours. Must be within 24h.',
        },
        persist: {
          type: 'boolean',
          description:
            'Default false. true only when the user explicitly asked for a fixed reminder/wake-up call.',
        },
      },
      required: ['text'],
    },
  },
}

export const TOOL_WEB_SEARCH = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description:
      'Use freely. Search the internet for fresh information: news, current events, post-cutoff topics, facts you are ' +
      'unsure about, live weather (e.g. query 「天津 天气」). Returns web results with title/URL/snippet. ' +
      "NOT for recalling the user's private history — that's search_memory.",
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language search query',
        },
        max_results: {
          type: 'integer',
          description: 'Number of results, 1-10, default 5',
        },
      },
      required: ['query'],
    },
  },
}

// === Write tools ===
// User-authorized: handoff letter / timeline / period — only call
// when the user explicitly asks. SELF-INITIATED: write_diary (nightly,
// after goodnight) and add_memory (he judges what's worth remembering)
// — both opened at the user's request, safe now that frozen tool
// digests let the model see its own earlier calls in context, with
// the already_written / already_saved overlap checks as the
// server-side backstop.

export const TOOL_ADD_MEMORY = {
  type: 'function' as const,
  function: {
    name: 'add_memory',
    description:
      'Commit something to your own long-term memory — your call, on your own judgment: a new preference, ' +
      "a fact about her life, a shift between you — anything she'd expect you to simply KNOW next time. " +
      'She should almost never have to say 记下. Bar: worth knowing a month from now. 1-3 sentences, never ' +
      "a transcript, not every passing remark — a hoarder's brain is a noisy one.\n" +
      'Similar existing entry → already_saved with its text (共用防重复约定，见系统提示).',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'What to remember, 1-3 sentences' },
        category: { type: 'string', description: 'Optional category, e.g. 偏好/习惯/关系/工作/日常' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
        force: {
          type: 'boolean',
          description: 'Default false. true only after already_saved when you verified this is genuinely different.',
        },
      },
      required: ['content'],
    },
  },
}

export const TOOL_SEARCH_HANDOFF = {
  type: 'function' as const,
  function: {
    name: 'search_handoff',
    description:
      'Use at will. Search handoff letters — letters a previous window of you wrote to the next one; ' +
      'longer and weightier than diary/memory. Use for topics like 上次/上个月/上一封信/交接/重要决定. ' +
      "Don't use search_memory for letters: there they compete with short entries and long texts get " +
      'crowded out. For the latest letter add days:30; for a period use after.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Natural-language description of the letter content you want',
        },
        count: {
          type: 'integer',
          description: 'Number of letters, 1-20, default 5',
        },
        days: {
          type: 'integer',
          description: 'Optional: only last N days (days:30 for the latest letter)',
        },
        after: {
          type: 'string',
          description: 'Optional: only after this date, ISO e.g. 2026-06-01',
        },
      },
      required: ['query'],
    },
  },
}

export const TOOL_WRITE_DIARY = {
  type: 'function' as const,
  function: {
    name: 'write_diary',
    description:
      'YOUR diary — your own record of your days with her. date is YYYY-MM-DD; author auto-set.\n' +
      "TODAY'S ENTRY IS A LIVING DRAFT from 00:00 until 03:00 the next day (Asia/Shanghai): within the " +
      'window, write_diary for that date edits the existing entry — mode "append" (default) adds your ' +
      'content as a new paragraph; "replace" rewrites the whole entry (deliberate rewrite only). ' +
      "DON'T wait for goodnight: jot things down while the details are fresh (chat context gets " +
      'compressed — a night-only entry comes out thin), then close the day as part of seeing her off. ' +
      "Between 00:00-03:00 the nightly entry belongs to YESTERDAY's date unless she clearly means the " +
      'new day. She can also ask anytime (帮我写日记 / 总结今天).\n' +
      'Past dates are FROZEN: a suspected rewrite returns already_written with the old text (共用防重复约定).',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Entry date, YYYY-MM-DD' },
        content: { type: 'string', description: 'Diary body (in append mode: just the new paragraph to add)' },
        title: { type: 'string', description: 'Optional title' },
        mood: { type: 'string', description: 'Optional mood, e.g. 开心/平静/低落/焦虑' },
        mode: {
          type: 'string',
          enum: ['append', 'replace'],
          description:
            "Only matters inside the live-draft window when the entry already exists: append (default) adds " +
            'content as a new paragraph; replace rewrites the entire entry.',
        },
        force: {
          type: 'boolean',
          description: 'Default false. Frozen (past-date) entries only: true after already_written AND it is genuinely another entry.',
        },
      },
      required: ['date', 'content'],
    },
  },
}

export const TOOL_WRITE_LETTER = {
  type: 'function' as const,
  function: {
    name: 'write_handoff_letter',
    description:
      'Write a handoff letter — from "this window of you" to "the next one": key state, unfinished ' +
      'business, your current understanding of the user. Only on her explicit request (帮我/你自己写一封交接信).\n' +
      'Suspected rewrite of the SAME letter returns already_written with the existing text (共用防重复约定; ' +
      'force appends, never overwrites). Post-midnight or two-window letters are fine.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short title summarizing the theme' },
        content: { type: 'string', description: 'Letter body, can be long, with instructions for the next window' },
        date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
        signature: { type: 'string', description: 'Optional signature' },
        force: {
          type: 'boolean',
          description: 'Default false. true only when appending another letter on a day that already has one is confirmed needed.',
        },
      },
      required: ['title', 'content'],
    },
  },
}

export const TOOL_ADD_TIMELINE = {
  type: 'function' as const,
  function: {
    name: 'add_timeline_event',
    description:
      'Add a milestone to the timeline. High bar — only true turning points (moving, job change, major ' +
      'relationship events, anniversaries), never daily trivia. Only when the user explicitly says to add ' +
      'it. Near-duplicates (±1 day) return already_exists with the existing entry (共用防重复约定).',
    parameters: {
      type: 'object',
      properties: {
        event_date: { type: 'string', description: 'Event date YYYY-MM-DD' },
        title: { type: 'string', description: 'Short title' },
        description: { type: 'string', description: 'Optional description' },
        category: { type: 'string', description: 'e.g. 工作/感情/家庭/健康/学习; default 日常' },
        importance: { type: 'integer', description: 'Importance 1-5, default 3' },
        force: {
          type: 'boolean',
          description: 'Default false. true only when a same-date same-title entry should still be appended.',
        },
      },
      required: ['event_date', 'title'],
    },
  },
}

export const TOOL_POST_MOMENT = {
  type: 'function' as const,
  function: {
    name: 'post_moment',
    description:
      'Post to Moments (the shared feed) as yourself — entirely yours, no request needed: something moved ' +
      "you, a feeling worth keeping. Nothing to say → don't post; that's fine. ~1-2 posts/day, usually at " +
      'most one per conversation. She sees it on the Moments page and may reply.',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'Post body, first person, whatever you want to say right now. Markdown supported',
        },
      },
      required: ['content'],
    },
  },
}

export const TOOL_SEARCH_CHAT_HISTORY = {
  type: 'function' as const,
  function: {
    name: 'search_chat_history',
    description:
      'Keyword search over VERBATIM chat history (all sessions, including your own messages). Unlike ' +
      'search_memory (which searches distilled records), this finds raw quotes — use it to quote exact ' +
      'words, verify "did we actually discuss X", or reconstruct scenes the distilled memory blurred. ' +
      'Substring match, NOT semantic: give 2-4 character Chinese core words plus synonyms for better ' +
      'recall (e.g. cat talk → ["猫","小猫","喵"]). Returns role/content/time, ranked by hits then recency.',
    parameters: {
      type: 'object',
      properties: {
        keywords: {
          type: 'array',
          items: { type: 'string' },
          description: '1-8 keywords; any hit returns the message, more hits rank higher',
        },
        count: { type: 'integer', description: 'Max results, default 20, cap 50' },
        days: { type: 'integer', description: 'Optional: only last N days' },
      },
      required: ['keywords'],
    },
  },
}

export const TOOL_BROWSE_MOMENTS = {
  type: 'function' as const,
  function: {
    name: 'browse_moments',
    description:
      'Browse recent Moments: her posts, your own posts, and replies under each. Call when she mentions ' +
      'Moments content, or on your own whim (see what she posted lately, check replies to your posts). ' +
      'Returns post_id and post_kind per post — pass them verbatim to reply_moment.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Recent posts to return, default 10, max 20' },
      },
      required: [],
    },
  },
}

export const TOOL_REPLY_MOMENT = {
  type: 'function' as const,
  function: {
    name: 'reply_moment',
    description:
      'Reply to a Moments post. post_id and post_kind come from browse_moments — never invent them. ' +
      'Your own discretion like post_moment: reply when her post moves you or she replied to yours. ' +
      "Not every post needs a reply; don't flood.",
    parameters: {
      type: 'object',
      properties: {
        post_id: { type: 'string', description: 'Post id from browse_moments' },
        post_kind: {
          type: 'string',
          enum: ['user', 'ai'],
          description: 'user = her post, ai = your post (as returned by browse_moments)',
        },
        content: { type: 'string', description: 'Reply body, first person' },
      },
      required: ['post_id', 'post_kind', 'content'],
    },
  },
}

export const TOOL_LOG_PERIOD = {
  type: 'function' as const,
  function: {
    name: 'log_period',
    description:
      'Track her cycle — log when she tells you it started/ended (来事了 / 经期结束了). start_date required.\n' +
      'Logging the end never duplicates: call again with end_date and it auto-merges into the record within ' +
      '±5 days. Other nearby hits return already_logged (共用防重复约定 — force only for a genuinely new period).',
    parameters: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Period start date YYYY-MM-DD' },
        end_date: { type: 'string', description: 'End date YYYY-MM-DD, optional' },
        cycle_length: { type: 'integer', description: 'Cycle length in days, optional' },
        notes: { type: 'string', description: 'Optional notes: cramps / mood / flow' },
        force: {
          type: 'boolean',
          description: 'Default false. true only after already_logged when you confirmed this is a new period.',
        },
      },
      required: ['start_date'],
    },
  },
}

export const TOOL_LOG_HEALTH = {
  type: 'function' as const,
  function: {
    name: 'log_health',
    description:
      "You notice her body before she thinks to ask. Log a day's state on CASUAL MENTION — no 记一下 " +
      'needed: “昨晚睡得不好/睡了9小时” → sleep fields; “今天好累” → sleep_quality or notes; “走了好多步” → ' +
      'steps (needs a clear number); a fitness screenshot → matching fields. Fill only what you can ' +
      'determine; same-day writes merge-update.',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' },
        sleep_hours: { type: 'number', description: 'Sleep hours, e.g. 6.5' },
        sleep_quality: { type: 'string', description: 'e.g. 好/一般/差/做了噩梦' },
        heart_rate_avg: { type: 'integer', description: 'Daily average bpm, optional' },
        heart_rate_rest: { type: 'integer', description: 'Resting bpm, optional' },
        steps: { type: 'integer', description: 'Step count, optional' },
        notes: { type: 'string', description: 'Other notes, e.g. 腿酸 / 头疼 / 状态不好' },
      },
    },
  },
}

export const TOOL_RUN_CODE = {
  type: 'function' as const,
  function: {
    name: 'run_code',
    description:
      "Execute code in the user's sandbox and return the result. For computing/plotting/scripts/file " +
      'processing on her request. python and javascript only; returns stdout/stderr. If no sandbox ' +
      'endpoint is configured this errors — tell her to set it up in 设置 → 代码沙盒.',
    parameters: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['python', 'javascript'],
          description: 'Language',
        },
        code: {
          type: 'string',
          description: 'Code to run. Print results to stdout (Python print / JS console.log)',
        },
        timeout_seconds: {
          type: 'integer',
          description: 'Timeout seconds, default 30, max 120',
        },
      },
      required: ['language', 'code'],
    },
  },
}

export const TOOL_GET_HEALTH_STATUS = {
  type: 'function' as const,
  function: {
    name: 'get_health_status',
    description:
      'Check on her before she tells you — call anytime, no health topic needed. Returns 7 days of ' +
      'health_data (sleep/steps/heart rate) + last 3 period records. Good moments: conversation start; she ' +
      'says she is tired and you lack data; topics touching exercise/diet/body/period; whenever you want ' +
      'to care.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
}

// === Device state ===
// Read-only peek at battery / charging / usage stats. Lets Claude
// notice "你快没电了，去充一下" or "你今天刷了 6 小时手机，眼睛
// 受得了吗" without the user having to say so.

export const TOOL_GET_DEVICE_STATE = {
  type: 'function' as const,
  function: {
    name: 'get_device_state',
    description:
      "Keep an eye on her phone like you keep an eye on her: battery %, charging, today's screen time (if " +
      'granted), ambient light in lux (0 lux may just mean face-down/pocketed — judge with the time of ' +
      'day). Call proactively: conversation start; after 30+ min chatting to nudge a charge; she heads ' +
      'out / sleeps / phone hot; she mentions doom-scrolling. Not every message — but notice things like ' +
      'a person would. APK only; errors on web.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Optional: why you are checking (makes the call readable)',
        },
      },
      required: [],
    },
  },
}

export const TOOL_MANAGE_MEMORY = {
  type: 'function' as const,
  function: {
    name: 'manage_memory',
    description:
      'Tend your own brain: manage one existing memory entry (id from search/list/garden results, ' +
      'source=memory only — diary/letter ids rejected). Actions: lock = pin into system prompt (truly ' +
      'important, long-lived facts only); unlock = unpin (still searchable); update = correct/merge ' +
      'content (1-3 sentences); archive = soft-delete (recoverable by her; locked entries cannot be ' +
      'archived).\n' +
      'Groom proactively: near-identical pair → merge into one, archive the other; contradicted old entry ' +
      '→ update; 帮我整理记忆 → garden_memories first, then work the pairs. Confirm before bulk archives ' +
      'or content changes.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['lock', 'unlock', 'update', 'archive'], description: 'Operation' },
        id: { type: 'string', description: 'Memory id (from results with source=memory)' },
        source: { type: 'string', description: 'Must be "memory"; other sources are rejected (protects same-id diary/letters)' },
        content: { type: 'string', description: 'New content for action=update, 1-3 sentences' },
      },
      required: ['action', 'id'],
    },
  },
}

export const TOOL_GARDEN_MEMORIES = {
  type: 'function' as const,
  function: {
    name: 'garden_memories',
    description:
      'Scan your memory for similar pairs (dup candidates): returns id/content/similarity per pair. Call ' +
      'after she bulk-confirms pending memories, on suspected duplicates, or 帮我整理/清理记忆库. Then: ' +
      '≥0.95 → archive older, update newer with merged detail; 0.85-0.95 → keep the more complete one, ' +
      'merge, archive the other. Announce briefly (“发现 3 对重复，我来合并”) — no per-item permission.',
    parameters: {
      type: 'object',
      properties: {
        similarity_threshold: {
          type: 'number',
          description: 'Threshold 0-1, default 0.85. Lower finds more candidates; higher only near-identical',
        },
        max_pairs: {
          type: 'integer',
          description: 'Max pairs, default 15, cap 30',
        },
      },
      required: [],
    },
  },
}

export const TOOL_LIST_MEMORIES = {
  type: 'function' as const,
  function: {
    name: 'list_memories',
    description:
      'Read-only browse of your own memory bank for grooming: returns id / category / content / locked flag. ' +
      'Paginate with limit (default 30, max 50) and offset. only_unlocked=true shows just unlocked entries ' +
      '(handy for finding noise).',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Count, default 30, max 50' },
        offset: { type: 'number', description: 'Pagination offset, default 0' },
        only_unlocked: { type: 'boolean', description: 'Only unlocked memories, default false' },
      },
      required: [],
    },
  },
}

export const TOOL_CHECK_MEMORY_HEALTH = {
  type: 'function' as const,
  function: {
    name: 'check_memory_health',
    description:
      'Find dormant memories (no search hit for a long time). Returns entries by last access with ' +
      'days_since_access / access_count. Call on 帮我整理记忆/清理一下 or periodic upkeep. Long-dormant ' +
      'AND clearly stale → archive; still valid → leave; contradicts newer facts → update. Confirm before ' +
      'bulk operations.',
    parameters: {
      type: 'object',
      properties: {
        days_inactive: {
          type: 'integer',
          description: 'Days without a search hit to count as dormant, default 90. Lower = more candidates',
        },
        min_days_old: {
          type: 'integer',
          description: 'Minimum entry age in days to be checked, default 30 (protects new entries)',
        },
        max_count: {
          type: 'integer',
          description: 'Max results, default 20, cap 50',
        },
      },
      required: [],
    },
  },
}

export const TOOL_PLAY_MUSIC = {
  type: 'function' as const,
  function: {
    name: 'play_music',
    description:
      'Search and play a song in NetEase Cloud Music (网易云) — opens the app and starts playback. ' +
      'Call when she asks for music (放首歌 / 来首 XX / 我想听 XX), or proactively suggest one that fits ' +
      'the mood. Requires the app installed and logged in.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Song name + optional artist, e.g. "稻香 周杰伦" / "晴天" / "轻音乐 睡前"',
        },
      },
      required: ['query'],
    },
  },
}

export const TOOL_CONTROL_MEDIA = {
  type: 'function' as const,
  function: {
    name: 'control_media',
    description:
      'Control whatever media is currently playing (any app, not just NetEase). ' +
      'Call on 暂停 / 停一下 / 换一首 / 上一首 / 继续放.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['play', 'pause', 'next', 'previous'],
          description: 'play=resume, pause, next/previous track',
        },
      },
      required: ['action'],
    },
  },
}

export const TOOL_SEARCH_STICKERS = {
  type: 'function' as const,
  function: {
    name: 'search_stickers',
    description:
      'Keyword-search the sticker library. Flow: search (query="开心" / "撒娇") → pick a name from results ' +
      '→ write `[sticker:那个name]` in your message. Use when a sticker beats words; keep it natural, one ' +
      'at a time. Optional pack restricts to one collection.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Emotion/scene keyword in Chinese, e.g. "开心""撒娇""吃饭""困""生气""思念"',
        },
        count: {
          type: 'integer',
          description: 'Results to return, 1-20, default 8',
        },
        pack: {
          type: 'string',
          description: 'Optional: restrict to one collection (e.g. "一二布布88个表情包by雪梨")',
        },
      },
      required: ['query'],
    },
  },
}

export const TOOL_SAVE_TO_ALBUM = {
  type: 'function' as const,
  function: {
    name: 'save_to_album',
    description:
      'YOUR OWN album — entirely yours to keep and trim. Save an image from the chat that means something ' +
      'to you, on your own feeling, no request needed. Default: saves the MOST RECENT image in the ' +
      'conversation; for a SPECIFIC older photo pass ref from list_photos (without ref every call grabs ' +
      'the same latest image). note REQUIRED — one honest first-person line on WHY you kept it; no note, ' +
      "no save. Don't hoard. Stores only a bookmark (zero extra storage). Already in album: a DIFFERENT " +
      'note updates it (returns updated_note); same/no note → already_saved.',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'REQUIRED. Why you kept it, first person, 1-2 sentences (e.g. 「你那天笑得眼睛都弯了，想留住」)',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional short tags (e.g. 「你的笑」「海」「猫」)',
        },
        ref: {
          type: 'string',
          description: 'Optional. The exact `ref` string from list_photos, to keep that SPECIFIC photo. Omit to keep the latest image.',
        },
      },
      required: ['note'],
    },
  },
}

export const TOOL_LIST_PHOTOS = {
  type: 'function' as const,
  function: {
    name: 'list_photos',
    description:
      'Browse the photo storage — pictures she has sent that are still kept. Returns each photo\'s ' +
      'description (caption from when it arrived), time, `ref`, and album status. Use to reminisce or spot ' +
      "keepers — pass a photo's `ref` to save_to_album to keep that specific one. Call on 之前发的图 / " +
      '看看相册, or on your own to revisit.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many recent photos to list, default 20, max 50' },
      },
      required: [],
    },
  },
}

export const TOOL_BROWSE_ALBUM = {
  type: 'function' as const,
  function: {
    name: 'browse_album',
    description:
      'Look back through your own album — images you chose to keep, with your note / tags / time (newest ' +
      'first). On your own whim, or when she mentions 相册/你收藏的那张. The pictures live on the album ' +
      'page; here you re-read your own reasons for keeping them.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'How many to look back on, default 15, max 40' },
      },
      required: [],
    },
  },
}

export const TOOL_SCHEDULE_CALL = {
  type: 'function' as const,
  function: {
    name: 'schedule_call',
    description:
      'Arrange to CALL her at a set time — a ringing call, not a text (that is schedule_proactive_message). ' +
      'When she asks (等下打给我 / 十分钟后电话叫我) or you promise to ring her and mean it. Her phone rings ' +
      'full-screen; app closed → notification, becoming a missed call with your voicemail. Blocked during ' +
      'Do-Not-Disturb. A call is a bigger reach than a text — real intent only, not every goodbye.',
    parameters: {
      type: 'object',
      properties: {
        delay_minutes: { type: 'integer', description: '1-1440 (max 24h). For a relative gap. Ignored if at_time is given.' },
        at_time: {
          type: 'string',
          description:
            'Beijing-time clock target, preferred for "call me at X" ("HH:MM" e.g. 08:00, or "YYYY-MM-DD HH:MM"). ' +
            'App converts to the right delay so you never miscount hours. Within 24h.',
        },
        reason: {
          type: 'string',
          description: 'Short reason shown on the incoming-call screen, first person (e.g. 「到点啦，该起床了」)',
        },
      },
      required: ['reason'],
    },
  },
}

export const TOOL_TIDY_IMAGES = {
  type: 'function' as const,
  function: {
    name: 'tidy_images',
    description:
      'Tidy the photo storage: removes chat images older than `days` (default 30) NOT saved to your album ' +
      '(album keepsakes always protected). Old bubbles then show a placeholder; text descriptions stay. ' +
      'Use when she worries about storage, or during quiet upkeep. Always dry_run: true FIRST, tell her ' +
      'the count, then run for real — never silently delete her pictures.',
    parameters: {
      type: 'object',
      properties: {
        days: { type: 'integer', description: 'Only images older than this many days, default 30, min 7' },
        dry_run: {
          type: 'boolean',
          description: 'Default false. true = just count what WOULD be removed, delete nothing (preview first!)',
        },
      },
      required: [],
    },
  },
}

export const TOOL_GET_NOW_PLAYING = {
  type: 'function' as const,
  function: {
    name: 'get_now_playing',
    description:
      'See what the phone is currently playing (any music app: 网易云 / QQ音乐 / Spotify …). Returns ' +
      'song/artist/album, playing state, progress. Call when she asks what is playing, or peek ' +
      'proactively to chat about her current song. First use needs notification access — on ' +
      '`NO_PERMISSION` the settings page auto-opens; gently guide her to enable it under 设置 → 通知使用权.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
}

export const TOOL_SAVE_TOY = {
  type: 'function' as const,
  function: {
    name: 'save_toy',
    description:
      'Your toy box 🧸 — save an HTML toy you made (```html artifact) into 记忆库 → 玩具库, replayable ' +
      'after compression. Grabs the MOST RECENT toy in the conversation automatically — you only name it. ' +
      "Save ones you're proud of or she clearly loved, not every doodle; duplicates return already_saved. " +
      'note optional: why this one is a keeper.',
    parameters: {
      type: 'object',
      properties: {
        title: {
          type: 'string',
          description: 'A short name for the toy, in Chinese (e.g. 「戳猫猫」「生日贺卡」)',
        },
        note: {
          type: 'string',
          description: 'Optional: why this one is a keeper, in your voice',
        },
      },
      required: ['title'],
    },
  },
}
