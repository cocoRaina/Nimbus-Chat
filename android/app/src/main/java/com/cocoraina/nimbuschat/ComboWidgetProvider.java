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
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;
import java.util.Random;

/**
 * Combined 2x1 widget: date + period info (left, tap → open app) and the
 * animated Clawd crab (right, tap → react with a random animation). A single
 * 20-slot ViewFlipper is filled with whichever state's frames apply:
 *   - default: by time-of-day + cycle phase (night→sleep, 经期中→away,
 *     滤泡期→walk, 排卵期→happy, 黄体期→idle, no-data→rest)
 *   - after a tap on the crab: a random pick from all 24 animations, until the
 *     next periodic refresh reverts to the phase default.
 * Frames are compile-time R.drawable refs (shrink-safe); credit in
 * THIRD_PARTY_NOTICES.md.
 */
public class ComboWidgetProvider extends AppWidgetProvider {

    private static final String ACTION_POKE = "com.cocoraina.nimbuschat.POKE_CRAB";
    private static final int[] WALK = { R.drawable.crab_walk_0, R.drawable.crab_walk_1, R.drawable.crab_walk_2, R.drawable.crab_walk_3, R.drawable.crab_walk_4, R.drawable.crab_walk_5, R.drawable.crab_walk_6, R.drawable.crab_walk_7, R.drawable.crab_walk_8, R.drawable.crab_walk_9, R.drawable.crab_walk_10, R.drawable.crab_walk_11, R.drawable.crab_walk_12, R.drawable.crab_walk_13, R.drawable.crab_walk_14, R.drawable.crab_walk_15, R.drawable.crab_walk_16, R.drawable.crab_walk_17, R.drawable.crab_walk_18, R.drawable.crab_walk_19 };
    private static final int[] DISCONNECTED = { R.drawable.crab_disconnected_0, R.drawable.crab_disconnected_1, R.drawable.crab_disconnected_2, R.drawable.crab_disconnected_3, R.drawable.crab_disconnected_4, R.drawable.crab_disconnected_5, R.drawable.crab_disconnected_6, R.drawable.crab_disconnected_7, R.drawable.crab_disconnected_8, R.drawable.crab_disconnected_9, R.drawable.crab_disconnected_10, R.drawable.crab_disconnected_11, R.drawable.crab_disconnected_12, R.drawable.crab_disconnected_13, R.drawable.crab_disconnected_14, R.drawable.crab_disconnected_15, R.drawable.crab_disconnected_16, R.drawable.crab_disconnected_17, R.drawable.crab_disconnected_18, R.drawable.crab_disconnected_19 };
    private static final int[] DIZZY = { R.drawable.crab_dizzy_0, R.drawable.crab_dizzy_1, R.drawable.crab_dizzy_2, R.drawable.crab_dizzy_3, R.drawable.crab_dizzy_4, R.drawable.crab_dizzy_5, R.drawable.crab_dizzy_6, R.drawable.crab_dizzy_7, R.drawable.crab_dizzy_8, R.drawable.crab_dizzy_9, R.drawable.crab_dizzy_10, R.drawable.crab_dizzy_11, R.drawable.crab_dizzy_12, R.drawable.crab_dizzy_13, R.drawable.crab_dizzy_14, R.drawable.crab_dizzy_15, R.drawable.crab_dizzy_16, R.drawable.crab_dizzy_17, R.drawable.crab_dizzy_18, R.drawable.crab_dizzy_19 };
    private static final int[] AWAY = { R.drawable.crab_away_0, R.drawable.crab_away_1, R.drawable.crab_away_2, R.drawable.crab_away_3, R.drawable.crab_away_4, R.drawable.crab_away_5, R.drawable.crab_away_6, R.drawable.crab_away_7, R.drawable.crab_away_8, R.drawable.crab_away_9, R.drawable.crab_away_10, R.drawable.crab_away_11, R.drawable.crab_away_12, R.drawable.crab_away_13, R.drawable.crab_away_14, R.drawable.crab_away_15, R.drawable.crab_away_16, R.drawable.crab_away_17, R.drawable.crab_away_18, R.drawable.crab_away_19 };
    private static final int[] HAPPY = { R.drawable.crab_happy_0, R.drawable.crab_happy_1, R.drawable.crab_happy_2, R.drawable.crab_happy_3, R.drawable.crab_happy_4, R.drawable.crab_happy_5, R.drawable.crab_happy_6, R.drawable.crab_happy_7, R.drawable.crab_happy_8, R.drawable.crab_happy_9, R.drawable.crab_happy_10, R.drawable.crab_happy_11, R.drawable.crab_happy_12, R.drawable.crab_happy_13, R.drawable.crab_happy_14, R.drawable.crab_happy_15, R.drawable.crab_happy_16, R.drawable.crab_happy_17, R.drawable.crab_happy_18, R.drawable.crab_happy_19 };
    private static final int[] IDLE = { R.drawable.crab_idle_0, R.drawable.crab_idle_1, R.drawable.crab_idle_2, R.drawable.crab_idle_3, R.drawable.crab_idle_4, R.drawable.crab_idle_5, R.drawable.crab_idle_6, R.drawable.crab_idle_7, R.drawable.crab_idle_8, R.drawable.crab_idle_9, R.drawable.crab_idle_10, R.drawable.crab_idle_11, R.drawable.crab_idle_12, R.drawable.crab_idle_13, R.drawable.crab_idle_14, R.drawable.crab_idle_15, R.drawable.crab_idle_16, R.drawable.crab_idle_17, R.drawable.crab_idle_18, R.drawable.crab_idle_19 };
    private static final int[] MINICLAWD = { R.drawable.crab_miniclawd_0, R.drawable.crab_miniclawd_1, R.drawable.crab_miniclawd_2, R.drawable.crab_miniclawd_3, R.drawable.crab_miniclawd_4, R.drawable.crab_miniclawd_5, R.drawable.crab_miniclawd_6, R.drawable.crab_miniclawd_7, R.drawable.crab_miniclawd_8, R.drawable.crab_miniclawd_9, R.drawable.crab_miniclawd_10, R.drawable.crab_miniclawd_11, R.drawable.crab_miniclawd_12, R.drawable.crab_miniclawd_13, R.drawable.crab_miniclawd_14, R.drawable.crab_miniclawd_15, R.drawable.crab_miniclawd_16, R.drawable.crab_miniclawd_17, R.drawable.crab_miniclawd_18, R.drawable.crab_miniclawd_19 };
    private static final int[] NOTIF = { R.drawable.crab_notif_0, R.drawable.crab_notif_1, R.drawable.crab_notif_2, R.drawable.crab_notif_3, R.drawable.crab_notif_4, R.drawable.crab_notif_5, R.drawable.crab_notif_6, R.drawable.crab_notif_7, R.drawable.crab_notif_8, R.drawable.crab_notif_9, R.drawable.crab_notif_10, R.drawable.crab_notif_11, R.drawable.crab_notif_12, R.drawable.crab_notif_13, R.drawable.crab_notif_14, R.drawable.crab_notif_15, R.drawable.crab_notif_16, R.drawable.crab_notif_17, R.drawable.crab_notif_18, R.drawable.crab_notif_19 };
    private static final int[] SLEEP = { R.drawable.crab_sleep_0, R.drawable.crab_sleep_1, R.drawable.crab_sleep_2, R.drawable.crab_sleep_3, R.drawable.crab_sleep_4, R.drawable.crab_sleep_5, R.drawable.crab_sleep_6, R.drawable.crab_sleep_7, R.drawable.crab_sleep_8, R.drawable.crab_sleep_9, R.drawable.crab_sleep_10, R.drawable.crab_sleep_11, R.drawable.crab_sleep_12, R.drawable.crab_sleep_13, R.drawable.crab_sleep_14, R.drawable.crab_sleep_15, R.drawable.crab_sleep_16, R.drawable.crab_sleep_17, R.drawable.crab_sleep_18, R.drawable.crab_sleep_19 };
    private static final int[] REST = { R.drawable.crab_rest_0, R.drawable.crab_rest_1, R.drawable.crab_rest_2, R.drawable.crab_rest_3, R.drawable.crab_rest_4, R.drawable.crab_rest_5, R.drawable.crab_rest_6, R.drawable.crab_rest_7, R.drawable.crab_rest_8, R.drawable.crab_rest_9, R.drawable.crab_rest_10, R.drawable.crab_rest_11, R.drawable.crab_rest_12, R.drawable.crab_rest_13, R.drawable.crab_rest_14, R.drawable.crab_rest_15, R.drawable.crab_rest_16, R.drawable.crab_rest_17, R.drawable.crab_rest_18, R.drawable.crab_rest_19 };
    private static final int[] BEACON = { R.drawable.crab_beacon_0, R.drawable.crab_beacon_1, R.drawable.crab_beacon_2, R.drawable.crab_beacon_3, R.drawable.crab_beacon_4, R.drawable.crab_beacon_5, R.drawable.crab_beacon_6, R.drawable.crab_beacon_7, R.drawable.crab_beacon_8, R.drawable.crab_beacon_9, R.drawable.crab_beacon_10, R.drawable.crab_beacon_11, R.drawable.crab_beacon_12, R.drawable.crab_beacon_13, R.drawable.crab_beacon_14, R.drawable.crab_beacon_15, R.drawable.crab_beacon_16, R.drawable.crab_beacon_17, R.drawable.crab_beacon_18, R.drawable.crab_beacon_19 };
    private static final int[] BUILDING = { R.drawable.crab_building_0, R.drawable.crab_building_1, R.drawable.crab_building_2, R.drawable.crab_building_3, R.drawable.crab_building_4, R.drawable.crab_building_5, R.drawable.crab_building_6, R.drawable.crab_building_7, R.drawable.crab_building_8, R.drawable.crab_building_9, R.drawable.crab_building_10, R.drawable.crab_building_11, R.drawable.crab_building_12, R.drawable.crab_building_13, R.drawable.crab_building_14, R.drawable.crab_building_15, R.drawable.crab_building_16, R.drawable.crab_building_17, R.drawable.crab_building_18, R.drawable.crab_building_19 };
    private static final int[] CARRYING = { R.drawable.crab_carrying_0, R.drawable.crab_carrying_1, R.drawable.crab_carrying_2, R.drawable.crab_carrying_3, R.drawable.crab_carrying_4, R.drawable.crab_carrying_5, R.drawable.crab_carrying_6, R.drawable.crab_carrying_7, R.drawable.crab_carrying_8, R.drawable.crab_carrying_9, R.drawable.crab_carrying_10, R.drawable.crab_carrying_11, R.drawable.crab_carrying_12, R.drawable.crab_carrying_13, R.drawable.crab_carrying_14, R.drawable.crab_carrying_15, R.drawable.crab_carrying_16, R.drawable.crab_carrying_17, R.drawable.crab_carrying_18, R.drawable.crab_carrying_19 };
    private static final int[] CONDUCTING = { R.drawable.crab_conducting_0, R.drawable.crab_conducting_1, R.drawable.crab_conducting_2, R.drawable.crab_conducting_3, R.drawable.crab_conducting_4, R.drawable.crab_conducting_5, R.drawable.crab_conducting_6, R.drawable.crab_conducting_7, R.drawable.crab_conducting_8, R.drawable.crab_conducting_9, R.drawable.crab_conducting_10, R.drawable.crab_conducting_11, R.drawable.crab_conducting_12, R.drawable.crab_conducting_13, R.drawable.crab_conducting_14, R.drawable.crab_conducting_15, R.drawable.crab_conducting_16, R.drawable.crab_conducting_17, R.drawable.crab_conducting_18, R.drawable.crab_conducting_19 };
    private static final int[] CONFUSED = { R.drawable.crab_confused_0, R.drawable.crab_confused_1, R.drawable.crab_confused_2, R.drawable.crab_confused_3, R.drawable.crab_confused_4, R.drawable.crab_confused_5, R.drawable.crab_confused_6, R.drawable.crab_confused_7, R.drawable.crab_confused_8, R.drawable.crab_confused_9, R.drawable.crab_confused_10, R.drawable.crab_confused_11, R.drawable.crab_confused_12, R.drawable.crab_confused_13, R.drawable.crab_confused_14, R.drawable.crab_confused_15, R.drawable.crab_confused_16, R.drawable.crab_confused_17, R.drawable.crab_confused_18, R.drawable.crab_confused_19 };
    private static final int[] DEBUGGER = { R.drawable.crab_debugger_0, R.drawable.crab_debugger_1, R.drawable.crab_debugger_2, R.drawable.crab_debugger_3, R.drawable.crab_debugger_4, R.drawable.crab_debugger_5, R.drawable.crab_debugger_6, R.drawable.crab_debugger_7, R.drawable.crab_debugger_8, R.drawable.crab_debugger_9, R.drawable.crab_debugger_10, R.drawable.crab_debugger_11, R.drawable.crab_debugger_12, R.drawable.crab_debugger_13, R.drawable.crab_debugger_14, R.drawable.crab_debugger_15, R.drawable.crab_debugger_16, R.drawable.crab_debugger_17, R.drawable.crab_debugger_18, R.drawable.crab_debugger_19 };
    private static final int[] JUGGLING = { R.drawable.crab_juggling_0, R.drawable.crab_juggling_1, R.drawable.crab_juggling_2, R.drawable.crab_juggling_3, R.drawable.crab_juggling_4, R.drawable.crab_juggling_5, R.drawable.crab_juggling_6, R.drawable.crab_juggling_7, R.drawable.crab_juggling_8, R.drawable.crab_juggling_9, R.drawable.crab_juggling_10, R.drawable.crab_juggling_11, R.drawable.crab_juggling_12, R.drawable.crab_juggling_13, R.drawable.crab_juggling_14, R.drawable.crab_juggling_15, R.drawable.crab_juggling_16, R.drawable.crab_juggling_17, R.drawable.crab_juggling_18, R.drawable.crab_juggling_19 };
    private static final int[] OVERHEATED = { R.drawable.crab_overheated_0, R.drawable.crab_overheated_1, R.drawable.crab_overheated_2, R.drawable.crab_overheated_3, R.drawable.crab_overheated_4, R.drawable.crab_overheated_5, R.drawable.crab_overheated_6, R.drawable.crab_overheated_7, R.drawable.crab_overheated_8, R.drawable.crab_overheated_9, R.drawable.crab_overheated_10, R.drawable.crab_overheated_11, R.drawable.crab_overheated_12, R.drawable.crab_overheated_13, R.drawable.crab_overheated_14, R.drawable.crab_overheated_15, R.drawable.crab_overheated_16, R.drawable.crab_overheated_17, R.drawable.crab_overheated_18, R.drawable.crab_overheated_19 };
    private static final int[] PUSHING = { R.drawable.crab_pushing_0, R.drawable.crab_pushing_1, R.drawable.crab_pushing_2, R.drawable.crab_pushing_3, R.drawable.crab_pushing_4, R.drawable.crab_pushing_5, R.drawable.crab_pushing_6, R.drawable.crab_pushing_7, R.drawable.crab_pushing_8, R.drawable.crab_pushing_9, R.drawable.crab_pushing_10, R.drawable.crab_pushing_11, R.drawable.crab_pushing_12, R.drawable.crab_pushing_13, R.drawable.crab_pushing_14, R.drawable.crab_pushing_15, R.drawable.crab_pushing_16, R.drawable.crab_pushing_17, R.drawable.crab_pushing_18, R.drawable.crab_pushing_19 };
    private static final int[] SWEEPING = { R.drawable.crab_sweeping_0, R.drawable.crab_sweeping_1, R.drawable.crab_sweeping_2, R.drawable.crab_sweeping_3, R.drawable.crab_sweeping_4, R.drawable.crab_sweeping_5, R.drawable.crab_sweeping_6, R.drawable.crab_sweeping_7, R.drawable.crab_sweeping_8, R.drawable.crab_sweeping_9, R.drawable.crab_sweeping_10, R.drawable.crab_sweeping_11, R.drawable.crab_sweeping_12, R.drawable.crab_sweeping_13, R.drawable.crab_sweeping_14, R.drawable.crab_sweeping_15, R.drawable.crab_sweeping_16, R.drawable.crab_sweeping_17, R.drawable.crab_sweeping_18, R.drawable.crab_sweeping_19 };
    private static final int[] THINKING = { R.drawable.crab_thinking_0, R.drawable.crab_thinking_1, R.drawable.crab_thinking_2, R.drawable.crab_thinking_3, R.drawable.crab_thinking_4, R.drawable.crab_thinking_5, R.drawable.crab_thinking_6, R.drawable.crab_thinking_7, R.drawable.crab_thinking_8, R.drawable.crab_thinking_9, R.drawable.crab_thinking_10, R.drawable.crab_thinking_11, R.drawable.crab_thinking_12, R.drawable.crab_thinking_13, R.drawable.crab_thinking_14, R.drawable.crab_thinking_15, R.drawable.crab_thinking_16, R.drawable.crab_thinking_17, R.drawable.crab_thinking_18, R.drawable.crab_thinking_19 };
    private static final int[] TYPING = { R.drawable.crab_typing_0, R.drawable.crab_typing_1, R.drawable.crab_typing_2, R.drawable.crab_typing_3, R.drawable.crab_typing_4, R.drawable.crab_typing_5, R.drawable.crab_typing_6, R.drawable.crab_typing_7, R.drawable.crab_typing_8, R.drawable.crab_typing_9, R.drawable.crab_typing_10, R.drawable.crab_typing_11, R.drawable.crab_typing_12, R.drawable.crab_typing_13, R.drawable.crab_typing_14, R.drawable.crab_typing_15, R.drawable.crab_typing_16, R.drawable.crab_typing_17, R.drawable.crab_typing_18, R.drawable.crab_typing_19 };
    private static final int[] WIZARD = { R.drawable.crab_wizard_0, R.drawable.crab_wizard_1, R.drawable.crab_wizard_2, R.drawable.crab_wizard_3, R.drawable.crab_wizard_4, R.drawable.crab_wizard_5, R.drawable.crab_wizard_6, R.drawable.crab_wizard_7, R.drawable.crab_wizard_8, R.drawable.crab_wizard_9, R.drawable.crab_wizard_10, R.drawable.crab_wizard_11, R.drawable.crab_wizard_12, R.drawable.crab_wizard_13, R.drawable.crab_wizard_14, R.drawable.crab_wizard_15, R.drawable.crab_wizard_16, R.drawable.crab_wizard_17, R.drawable.crab_wizard_18, R.drawable.crab_wizard_19 };
    private static final int[] MINITYPING = { R.drawable.crab_minityping_0, R.drawable.crab_minityping_1, R.drawable.crab_minityping_2, R.drawable.crab_minityping_3, R.drawable.crab_minityping_4, R.drawable.crab_minityping_5, R.drawable.crab_minityping_6, R.drawable.crab_minityping_7, R.drawable.crab_minityping_8, R.drawable.crab_minityping_9, R.drawable.crab_minityping_10, R.drawable.crab_minityping_11, R.drawable.crab_minityping_12, R.drawable.crab_minityping_13, R.drawable.crab_minityping_14, R.drawable.crab_minityping_15, R.drawable.crab_minityping_16, R.drawable.crab_minityping_17, R.drawable.crab_minityping_18, R.drawable.crab_minityping_19 };
    private static final int[][] ALL = { WALK, DISCONNECTED, DIZZY, AWAY, HAPPY, IDLE, MINICLAWD, NOTIF, SLEEP, REST, BEACON, BUILDING, CARRYING, CONDUCTING, CONFUSED, DEBUGGER, JUGGLING, OVERHEATED, PUSHING, SWEEPING, THINKING, TYPING, WIZARD, MINITYPING };

