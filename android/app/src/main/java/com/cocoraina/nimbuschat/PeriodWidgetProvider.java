package com.cocoraina.nimbuschat;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.widget.RemoteViews;
import java.util.Calendar;
import java.util.TimeZone;

/**
 * Home-screen widget for period tracking. Renders from data the web app
 * pushes into SharedPreferences via {@link PeriodWidgetPlugin}. The
 * day-of-cycle / phase / days-to-next are recomputed in Java on each
 * onUpdate so the widget stays correct across day rollovers even when the
 * app isn't running (refreshed on the updatePeriodMillis schedule).
 *
 * The date math mirrors computePeriodMetrics in
 * src/hooks/useHomeWidgetData.ts: dates are compared as UTC-midnight day
 * numbers (date-only) to avoid the timezone off-by-one that bit the JS side.
 */
public class PeriodWidgetProvider extends AppWidgetProvider {
    static final String PREFS = "NimbusPeriodWidget";
    private static final long ONE_DAY = 24L * 60 * 60 * 1000;

    static void updateAll(Context context) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(context);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(context, PeriodWidgetProvider.class));
        for (int id : ids) updateWidget(context, mgr, id);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) updateWidget(context, mgr, id);
    }

    // Parse 'yyyy-MM-dd' to a UTC-midnight epoch millis "day number".
    private static long dateNum(String s) {
        try {
            String[] p = s.split("-");
            Calendar c = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
            c.clear();
            c.set(Integer.parseInt(p[0]), Integer.parseInt(p[1]) - 1, Integer.parseInt(p[2]));
            return c.getTimeInMillis();
        } catch (Exception e) {
            return Long.MIN_VALUE;
        }
    }

    private static long todayNum() {
        Calendar local = Calendar.getInstance();
        Calendar c = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
        c.clear();
        c.set(local.get(Calendar.YEAR), local.get(Calendar.MONTH), local.get(Calendar.DAY_OF_MONTH));
        return c.getTimeInMillis();
    }

    static void updateWidget(Context context, AppWidgetManager mgr, int id) {
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_period);

        boolean hasData = prefs.getBoolean("hasData", false);
        String startDate = prefs.getString("startDate", "");
        String endDate = prefs.getString("endDate", "");
        int cycleLength = prefs.getInt("cycleLength", 28);

        if (!hasData || startDate.isEmpty() || dateNum(startDate) == Long.MIN_VALUE) {
            views.setTextViewText(R.id.widget_phase, "暂无记录");
            views.setTextViewText(R.id.widget_day, "打开 App 记录经期");
            views.setTextViewText(R.id.widget_next, "");
        } else {
            long startN = dateNum(startDate);
            long todayN = todayNum();
            int daysSinceStart = (int) Math.floor((double) (todayN - startN) / ONE_DAY);
            int cycleDay = daysSinceStart + 1;
            int daysToNext = cycleLength - daysSinceStart;

            boolean inPeriod;
            if (!endDate.isEmpty() && dateNum(endDate) != Long.MIN_VALUE) {
                inPeriod = todayN <= dateNum(endDate);
            } else {
                inPeriod = daysSinceStart >= 0 && daysSinceStart < 7;
            }

            String phase;
            if (inPeriod) phase = "经期中";
            else if (daysSinceStart < 12) phase = "滤泡期";
            else if (daysSinceStart <= 16) phase = "排卵期";
            else phase = "黄体期";

            views.setTextViewText(R.id.widget_phase, phase);
            views.setTextViewText(R.id.widget_day, "第 " + Math.max(1, cycleDay) + " 天");

            String nextLine;
            if (daysToNext > 0) nextLine = "距下次约 " + daysToNext + " 天";
            else if (daysToNext == 0) nextLine = "预计今天来潮";
            else nextLine = "已晚 " + (-daysToNext) + " 天";
            views.setTextViewText(R.id.widget_next, nextLine);
        }

        // Tap anywhere on the widget → open the app.
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent pi = PendingIntent.getActivity(context, 0, launch, flags);
            views.setOnClickPendingIntent(R.id.widget_root, pi);
        }

        mgr.updateAppWidget(id, views);
    }
}
