package com.cocoraina.nimbuschat;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.widget.RemoteViews;

/**
 * Home-screen widget for period tracking. Renders from data the web app
 * pushes into SharedPreferences via {@link PeriodWidgetPlugin}; the
 * phase / day / days-to-next are recomputed by {@link PeriodCalc} on each
 * onUpdate so the widget stays correct across day rollovers even when the
 * app isn't running (refreshed on the updatePeriodMillis schedule).
 */
public class PeriodWidgetProvider extends AppWidgetProvider {

    static void updateAll(Context context) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(context);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(context, PeriodWidgetProvider.class));
        for (int id : ids) updateWidget(context, mgr, id);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) updateWidget(context, mgr, id);
    }

    static void updateWidget(Context context, AppWidgetManager mgr, int id) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_period);
        PeriodCalc.Result r = PeriodCalc.fromPrefs(context);

        if (!r.hasData) {
            views.setTextViewText(R.id.widget_phase, "暂无记录");
            views.setTextViewText(R.id.widget_day, "打开 App 记录经期");
            views.setTextViewText(R.id.widget_next, "");
        } else {
            views.setTextViewText(R.id.widget_phase, r.phase);
            views.setTextViewText(R.id.widget_day, "第 " + r.cycleDay + " 天");
            String nextLine;
            if (r.daysToNext > 0) nextLine = "距下次约 " + r.daysToNext + " 天";
            else if (r.daysToNext == 0) nextLine = "预计今天来潮";
            else nextLine = "已晚 " + (-r.daysToNext) + " 天";
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
