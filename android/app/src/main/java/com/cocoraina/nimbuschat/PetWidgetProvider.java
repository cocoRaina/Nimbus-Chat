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
import java.util.Calendar;

/**
 * Desktop pet widget — the "Clawd" crab. Sprite frames are extracted from
 * the clawd-tank Slack-emoji GIFs (MIT, © Marcio Granzotto; unofficial
 * Anthropic fan character — see THIRD_PARTY_NOTICES.md). Two ViewFlippers in
 * the layout auto-loop the idle vs sleeping animation; we just toggle which
 * is visible (awake by day, asleep at night) and set a mood line that
 * reflects the cycle phase. Shares the period data pushed via
 * {@link PeriodWidgetPlugin}.
 */
public class PetWidgetProvider extends AppWidgetProvider {

    static void updateAll(Context context) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(context);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(context, PetWidgetProvider.class));
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

    static void updateWidget(Context context, AppWidgetManager mgr, int id) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_pet);
        PeriodCalc.Result r = PeriodCalc.fromPrefs(context);
        boolean night = isNight();

        // Sprite: sleeping at night, idle-living by day.
        views.setViewVisibility(R.id.widget_pet_asleep, night ? View.VISIBLE : View.GONE);
        views.setViewVisibility(R.id.widget_pet_awake, night ? View.GONE : View.VISIBLE);

        // Mood line.
        String line;
        if (!r.hasData) {
            line = "戳我去设置经期吧~";
        } else if (night) {
            line = "夜深了，早点睡哦…";
        } else {
            switch (r.phase) {
                case "经期中": line = "今天要多喝热水哦"; break;
                case "滤泡期": line = "状态回来啦~"; break;
                case "排卵期": line = "元气满满！"; break;
                default:       line = "想被多关心一点…"; break; // 黄体期
            }
        }
        views.setTextViewText(R.id.widget_pet_line, line);

        // Tap → open the app.
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                flags |= PendingIntent.FLAG_IMMUTABLE;
            }
            PendingIntent pi = PendingIntent.getActivity(context, 1, launch, flags);
            views.setOnClickPendingIntent(R.id.widget_pet_root, pi);
        }

        mgr.updateAppWidget(id, views);
    }
}
