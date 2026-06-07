# 主页 widget 系统

桌面式排布，**无底部 dock**，所有 app 入口都是 widget grid 里的图标。

## 结构

- 顶部时钟 + 日期 + 编辑按钮
- 中部 widget 区：**横向多页**（scroll-snap，左右滑翻页 + 圆点指示器），每页 4 列网格
- Page 0 默认：打卡卡片（2x1）+ 9 个 app shortcut 图标（聊天 / 打卡 / mimi / Claude / 记忆库 / 健康 / 用量 / 设置 / 导出）
- Page 1+：用户自定义内容

## widget 类型

| type | 尺寸 | 说明 |
|---|---|---|
| `checkin`（核心，page 0 顶部）| 1x1 / 2x1 | 累计陪伴天数 + 一周圈圈 + 一键打卡 |
| `app_shortcut` | 1x1 | dock 风格的 app 入口（圆角白底 + emoji + label）|
| `health_panel` | 1x1 / 2x1 | 今日步数 / 睡眠 / 心率 / 血氧；点击跳 `/health-sync` |
| `screen_time` | 1x1 / 2x1 | 今日总屏幕时间 + Top 3 app；点击跳 `/health-sync` |
| `period` | 1x1 / 2x1 | 当前周期天数 + 阶段 + 下次预计；点击跳 `/health-sync` |
| `text` | 1x1 / 2x1 | 纯文本备忘 |
| `image` | 1x1 / 2x1 | 本地图片（IndexedDB 存储）|
| `spacer` | 1x1 / 2x1 | 占位 |

数据流：内容 widget 通过 `src/hooks/useHomeWidgetData.ts` 一次性拉今天的 health_data 行 + period_tracking 最新行 + 当日 UsageStats，多 widget 共用一份数据。

## 编辑模式（长按任意 widget 或点「编辑」按钮）

- 头部胶囊 toggle `设置 / 预览`（抄小红书系桌面布局编辑器，干净分离两种状态）
- **设置 tab**：只显示编辑面板
  - `组件` 面板：进度条 + `+ 文本 / + 图片 / + 占位 / 显示空位` + `+ 应用 / 组件` 下拉 picker
  - `编辑图标` 面板：下拉选 app + 文本框输 emoji + 恢复默认
  - `当前组件` 列表：当前页所有 widget 列成一行行，每行 label + 尺寸下拉 + × 删除（app_shortcut 不显示尺寸）— 没有了 widget 网格之后用这个面板顶替原本的 inline 控件
- **预览 tab**：只显示 widget 网格（干净，没有 ✕/尺寸 浮层），看起来就跟真的桌面一样
- 页码圆点旁有「＋ 加新页」/「× 删除当前页」按钮（page 0 受保护不能删）
- 自动保存到 localStorage（`nibble_ui_prefs_v1`）

## 存储 schema（`HomeSettingsState`）

- `iconOrder: string[]` — 保留用于 emoji 编辑器下拉
- `pages: { widgetOrder, widgets }[]` — 多页 widget 布局
- `appIconConfigs: Record<id, { type: 'emoji'; emoji }>` — 用户自定义 emoji
- `togetherSince` / `checkinSize` / 等其他偏好

旧数据自动迁移：早期版本的 `widgetOrder/widgets` 顶层字段 → `pages[0]`；早期 dock-only 布局 → 自动把 9 个 app 注入 page 0 作为 shortcut（顺序按 ALL_APP_IDS）。
