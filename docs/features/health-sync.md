# 健康同步（Health Connect → health_data）

> 让 Claude 知道你今天走了多少步、睡了多久、心率多少 —— 不靠手动告诉它，自动从手机健康数据里拉。
> 相关代码：`src/storage/healthSync.ts`、`src/pages/HealthSyncPage.tsx`、`android/.../UsageStatsPlugin.java`（屏幕时间另见）。

## 数据链路（华为示例）

```
华为手环 → 华为运动健康 → Health Sync（第三方桥接）→ Health Connect → Nimbus
```

Health Connect 是 Android 14+ 系统级（13- 需装 Google 的 Health Connect app）。任何能写入 Health Connect 的数据源（小米运动 / 苹果以外的可穿戴 / Samsung 健康）都行，华为通过 Health Sync 走这条桥。

前端用 `@capgo/capacitor-health` v8 plugin（仅 APK），声明的权限：steps / sleep / heartRate / restingHeartRate / distance / totalCalories / oxygenSaturation，全部 read-only，不会写回。

## 同步规则（`src/storage/healthSync.ts`）

- **步数走聚合 API**（`queryAggregated` sum + day bucket，锚定本地午夜）—— 日步数是「总和」，被 record limit 截断就会少算（均值类截断只是偏向近期、可接受，总和不行）。聚合一次返回每个日历日的精确总和，不分页翻几千条分钟级记录
- **心率 avg/min/max 也走聚合 API**（`queryAggregated` average/min/max，映射 Health Connect 的 BPM_AVG/MIN/MAX）—— `readSamples` 默认 limit=100 只覆盖最近几分钟，全天 min/max 会严重偏窄
- 其余几类走 `readSamples`，**每类 limit ≤ 500 = 恰好一页 = 一个请求**：睡眠 / 静息心率 / 血氧
- **串行 + 每个请求间隔 250~300ms**（不是并行！）—— Health Connect 的周期性速率限制是 QPS 式的，同时炸出去一串请求是最差情况；几个单页请求摊到 ~1.5s 就稳稳低于阈值。诊断工具单次单类型能读、同步炸，根因就是同步把多个请求挤在一起爆发
- 按本地日期聚合：
  - 步数 = 聚合 API 日总和
  - 睡眠 = 累加段时长 → 小时（按 endDate，跳过 awake/inBed）
  - 心率 = 聚合 API 全天 avg / max / min
  - 静息心率 = 当天最后一条
  - 血氧 = 算术均值，自动归一化（0.95 / 95 都视作 95%）
- 跳过空数据天 —— 避免覆盖之前已写入的值
- **payload 只塞非 null 字段**：Postgres `ON CONFLICT DO UPDATE` 只更新 payload 里出现的列；某次 Health Connect 只返回了步数没返回睡眠时，不会用 null 把之前已存的睡眠/心率覆盖掉
- **限速退避（指数式）**：遇到 Health Connect 限速（`rate limit`/`quota`/`throttle`/`429`）按**连续**次数退避——首次 60s，然后 2m、4m，封顶 5m；任意一次成功立刻清零（`nimbus_health_rate_limit_until_v1` + `..._count_v1`）。退避期内自动同步安静等待；手动 force 同步绕过退避并重置计数
- upsert 到 `health_data` 表，`ON CONFLICT (date)`

## 触发

- `App.tsx` 在 user mount + 每次进前台时调 `maybeAutoSyncHealth()`
- 内部 30 分钟节流，所以频繁切前后台不会拉爆
- 健康同步页有「立即同步」按钮强制 bypass 节流
- 没办法自动触发 Health Sync 本身（它是独立 app），用户每天得手动开一下 Health Sync

## 健康同步页（`/health-sync`）

- 顶卡：「立即同步」+ 上次同步时间 + 本次写入结果
- 中卡：「今天」预览（步数 / 睡眠 / 心率 / 静息 / 血氧）
- 折叠「🔧 诊断工具」：可用性检查、单独请求授权、按 type 读样本 + 列原始数据，用来调权限问题

## Android 配置

- **Manifest 权限**：`READ_STEPS / READ_SLEEP / READ_HEART_RATE / READ_RESTING_HEART_RATE / READ_DISTANCE / READ_TOTAL_CALORIES_BURNED / READ_OXYGEN_SATURATION`，加 `<queries>` 块让 Health Connect 能 deep-link 我们的隐私政策
- **minSdkVersion 26 (Android 8.0)**：Health Connect plugin 依赖 `androidx.health.connect:connect-client` 强制要求
