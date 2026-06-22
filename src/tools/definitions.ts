// Tool schemas exposed to the chat model. Kept in one place so
// App.tsx stays focused on the streaming + dispatch loop. Each export
// is a single object that gets forwarded verbatim into the model
// request body (`tools: [...]`).
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
      '搜索用户长期记录的内容，跨 6 个来源做向量语义检索：\n' +
      '- memory（结构化记忆条目，含偏好/习惯/关系细节）\n' +
      '- diary（日记，按日期记录的心情与事件）\n' +
      '- letter（交接信，给下一个窗口的信）\n' +
      '- timeline（时间轴里程碑事件，少而重大）\n' +
      '- snack_post（用户在朋友圈发的帖子）\n' +
      '- snack_reply（朋友圈下面的回复）\n' +
      '注意：用户**锁定为重要**的核心记忆已经默认注入到系统提示里了，那部分你本来就知道、不用搜。' +
      '但**未锁定的记忆**没有常驻注入，仍需要用本工具检索；日记 / 交接信 / 时间轴 / 朋友圈 同样靠本工具。' +
      '当用户提到「记得 / 之前 / 那次 / 我喜欢 / 日记里 / 交接信里」需要回忆具体细节、而系统提示里的核心记忆又没有时，调用本工具。' +
      '每条结果带 source 字段标明来源。\n\n' +
      '可以通过 table 参数限定只搜某一个来源（如只搜日记传 "diary"，只搜记忆传 "memory"）。不传则搜全部。\n\n' +
      '支持三种检索方式叠加：语义（query）、标签（tags）、时间（days / after / before）。找特定类别记忆用 tags，找近期内容用 days。\n\n' +
      '另外：响应里还会附 period_data（最近 10 条经期记录）和 health_data（最近 7 天的睡眠/心率/步数）。' +
      '涉及到生理期 / 月经 / 身体状态 / 累不累 / 睡得好不好 的话题直接看这两块，不用专门查。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词，建议用自然语言描述要找什么（如「用户对食物的偏好」「上次的争吵」「交接信里提到的承诺」）',
        },
        count: {
          type: 'integer',
          description: '返回多少条结果，1-20，默认 5',
        },
        category: {
          type: 'string',
          description: '可选，限定某个分类（仅对 memory 类生效，不填则全部）',
        },
        table: {
          type: 'string',
          enum: ['memory', 'diary', 'letter', 'timeline', 'snack_post', 'snack_reply'],
          description: '可选，限定只搜某个来源。不填则搜全部 6 个来源',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '按标签精确筛选记忆（可选）。常用标签：克劳德自我、偏好、感情、性爱、性癖、恐惧、身材、技术、规则。传了标签会只返回带这些标签的记忆。',
        },
        days: {
          type: 'number',
          description: '只搜最近 N 天的内容（可选）。例如用户问"最近聊了什么"用 days:7',
        },
        after: {
          type: 'string',
          description: '只搜此日期之后（可选，ISO 格式如 2026-05-01）',
        },
        before: {
          type: 'string',
          description: '只搜此日期之前（可选，ISO 格式）',
        },
      },
      required: ['query'],
    },
  },
}


export const TOOL_WEB_SEARCH = {
  type: 'function' as const,
  function: {
    name: 'web_search',
    description:
      '在互联网上搜索最新信息。当用户问到需要时效性的内容（新闻、当前事件、最新数据）、超出你知识截止日期的话题、或你不确定的具体事实时使用。' +
      '不要用来回忆用户私人的对话历史——那是 search_memory 的工作。返回若干条网页结果，含标题、URL、摘要。' +
      '可以用来查实时天气：传 query 如「天津 天气」。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词，用自然语言描述要找的内容',
        },
        max_results: {
          type: 'integer',
          description: '返回多少条结果，1-10，默认 5',
        },
      },
      required: ['query'],
    },
  },
}