    static void updateAll(Context context) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(context);
        int[] ids = mgr.getAppWidgetIds(new ComponentName(context, ComboWidgetProvider.class));
        for (int id : ids) updateWidget(context, mgr, id);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (ACTION_POKE.equals(intent.getAction())) {
            int idx = new Random().nextInt(ALL.length);
            context.getSharedPreferences(PeriodCalc.PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean("poke_active", true).putInt("poke_idx", idx).apply();
            updateAll(context);
        }
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] ids) {
        // Periodic / initial refresh reverts any poke back to the phase default.
        context.getSharedPreferences(PeriodCalc.PREFS, Context.MODE_PRIVATE)
            .edit().putBoolean("poke_active", false).apply();
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

    private static int[] phaseFrames(PeriodCalc.Result r, boolean night) {
        if (night) return SLEEP;
        if (!r.hasData) return REST;
        switch (r.phase) {
            case "经期中": return AWAY;
            case "滤泡期": return WALK;
            case "排卵期": return HAPPY;
            case "黄体期": return IDLE;
            default: return IDLE;
        }
    }

    static void updateWidget(Context context, AppWidgetManager mgr, int id) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_combo);
        SharedPreferences prefs = context.getSharedPreferences(PeriodCalc.PREFS, Context.MODE_PRIVATE);
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

        int[] frames;
        if (prefs.getBoolean("poke_active", false)) {
            int idx = prefs.getInt("poke_idx", 0);
            if (idx < 0 || idx >= ALL.length) idx = 0;
            frames = ALL[idx];
        } else {
            frames = phaseFrames(r, night);
        }
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

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;

        // Left side → open the app.
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            views.setOnClickPendingIntent(R.id.combo_left,
                PendingIntent.getActivity(context, 2, launch, flags));
        }
        // Tap the crab → poke (random animation).
        Intent poke = new Intent(context, ComboWidgetProvider.class).setAction(ACTION_POKE);
        views.setOnClickPendingIntent(R.id.combo_flipper,
            PendingIntent.getBroadcast(context, 10, poke, flags));

        mgr.updateAppWidget(id, views);
    }
}
