# 屏幕使用时间（UsageStats）

> 今日各 app 前台时长 + 总屏幕时间。给 Claude（`get_device_state` 工具）、首页 `screen_time` widget、健康同步页的「📱 屏幕时间」用。仅 APK。
> 相关代码：`android/app/src/main/java/com/cocoraina/nimbuschat/UsageStatsPlugin.java`（原生）、`src/storage/usageStatsNative.ts`（JS 桥）。

## 权限

- 需要 `PACKAGE_USAGE_STATS`，这是个 **AppOps 特殊权限**，用户得自己去 **系统设置 → 使用情况访问权限 → Nimbus** 手动打开（`Settings.ACTION_USAGE_ACCESS_SETTINGS`）。
- `hasPermission()` 在没授权时返回 false；`requestPermission()` 打开系统页让用户授权。
- Manifest 加 `QUERY_ALL_PACKAGES`，否则 Android 11+ 的 package visibility 限制会让 `getApplicationLabel` 拿不到别的 app 名字（会显示成 `com.tencent.mm` 而不是「微信」）。

## 怎么算（`UsageStatsPlugin.getDailyUsage`）

用 `queryEvents()` **自己配对** `MOVE_TO_FOREGROUND` / `MOVE_TO_BACKGROUND` 事件，而**不是** `queryUsageStats(INTERVAL_DAILY)`：
- 后者的「日 bucket」通常按 **UTC 午夜**对齐，返回的整桶会把昨天的一部分(UTC+8 下约 6 小时)算进「今天」→ 屏幕时间偏高约 6 小时。
- `queryEvents` 是事件流级精确，没有 bucket 溢出。

窗口：**本地午夜 → 现在**。每个包维护 `[累计前台 ms, 当前未配对的 FG 时间戳]`。

### 三条收尾规则（缺一就会虚高，都踩过坑）

1. **`MOVE_TO_BACKGROUND`**：正常配对，关闭该包的计时。
2. **设备级事件**：`SCREEN_NON_INTERACTIVE(16)` / `KEYGUARD_SHOWN(17)` / `DEVICE_SHUTDOWN(26)` —— 息屏/锁屏/关机时，安卓**不保证**给当前 app 发 `MOVE_TO_BACKGROUND`。遇到这些事件就把**所有**还开着的计时在那一刻收尾，否则锁屏前开的那个 app 会把整夜挂机都算成使用。这些事件包名常为 null，所以在 `pkg == null` 跳过**之前**处理。用整数字面量(16/17/26)因为常量不是每个 SDK 都有。
3. **新 app 进前台**：同一时刻只有一个前台 app，所以某 app `MOVE_TO_FOREGROUND` 时，把**其它所有**还开着的计时在该时刻收尾 —— 防快速切换 / 某些 OEM 锁屏时旧 app 的 `BACKGROUND` 事件丢失。
4. 循环结束后，仍开着的(就是此刻真正在前台的 app)按 `end`(现在)收尾。

## 总时长 = 所有 app 之和

`usageStatsNative.ts` 的 `readDailyUsage()` 把每个包的 `total_minutes` **加总**当作「总屏幕时间」。⚠️ 所以**任何一个 app 被多算，总数就虚高** —— 排查"总数比系统高很多"时，先看是不是某个 app(桌面 launcher / systemui / 输入法)被算进去或区间重叠重复计了。

## 展示

- 首页 `screen_time` widget(1x1/2x1):总时长 + Top 3 app；点击跳 `/health-sync`。
- 健康同步页「📱 屏幕时间」section：带授权引导按钮。
- `get_device_state` 工具：电量 / 是否充电 / 今日总屏幕时长 / Top 5 app。