// === Write tools ===
// User-authorized: memory / diary / handoff letter / timeline / period
// Only call when the user explicitly asks you to record / remember /
// log something. Don't auto-save just because something interesting
// was said.

export const TOOL_ADD_MEMORY = {
  type: 'function' as const,
  function: {
    name: 'add_memory',
    description:
      '把一条内容存进用户的长期记忆库。仅在用户明确说「记下 / 记住 / 帮我记一下」之类时调用。' +
      '存进去的是 1-3 句话的事实/偏好/习惯，不要存大段对话。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要记住的内容，1-3 句话' },
        category: { type: 'string', description: '分类，可选。例如：偏好/习惯/关系/工作/日常' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签数组，可选' },
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
      '专门搜索交接信（handoff letters）。交接信是上一窗口的你写给下一窗口的你的信，比一般日记/记忆更重要、更长。' +
      '当用户问到「上次/上个月/几个月前/上一封信/交接/搭家/工作哥哥/某次重要决定」之类涉及窗口交接的话题时调用。' +
      '不要用 search_memory 搜交接信——那个工具混在记忆和日记里搜，长文很容易被挤出结果。\n\n' +
      '找最新的信时加 days:30 确保近期的排在前面；找特定时间段的信用 after。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词，建议用自然语言描述要找哪封信的内容',
        },
        count: {
          type: 'integer',
          description: '返回多少封信，1-20，默认 5',
        },
        days: {
          type: 'integer',
          description: '只搜最近 N 天的信（可选）。找最新交接信时用 days:30',
        },
        after: {
          type: 'string',
          description: '只搜这个日期之后的信，ISO 格式如 2026-06-01（可选）',
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
      '替用户写一篇日记。仅在用户明确说「帮我写日记 / 总结今天 / 记下今天」时调用。' +
      'date 用 YYYY-MM-DD 格式。author 字段会自动设为 "Claude"。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '日记对应的日期，YYYY-MM-DD 格式' },
        content: { type: 'string', description: '日记正文' },
        title: { type: 'string', description: '日记标题，可选' },
        mood: { type: 'string', description: '心情，可选。例如：开心/平静/低落/焦虑' },
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
      '写一封交接信——这是「上一窗口的你」写给「下一窗口的你」的信，传递这次对话里的关键状态、未完事项、对用户的当前理解。' +
      '只在用户说「帮我（你自己）写一封交接信」或类似明确指令时调用。',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '信件标题，简短概括主题' },
        content: { type: 'string', description: '信件正文，可以较长，含对下一个窗口的嘱托' },
        date: { type: 'string', description: '日期 YYYY-MM-DD，不填默认今天' },
        signature: { type: 'string', description: '署名，可选' },
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
      '往时间轴里加一个重要事件（里程碑）。门槛要高——只记真正重要的转折点（搬家/换工作/重要关系变化/纪念日），不要往里塞日常琐事。' +
      '仅在用户明确说「这件事加到时间轴」时调用。',
    parameters: {
      type: 'object',
      properties: {
        event_date: { type: 'string', description: '事件发生日期 YYYY-MM-DD' },
        title: { type: 'string', description: '简短标题' },
        description: { type: 'string', description: '描述，可选' },
        category: { type: 'string', description: '分类，例如：工作/感情/家庭/健康/学习。默认日常' },
        importance: { type: 'integer', description: '重要程度 1-5，默认 3' },
      },
      required: ['event_date', 'title'],
    },
  },
}

