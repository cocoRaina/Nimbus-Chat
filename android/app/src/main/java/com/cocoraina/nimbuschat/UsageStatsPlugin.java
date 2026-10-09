package com.cocoraina.nimbuschat;

import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Process;
import android.provider.Settings;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import android.app.usage.UsageStats;
import java.util.Calendar;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Bridges Android's UsageStatsManager (foreground time per app) to
 * the JS side. Requires PACKAGE_USAGE_STATS, which is an AppOps
 * permission the user must grant manually in
 * Settings → 应用使用情况 (Settings.ACTION_USAGE_ACCESS_SETTINGS).
 *
 * Implementation note: we use queryEvents() and pair MOVE_TO_FOREGROUND /
 * MOVE_TO_BACKGROUND events ourselves rather than queryUsageStats(
 * INTERVAL_DAILY, ...). The "bucket" path is what bit us before — daily
 * buckets are typically aligned to UTC midnight on Android, and
 * queryUsageStats returns whole buckets that overlap the requested
 * range, attributing the bucket's full total via
 * getTotalTimeInForeground(). On UTC+8 that meant a chunk of yesterday's
 * usage (08:00 Beijing → 23:59 Beijing yesterday) was being added to
 * "today", which read as the screen-time number being off by ~6 hours.
 * queryEvents is event-stream-precise: no bucket overflow.
 */
@CapacitorPlugin(name = "UsageStats")
public class UsageStatsPlugin extends Plugin {

    @PluginMethod
    public void hasPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", isUsageAccessGranted());
        call.resolve(ret);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to open usage access settings: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getDailyUsage(PluginCall call) {
        if (!isUsageAccessGranted()) {
            call.reject("Permission not granted");
            return;
        }

        UsageStatsManager manager =
            (UsageStatsManager) getContext().getSystemService(Context.USAGE_STATS_SERVICE);
        if (manager == null) {
            call.reject("UsageStatsManager unavailable");
            return;
        }

        // Local midnight → now, in the device's default timezone.
        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.HOUR_OF_DAY, 0);
        cal.set(Calendar.MINUTE, 0);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        final long start = cal.getTimeInMillis();
        final long end = System.currentTimeMillis();

        // Per-package accumulators:
        //   totalMs  = sum of foreground intervals (clipped to [start, end])
        //   openAt   = timestamp of the unmatched MOVE_TO_FOREGROUND, or 0
        //              when nothing is currently open for this package
        Map<String, long[]> stats = new HashMap<>();

        UsageEvents events = manager.queryEvents(start, end);
        UsageEvents.Event event = new UsageEvents.Event();
        while (events != null && events.hasNextEvent()) {
            events.getNextEvent(event);
            int type = event.getEventType();
            long ts = event.getTimeStamp();

            // Device-level events that end the current foreground session
            // WITHOUT a per-app MOVE_TO_BACKGROUND: screen turned off / lock
            // screen shown / device shutdown. Android does NOT guarantee a
            // per-app PAUSED event when the screen locks, so without this the
            // app that was open at lock time keeps accumulating — all the
            // idle/locked time (e.g. overnight) gets counted as foreground
            // usage, which reads as "screen time is way too high". These
            // events often carry a null/"android" package, so handle them
            // BEFORE the per-app pkg null-check below. Integer literals
            // because the named constants don't exist on every SDK level:
            //   16 = SCREEN_NON_INTERACTIVE, 17 = KEYGUARD_SHOWN, 26 = DEVICE_SHUTDOWN
            if (type == 16 || type == 17 || type == 26) {
                long cutoff = Math.min(ts, end);
                for (long[] row : stats.values()) {
                    if (row[1] != 0L && cutoff > row[1]) {
                        row[0] += cutoff - row[1];
                    }
                    row[1] = 0L;
                }
                continue;
            }

            String pkg = event.getPackageName();
            if (pkg == null) continue;

            // ACTIVITY_RESUMED == MOVE_TO_FOREGROUND on modern Android;
            // ACTIVITY_PAUSED  == MOVE_TO_BACKGROUND. Use the integer
            // constants because some SDK levels rename them. 1 = FG, 2 = BG.
            if (type == UsageEvents.Event.MOVE_TO_FOREGROUND) {
                // Only ONE app is in the foreground at a time, so a new app
                // resuming means every OTHER open interval has already ended,
                // even if that app's MOVE_TO_BACKGROUND was never delivered
                // (common on fast app switches, and on some OEMs when the
                // screen locks). Close them here at this timestamp so a
                // dropped BG event can't let one app keep accumulating time
                // that actually belonged to whatever the user switched to.
                long cutoff = Math.min(ts, end);
                for (Map.Entry<String, long[]> other : stats.entrySet()) {
                    if (other.getKey().equals(pkg)) continue;
                    long[] r = other.getValue();
                    if (r[1] != 0L && cutoff > r[1]) {
                        r[0] += cutoff - r[1];
                    }
                    r[1] = 0L;
                }
                long[] row = stats.get(pkg);
                if (row == null) {
                    row = new long[]{0L, 0L};
                    stats.put(pkg, row);
                }
                if (row[1] == 0L) {
                    row[1] = Math.max(ts, start);
                }
            } else if (type == UsageEvents.Event.MOVE_TO_BACKGROUND) {
                long[] row = stats.get(pkg);
                if (row == null || row[1] == 0L) continue;
                long openAt = row[1];
                long closedAt = Math.min(ts, end);
                if (closedAt > openAt) {
                    row[0] += closedAt - openAt;
                }
                row[1] = 0L;
            }
        }

