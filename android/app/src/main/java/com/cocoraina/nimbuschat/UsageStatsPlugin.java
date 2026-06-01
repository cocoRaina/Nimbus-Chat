package com.cocoraina.nimbuschat;

import android.app.AppOpsManager;
import android.app.usage.UsageStats;
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
import java.util.Calendar;
import java.util.List;
import org.json.JSONException;

/**
 * Bridges Android's UsageStatsManager (foreground time per app) to
 * the JS side. Requires PACKAGE_USAGE_STATS, which is an AppOps
 * permission the user must grant manually in
 * Settings → 应用使用情况 (Settings.ACTION_USAGE_ACCESS_SETTINGS).
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

        Calendar cal = Calendar.getInstance();
        cal.set(Calendar.HOUR_OF_DAY, 0);
        cal.set(Calendar.MINUTE, 0);
        cal.set(Calendar.SECOND, 0);
        cal.set(Calendar.MILLISECOND, 0);
        long start = cal.getTimeInMillis();
        long end = System.currentTimeMillis();

        // INTERVAL_DAILY: one bucket per app aggregated over the
        // requested window. Sufficient for "today's screen time".
        List<UsageStats> stats =
            manager.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, start, end);

        JSArray apps = new JSArray();
        PackageManager pm = getContext().getPackageManager();
        if (stats != null) {
            for (UsageStats s : stats) {
                long totalMs = s.getTotalTimeInForeground();
                if (totalMs <= 0) continue;
                long minutes = totalMs / 60000L;
                if (minutes <= 0) continue;
                String pkg = s.getPackageName();
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