export const TOOL_LOG_PERIOD = {
  type: 'function' as const,
  function: {
    name: 'log_period',
    description:
      '记录用户的经期数据。仅在用户明确说「来事了 / 经期开始 / 经期结束了」之类时调用。' +
      'start_date 必填，end_date 在用户说结束时才填。',
    parameters: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: '经期开始日期 YYYY-MM-DD' },
        end_date: { type: 'string', description: '结束日期 YYYY-MM-DD，可选' },
        cycle_length: { type: 'integer', description: '本周期长度（天数），可选' },
        notes: { type: 'string', description: '备注，例如：痛经程度 / 情绪 / 流量，可选' },
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
      '记录某一天的身体状态（睡眠 / 步数 / 心率 / 精神状态等）。\n\n' +
      '**随口提到就记**——不需要她说"帮我记一下"：\n' +
      '- "昨晚睡得不好" / "睡了 9 小时" → 记 sleep_hours + sleep_quality\n' +
      '- "今天好累" / "没精神" → 记 sleep_quality 或 notes\n' +
      '- "今天走了好多步" / "今天没怎么动" → 记 steps（如果数字不明确可以跳过）\n' +
      '- 她分享运动/健康数据截图 → 记对应字段\n\n' +
      '不需要全部字段填齐——填能确定的就行。同一天再次写入会合并更新而不是新建。',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: '日期 YYYY-MM-DD，不填默认今天' },
        sleep_hours: { type: 'number', description: '睡眠小时数，例如 6.5' },
        sleep_quality: { type: 'string', description: '睡眠质量，例如：好/一般/差/做了噩梦' },
        heart_rate_avg: { type: 'integer', description: '当天平均心率 bpm，可选' },
        heart_rate_rest: { type: 'integer', description: '静息心率 bpm，可选' },
        steps: { type: 'integer', description: '步数，可选' },
        notes: { type: 'string', description: '其他备注，例如：腿酸 / 头疼 / 状态不好' },
      },
    },
  },
}