        // Any app still in the foreground when we ran the query — close
        // its open interval at `end` (i.e. now).
        for (long[] row : stats.values()) {
            if (row[1] != 0L && end > row[1]) {
                row[0] += end - row[1];
                row[1] = 0L;
            }
        }

        // ── HarmonyOS NEXT compatibility fallback ──
        // On some OEMs (notably HarmonyOS NEXT), queryEvents() may not emit
        // FG/BG events for every app, and device-level screen-off events
        // (type 16/17) may be absent — causing the Launcher to accumulate
        // all idle time while real apps go unreported.
        //
        // Mitigation: also query the daily usage-stats buckets and merge
        // them in. The bucket approach has a known UTC-alignment issue
        // (~6h bleed from yesterday on UTC+8), but it catches apps that
        // events missed entirely. For apps present in BOTH sources we
        // trust the event-based number (more precise); for apps ONLY in
        // the bucket source we take the bucket number (better than zero).
        // We also cap the Launcher's event-based time: if it exceeds the
        // sum of all OTHER apps by more than 30 min, it's likely inflated
        // by missing screen-off events, so we replace it with the bucket
        // value (which tends to be more reasonable on HarmonyOS).
        List<UsageStats> dailyStats = manager.queryUsageStats(
                UsageStatsManager.INTERVAL_DAILY, start, end);
        if (dailyStats != null) {
            Map<String, Long> bucketMs = new HashMap<>();
            for (UsageStats us : dailyStats) {
                long ft = us.getTotalTimeInForeground();
                if (ft <= 0) continue;
                String p = us.getPackageName();
                if (p == null) continue;
                Long prev = bucketMs.get(p);
                bucketMs.put(p, prev != null ? Math.max(prev, ft) : ft);
            }

            // Merge: add apps that events missed entirely
            for (Map.Entry<String, Long> be : bucketMs.entrySet()) {
                String p = be.getKey();
                long bucketVal = be.getValue();
                long[] eventRow = stats.get(p);
                if (eventRow == null || eventRow[0] <= 0) {
                    // App only in bucket source — use bucket value
                    stats.put(p, new long[]{bucketVal, 0L});
                }
            }

            // Cap inflated Launcher: if its event-based time is > sum of
            // all others + 30 min, replace with bucket value
            String launcherPkg = null;
            for (String p : stats.keySet()) {
                if (p.contains("launcher") || p.contains("home")) {
                    launcherPkg = p;
                    break;
                }
            }
            if (launcherPkg != null) {
                long[] launcherRow = stats.get(launcherPkg);
                if (launcherRow != null && launcherRow[0] > 0) {
                    long othersTotal = 0;
                    for (Map.Entry<String, long[]> e2 : stats.entrySet()) {
                        if (!e2.getKey().equals(launcherPkg)) {
                            othersTotal += e2.getValue()[0];
                        }
                    }
                    if (launcherRow[0] > othersTotal + 30 * 60000L) {
                        Long bucketLauncher = bucketMs.get(launcherPkg);
                        if (bucketLauncher != null) {
                            launcherRow[0] = bucketLauncher;
                        } else {
                            // No bucket data either — zero it out
                            launcherRow[0] = 0;
                        }
                    }
                }
            }
        }

        JSArray apps = new JSArray();
        PackageManager pm = getContext().getPackageManager();
        for (Map.Entry<String, long[]> entry : stats.entrySet()) {
            long totalMs = entry.getValue()[0];
            if (totalMs <= 0) continue;
            long minutes = totalMs / 60000L;
            if (minutes <= 0) continue;
            String pkg = entry.getKey();
            String label;
            try {
                ApplicationInfo ai = pm.getApplicationInfo(pkg, 0);
                label = pm.getApplicationLabel(ai).toString();
            } catch (PackageManager.NameNotFoundException e) {
                label = pkg;
            }
            JSObject row = new JSObject();
            try {
                row.put("package_name", pkg);
                row.put("app_name", label);
                row.put("total_minutes", minutes);
            } catch (Exception ignored) {
            }
            apps.put(row);
        }

        JSObject ret = new JSObject();
        try {
            ret.put("apps", apps);
        } catch (Exception ignored) {
        }
        call.resolve(ret);
    }

    private boolean isUsageAccessGranted() {
        Context ctx = getContext();
        AppOpsManager ops = (AppOpsManager) ctx.getSystemService(Context.APP_OPS_SERVICE);
        if (ops == null) return false;
        int mode;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            mode = ops.unsafeCheckOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                ctx.getPackageName());
        } else {
            mode = ops.checkOpNoThrow(
                AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(),
                ctx.getPackageName());
        }
        return mode == AppOpsManager.MODE_ALLOWED;
    }
}
