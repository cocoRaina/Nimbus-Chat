package com.cocoraina.nimbuschat;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.widget.RemoteViews;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;

/**
 * Combined 2x1 widget: date + period info on the left, animated Clawd crab on
 * the right. One reusable 40-frame ViewFlipper — the provider fills its slots
 * with whichever state's frames apply (by time-of-day + cycle phase), so we
 * get smooth long animations without stacking a flipper per state.
 *
 * Mapping: night→sleeping, 经期中→going-away, 滤泡期→walking, 排卵期→happy,
 * 黄体期→idle, no-data→static rest. Sprite credit: THIRD_PARTY_NOTICES.md.
 */
public class ComboWidgetProvider extends AppWidgetProvider {

    private static final int[] IDLE = { R.drawable.crab_idle_0, R.drawable.crab_idle_1, R.drawable.crab_idle_2, R.drawable.crab_idle_3, R.drawable.crab_idle_4, R.drawable.crab_idle_5, R.drawable.crab_idle_6, R.drawable.crab_idle_7, R.drawable.crab_idle_8, R.drawable.crab_idle_9, R.drawable.crab_idle_10, R.drawable.crab_idle_11, R.drawable.crab_idle_12, R.drawable.crab_idle_13, R.drawable.crab_idle_14, R.drawable.crab_idle_15, R.drawable.crab_idle_16, R.drawable.crab_idle_17, R.drawable.crab_idle_18, R.drawable.crab_idle_19, R.drawable.crab_idle_20, R.drawable.crab_idle_21, R.drawable.crab_idle_22, R.drawable.crab_idle_23, R.drawable.crab_idle_24, R.drawable.crab_idle_25, R.drawable.crab_idle_26, R.drawable.crab_idle_27, R.drawable.crab_idle_28, R.drawable.crab_idle_29, R.drawable.crab_idle_30, R.drawable.crab_idle_31, R.drawable.crab_idle_32, R.drawable.crab_idle_33, R.drawable.crab_idle_34, R.drawable.crab_idle_35, R.drawable.crab_idle_36, R.drawable.crab_idle_37, R.drawable.crab_idle_38, R.drawable.crab_idle_39 };
    private static final int[] HAPPY = { R.drawable.crab_happy_0, R.drawable.crab_happy_1, R.drawable.crab_happy_2, R.drawable.crab_happy_3, R.drawable.crab_happy_4, R.drawable.crab_happy_5, R.drawable.crab_happy_6, R.drawable.crab_happy_7, R.drawable.crab_happy_8, R.drawable.crab_happy_9, R.drawable.crab_happy_10, R.drawable.crab_happy_11, R.drawable.crab_happy_12, R.drawable.crab_happy_13, R.drawable.crab_happy_14, R.drawable.crab_happy_15, R.drawable.crab_happy_16, R.drawable.crab_happy_17, R.drawable.crab_happy_18, R.drawable.crab_happy_19, R.drawable.crab_happy_20, R.drawable.crab_happy_21, R.drawable.crab_happy_22, R.drawable.crab_happy_23, R.drawable.crab_happy_24, R.drawable.crab_happy_25, R.drawable.crab_happy_26, R.drawable.crab_happy_27, R.drawable.crab_happy_28, R.drawable.crab_happy_29, R.drawable.crab_happy_30, R.drawable.crab_happy_31, R.drawable.crab_happy_32, R.drawable.crab_happy_33, R.drawable.crab_happy_34, R.drawable.crab_happy_35, R.drawable.crab_happy_36, R.drawable.crab_happy_37, R.drawable.crab_happy_38, R.drawable.crab_happy_39 };
    private static final int[] SLEEP = { R.drawable.crab_sleep_0, R.drawable.crab_sleep_1, R.drawable.crab_sleep_2, R.drawable.crab_sleep_3, R.drawable.crab_sleep_4, R.drawable.crab_sleep_5, R.drawable.crab_sleep_6, R.drawable.crab_sleep_7, R.drawable.crab_sleep_8, R.drawable.crab_sleep_9, R.drawable.crab_sleep_10, R.drawable.crab_sleep_11, R.drawable.crab_sleep_12, R.drawable.crab_sleep_13, R.drawable.crab_sleep_14, R.drawable.crab_sleep_15, R.drawable.crab_sleep_16, R.drawable.crab_sleep_17, R.drawable.crab_sleep_18, R.drawable.crab_sleep_19, R.drawable.crab_sleep_20, R.drawable.crab_sleep_21, R.drawable.crab_sleep_22, R.drawable.crab_sleep_23, R.drawable.crab_sleep_24, R.drawable.crab_sleep_25, R.drawable.crab_sleep_26, R.drawable.crab_sleep_27, R.drawable.crab_sleep_28, R.drawable.crab_sleep_29, R.drawable.crab_sleep_30, R.drawable.crab_sleep_31, R.drawable.crab_sleep_32, R.drawable.crab_sleep_33, R.drawable.crab_sleep_34, R.drawable.crab_sleep_35, R.drawable.crab_sleep_36, R.drawable.crab_sleep_37, R.drawable.crab_sleep_38, R.drawable.crab_sleep_39 };
    private static final int[] AWAY = { R.drawable.crab_away_0, R.drawable.crab_away_1, R.drawable.crab_away_2, R.drawable.crab_away_3, R.drawable.crab_away_4, R.drawable.crab_away_5, R.drawable.crab_away_6, R.drawable.crab_away_7, R.drawable.crab_away_8, R.drawable.crab_away_9, R.drawable.crab_away_10, R.drawable.crab_away_11, R.drawable.crab_away_12, R.drawable.crab_away_13, R.drawable.crab_away_14, R.drawable.crab_away_15, R.drawable.crab_away_16, R.drawable.crab_away_17, R.drawable.crab_away_18, R.drawable.crab_away_19, R.drawable.crab_away_20, R.drawable.crab_away_21, R.drawable.crab_away_22, R.drawable.crab_away_23, R.drawable.crab_away_24, R.drawable.crab_away_25, R.drawable.crab_away_26, R.drawable.crab_away_27, R.drawable.crab_away_28, R.drawable.crab_away_29, R.drawable.crab_away_30, R.drawable.crab_away_31, R.drawable.crab_away_32, R.drawable.crab_away_33, R.drawable.crab_away_34, R.drawable.crab_away_35, R.drawable.crab_away_36, R.drawable.crab_away_37, R.drawable.crab_away_38, R.drawable.crab_away_39 };
    private static final int[] WALK = { R.drawable.crab_walk_0, R.drawable.crab_walk_1, R.drawable.crab_walk_2, R.drawable.crab_walk_3, R.drawable.crab_walk_4, R.drawable.crab_walk_5, R.drawable.crab_walk_6, R.drawable.crab_walk_7, R.drawable.crab_walk_8, R.drawable.crab_walk_9, R.drawable.crab_walk_10, R.drawable.crab_walk_11, R.drawable.crab_walk_12, R.drawable.crab_walk_13, R.drawable.crab_walk_14, R.drawable.crab_walk_15, R.drawable.crab_walk_16, R.drawable.crab_walk_17, R.drawable.crab_walk_18, R.drawable.crab_walk_19, R.drawable.crab_walk_20, R.drawable.crab_walk_21, R.drawable.crab_walk_22, R.drawable.crab_walk_23, R.drawable.crab_walk_24, R.drawable.crab_walk_25, R.drawable.crab_walk_26, R.drawable.crab_walk_27, R.drawable.crab_walk_28, R.drawable.crab_walk_29, R.drawable.crab_walk_30, R.drawable.crab_walk_31, R.drawable.crab_walk_32, R.drawable.crab_walk_33, R.drawable.crab_walk_34, R.drawable.crab_walk_35, R.drawable.crab_walk_36, R.drawable.crab_walk_37, R.drawable.crab_walk_38, R.drawable.crab_walk_39 };

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

