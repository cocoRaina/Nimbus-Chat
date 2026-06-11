package com.cocoraina.nimbuschat;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.view.View;
import android.widget.RemoteViews;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;

/**
 * Combined 2x1 widget: date + period info on the left, animated Clawd crab on
 * the right. The crab swaps between four states (idle / happy / sleeping /
 * resting) by time-of-day and cycle phase — each is a ViewFlipper (or single
 * image for the static rest pose) and we just toggle which is visible.
 * Shares the period data pushed via {@link PeriodWidgetPlugin}; sprite credit
 * in THIRD_PARTY_NOTICES.md.
 */
public class ComboWidgetProvider extends AppWidgetProvider {

    static void updateAll(Context context) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(context);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(context, ComboWidgetProvider.class));
        for (int id : ids) updateWidget(context, mgr, id);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) updateWidget(context, mgr, id);
    }

    private static boolean isNight() {
        int hour = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
        return hour >= 22 || hour < 6;
    }

    private static String nextText(int daysToNext) {
        if (daysToNext > 0) return "距下次约 " + daysToNext + " 天";
        if (daysToNext == 0) return "预计今天来潮";
        return "已晚 " + (-daysToNext) + " 天";
    }

    static void updateWidget(Context context, AppWidgetManager mgr, int id) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_combo);
        PeriodCalc.Result r = PeriodCalc.fromPrefs(context);
        boolean night = isNight();

        // Date line, e.g. "6月11日 周三".
        String date = new SimpleDateFormat("M月d日 EEE", Locale.CHINA).format(new Date());
        views.setTextViewText(R.id.combo_date, date);

        if (!r.hasData) {
            views.setTextViewText(R.id.combo_phase, "🩸 未记录");
            views.setTextViewText(R.id.combo_detail, "打开 App 记录经期");
        } else {
            views.setTextViewText(R.id.combo_phase, "🩸 " + r.phase);
            views.setTextViewText(R.id.combo_detail, "第 " + r.cycleDay + " 天 · " + nextText(r.daysToNext));
        }

        // Pick crab state. Default = idle; night overrides everything.
        int show; // 0 idle, 1 happy, 2 sleep, 3 rest
        if (night) {
            show = 2;
        } else if (r.hasData && "排卵期".equals(r.phase)) {
            show = 1;
        } else if (r.hasData && "经期中".equals(r.phase)) {
            show = 3;
        } else {
            show = 0;
        }
        views.setViewVisibility(R.id.combo_idle, show == 0 ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.combo_happy, show == 1 ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.combo_sleep, show == 2 ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.combo_rest, show == 3 ? View.VISIBLE : View.GONE);

        // Tap → open the app.
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent pi = PendingIntent.getActivity(context, 2, launch, flags);
            views.setOnClickPendingIntent(R.id.widget_combo_root, pi);
        }

        mgr.updateAppWidget(id, views);
    }
}