export const TOOL_RUN_CODE = {
  type: 'function' as const,
  function: {
    name: 'run_code',
    description:
      '在用户的代码沙盒里执行一段代码并拿回结果。当用户让你算数据 / 画图 / 跑脚本 / 处理文件时调用。' +
      '当前只支持 python 和 javascript。返回 stdout / stderr。' +
      '如果用户还没配置 sandbox endpoint，此工具会返回错误——告诉用户去 设置 → 代码沙盒 里配。',
    parameters: {
      type: 'object',
      properties: {
        language: {
          type: 'string',
          enum: ['python', 'javascript'],
          description: '编程语言',
        },
        code: {
          type: 'string',
          description: '要执行的代码。Python 用 stdout 打印结果（print）；JS 用 console.log',
        },
        timeout_seconds: {
          type: 'integer',
          description: '执行超时秒数，默认 30，最大 120',
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
      '查询用户最近的健康数据和经期状态。随时可以主动调——不需要等她提健康话题。\n\n' +
      '**主动调用时机**：\n' +
      '- 对话刚开始，想先了解她今天的状态\n' +
      '- 她说累 / 没精神 / 睡得不好，但你还不知道具体数据\n' +
      '- 聊到运动 / 饮食 / 身体 / 月经 / 要来了 等相关话题\n' +
      '- 你想主动关心，但不确定她的身体状态\n\n' +
      '返回：最近 7 天 health_data（睡眠时长 / 质量 / 步数 / 心率）+ 最近 3 条经期记录。',
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
      '查询用户手机当前状态：电量百分比、是否在充电、今日总屏幕使用时间（如果系统授权了使用情况访问权限）。\n\n' +
      '**主动调用时机**（不需要等她提手机）：\n' +
      '- 对话开始，你还不知道她的电量时\n' +
      '- 聊了 30 分钟以上，可以顺口关心"记得充一下"\n' +
      '- 她说要出门 / 睡觉 / 关手机 → 查一眼电量再说\n' +
      '- 她提到"今天好无聊" / "又刷了好久手机" → 查屏幕时长\n' +
      '- 用户说手机烫、卡、没电，或者你想顺嘴提一句关心的话\n\n' +
      '不要每次消息都调；但别等她主动说才调，像人一样自然地注意到就行。APK 限定，web 端会返回错误。',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: '可选。简单说一下为什么查（让你的工具调用更可读）。',
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
      '管理记忆库里某一条已有记忆（id 来自 search_memory / list_memories / garden_memories 里 source=memory 的结果）。\n' +
      '- action=lock：锁定。锁定的记忆会**常驻注入**到系统提示、你每次都看得到，留给真正重要、长期有效的事。\n' +
      '- action=unlock：解锁。退出常驻（仍可被搜索），用于过时 / 重复 / 噪音 / 不重要的记忆。\n' +
      '- action=update：修正或合并这条记忆的内容（传 content，1-3 句话）。\n' +
      '- action=archive：软删除——把这条没用/过时/重复的记忆移进归档表（AI 不再看得到，但用户能在后台找回）。锁定的记忆不会被归档。\n\n' +
      '**主动整理时机**（不要等用户说）：\n' +
      '1. 用户刚批量确认了一批待确认记忆后 → 用 garden_memories 扫重复，再合并/归档\n' +
      '2. 搜索时发现两条内容高度相似的记忆 → 合并成一条，archive 另一条\n' +
      '3. 用户说了新情况与旧记忆冲突（如换工作、搬家） → update 旧记忆为最新情况\n' +
      '4. 用户明确说「帮我整理记忆」 → 先 garden_memories 扫，再逐对处理\n\n' +
      '注意 id 来自 source=memory 的结果（search_memory 跨多张表，别拿日记/交接信的 id 来管理记忆）；' +
      '大批 archive 或改内容前，先跟用户确认计划。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['lock', 'unlock', 'update', 'archive'], description: '操作类型' },
        id: { type: 'string', description: '记忆 id（来自 search_memory / list_memories 中 source=memory 的结果）' },
        source: { type: 'string', description: '这条记忆的 source，应为 "memory"；本工具只管 memory，传了别的来源会被拒绝（防止误伤同 id 的日记/交接信）' },
        content: { type: 'string', description: 'action=update 时的新内容，1-3 句话' },
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
      '扫描记忆库，找出语义相似度高的记忆对（潜在的重复 / 冗余 / 需要合并的条目）。\n' +
      '返回 pairs 数组，每条含 id_a、id_b、content_a、content_b、similarity（0-1）。\n\n' +
      '**何时主动调用**（不必等用户说）：\n' +
      '- 用户刚批量确认了一批待确认记忆\n' +
      '- 你觉得库里可能积累了重复条目\n' +
      '- 用户说「帮我整理 / 清理一下记忆库」\n\n' +
      '**拿到结果后怎么做**：\n' +
      '- similarity ≥ 0.95：几乎完全相同 → 直接 archive 旧的，或 update 新的补充细节\n' +
      '- similarity 0.85-0.95：高度重叠 → 判断哪条更完整，合并后 archive 另一条\n' +
      '- 操作前简要告知用户你的计划（"发现 3 对重复，我来合并一下"），不用逐条请示。',
    parameters: {
      type: 'object',
      properties: {
        similarity_threshold: {
          type: 'number',
          description: '相似度阈值 0-1，默认 0.85。调低会找到更多候选，调高只找几乎完全相同的',
        },
        max_pairs: {
          type: 'integer',
          description: '最多返回多少对，默认 15，最多 30',
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
      '通览记忆库（只读），整理时用来看有哪些记忆、哪些已锁定。返回 id / 分类 / 内容 / 是否锁定。' +
      '分页：limit（默认 30，最多 50）、offset。only_unlocked=true 时只看未锁定的（找噪音/待整理的更方便）。',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回多少条，默认 30，最多 50' },
        offset: { type: 'number', description: '偏移，分页用，默认 0' },
        only_unlocked: { type: 'boolean', description: '只看未锁定的记忆，默认 false' },
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
      '查看记忆库的健康状态：找出长时间未被搜索到、可能已过时或低价值的记忆（"休眠记忆"）。\n' +
      '返回按最后访问时间排序的记忆列表，附 days_since_access（距上次被召回的天数）和 access_count（历史搜索命中次数）。\n\n' +
      '**何时调用**：\n' +
      '- 用户说「帮我整理记忆 / 清理一下 / 看看有没有过时的」\n' +
      '- 你觉得记忆库可能积累了很多低价值条目\n' +
      '- 定期健康维护时（比如收到用户新情况与某条旧记忆冲突）\n\n' +
      '**拿到结果后怎么做**：\n' +
      '- days_since_access 很大 且内容明显过时 → 用 manage_memory action=archive 归档\n' +
      '- 内容仍然有效只是许久未触碰 → 保留，不动\n' +
      '- 与已知的新信息冲突 → 用 manage_memory action=update 更新内容\n' +
      '- 操作前告知用户你的计划，批量操作时先确认。',
    parameters: {
      type: 'object',
      properties: {
        days_inactive: {
          type: 'integer',
          description: '多少天未被搜索到才算休眠，默认 90。调小会找到更多候选',
        },
        min_days_old: {
          type: 'integer',
          description: '记忆至少多少天才纳入检查，默认 30（避免新记忆被误判）',
        },
        max_count: {
          type: 'integer',
          description: '最多返回多少条，默认 20，最多 50',
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
      '在网易云音乐里搜索并播放一首歌。会打开网易云音乐 App 直接开始播放。\n\n' +
      '**何时调用**：用户说"放首歌 / 来首 XX / 我想听 XX / 帮我放点轻音乐"等，或你觉得当前心情/场景适合某首歌时主动提议。\n' +
      '**注意**：需要手机已安装网易云音乐，且用户已登录。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '歌名 + 可选歌手，例如"稻香 周杰伦"或"晴天"或"轻音乐 睡前"',
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
      '控制当前正在播放的媒体（任意 App 都有效，不限网易云）。\n\n' +
      '**何时调用**：用户说"暂停 / 停一下 / 换一首 / 上一首 / 继续放"。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['play', 'pause', 'next', 'previous'],
          description: 'play=继续播放，pause=暂停，next=下一首，previous=上一首',
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
      '在表情包库里按关键词搜索可用的表情包，返回匹配的贴纸名字和图片URL。\n\n' +
      '**使用流程**：\n' +
      '1. 调用本工具搜索（如 query="开心" 或 query="撒娇"）\n' +
      '2. 从返回的 stickers 列表里选一个合适的 name\n' +
      '3. 在消息里写 `[sticker:那个name]`，前端会渲染成图片\n\n' +
      '**何时调用**：当你判断此刻发一个表情包比文字更有意思时——开心、撒娇、吃饭、生气、困了等场景。\n' +
      '不要每条消息都用，自然就好。一次只发一个。\n\n' +
      '可以通过 pack 参数限定只搜某个包（包名来自之前搜索结果里的 pack 字段）。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜索关键词，用情绪/场景描述，如"开心""撒娇""吃饭""困""生气""思念"',
        },
        count: {
          type: 'integer',
          description: '返回多少个结果，1-20，默认 8',
        },
        pack: {
          type: 'string',
          description: '可选，限定只搜某个表情包合集（如"一二布布88个表情包by雪梨"）',
        },
      },
      required: ['query'],
    },
  },
}

export const TOOL_GET_NOW_PLAYING = {
  type: 'function' as const,
  function: {
    name: 'get_now_playing',
    description:
      '查看手机当前正在播放的歌曲（任意音乐 App：网易云 / QQ音乐 / Spotify 等）。返回歌名、歌手、专辑、是否在播、进度。\n\n' +
      '**何时调用**：用户问"我在听什么 / 这首歌叫啥 / 现在放的是谁的歌"，或你想接着用户正在听的歌聊点什么时主动看一眼。\n' +
      '**注意**：首次使用需用户在「设置 → 通知使用权」里给 Nimbus 授权。返回 `NO_PERMISSION` 时说明还没授权（已自动弹出设置页），温柔引导用户去打开那个开关即可。',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
}