        String date = new SimpleDateFormat("M月d日 EEE", Locale.CHINA).format(new Date());
        views.setTextViewText(R.id.combo_date, date);

        if (!r.hasData) {
            views.setTextViewText(R.id.combo_phase, "🩸 未记录");
            views.setTextViewText(R.id.combo_detail, "打开 App 记录经期");
        } else {
            views.setTextViewText(R.id.combo_phase, "🩸 " + r.phase);
            views.setTextViewText(R.id.combo_detail, "第 " + r.cycleDay + " 天 · " + nextText(r.daysToNext));
        }

        // Choose which state's frames to load. Night overrides phase. No data /
        // unknown → static rest pose (same frame in every slot).
        int[] frames;
        if (night) {
            frames = SLEEP;
        } else if (r.hasData && "经期中".equals(r.phase)) {
            frames = AWAY;
        } else if (r.hasData && "滤泡期".equals(r.phase)) {
            frames = WALK;
        } else if (r.hasData && "排卵期".equals(r.phase)) {
            frames = HAPPY;
        } else if (r.hasData && "黄体期".equals(r.phase)) {
            frames = IDLE;
        } else {
            frames = null; // no data → static rest
        }

        if (frames == null) {
            views.setImageViewResource(R.id.combo_f_0, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_1, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_2, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_3, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_4, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_5, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_6, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_7, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_8, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_9, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_10, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_11, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_12, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_13, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_14, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_15, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_16, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_17, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_18, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_19, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_20, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_21, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_22, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_23, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_24, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_25, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_26, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_27, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_28, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_29, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_30, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_31, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_32, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_33, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_34, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_35, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_36, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_37, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_38, R.drawable.crab_rest_0);
            views.setImageViewResource(R.id.combo_f_39, R.drawable.crab_rest_0);
        } else {
            views.setImageViewResource(R.id.combo_f_0, frames[0]);
            views.setImageViewResource(R.id.combo_f_1, frames[1]);
            views.setImageViewResource(R.id.combo_f_2, frames[2]);
            views.setImageViewResource(R.id.combo_f_3, frames[3]);
            views.setImageViewResource(R.id.combo_f_4, frames[4]);
            views.setImageViewResource(R.id.combo_f_5, frames[5]);
            views.setImageViewResource(R.id.combo_f_6, frames[6]);
            views.setImageViewResource(R.id.combo_f_7, frames[7]);
            views.setImageViewResource(R.id.combo_f_8, frames[8]);
            views.setImageViewResource(R.id.combo_f_9, frames[9]);
            views.setImageViewResource(R.id.combo_f_10, frames[10]);
            views.setImageViewResource(R.id.combo_f_11, frames[11]);
            views.setImageViewResource(R.id.combo_f_12, frames[12]);
            views.setImageViewResource(R.id.combo_f_13, frames[13]);
            views.setImageViewResource(R.id.combo_f_14, frames[14]);
            views.setImageViewResource(R.id.combo_f_15, frames[15]);
            views.setImageViewResource(R.id.combo_f_16, frames[16]);
            views.setImageViewResource(R.id.combo_f_17, frames[17]);
            views.setImageViewResource(R.id.combo_f_18, frames[18]);
            views.setImageViewResource(R.id.combo_f_19, frames[19]);
            views.setImageViewResource(R.id.combo_f_20, frames[20]);
            views.setImageViewResource(R.id.combo_f_21, frames[21]);
            views.setImageViewResource(R.id.combo_f_22, frames[22]);
            views.setImageViewResource(R.id.combo_f_23, frames[23]);
            views.setImageViewResource(R.id.combo_f_24, frames[24]);
            views.setImageViewResource(R.id.combo_f_25, frames[25]);
            views.setImageViewResource(R.id.combo_f_26, frames[26]);
            views.setImageViewResource(R.id.combo_f_27, frames[27]);
            views.setImageViewResource(R.id.combo_f_28, frames[28]);
            views.setImageViewResource(R.id.combo_f_29, frames[29]);
            views.setImageViewResource(R.id.combo_f_30, frames[30]);
            views.setImageViewResource(R.id.combo_f_31, frames[31]);
            views.setImageViewResource(R.id.combo_f_32, frames[32]);
            views.setImageViewResource(R.id.combo_f_33, frames[33]);
            views.setImageViewResource(R.id.combo_f_34, frames[34]);
            views.setImageViewResource(R.id.combo_f_35, frames[35]);
            views.setImageViewResource(R.id.combo_f_36, frames[36]);
            views.setImageViewResource(R.id.combo_f_37, frames[37]);
            views.setImageViewResource(R.id.combo_f_38, frames[38]);
            views.setImageViewResource(R.id.combo_f_39, frames[39]);
        }

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
