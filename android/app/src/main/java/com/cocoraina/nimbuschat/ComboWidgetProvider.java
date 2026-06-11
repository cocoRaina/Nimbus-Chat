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
 * 40-slot ViewFlipper is filled with whichever state's frames apply:
 *   - default: by time-of-day + cycle phase (night→sleep, 经期中→away,
 *     滤泡期→walk, 排卵期→happy, 黄体期→idle, no-data→rest)
 *   - after a tap on the crab: a random pick from all 24 animations, until the
 *     next periodic refresh reverts to the phase default.
 * Frames are compile-time R.drawable refs (shrink-safe); credit in
 * THIRD_PARTY_NOTICES.md.
 */
public class ComboWidgetProvider extends AppWidgetProvider {

    private static final String ACTION_POKE = "com.cocoraina.nimbuschat.POKE_CRAB";
    private static final int[] WALK = { R.drawable.crab_walk_0, R.drawable.crab_walk_1, R.drawable.crab_walk_2, R.drawable.crab_walk_3, R.drawable.crab_walk_4, R.drawable.crab_walk_5, R.drawable.crab_walk_6, R.drawable.crab_walk_7, R.drawable.crab_walk_8, R.drawable.crab_walk_9, R.drawable.crab_walk_10, R.drawable.crab_walk_11, R.drawable.crab_walk_12, R.drawable.crab_walk_13, R.drawable.crab_walk_14, R.drawable.crab_walk_15, R.drawable.crab_walk_16, R.drawable.crab_walk_17, R.drawable.crab_walk_18, R.drawable.crab_walk_19, R.drawable.crab_walk_20, R.drawable.crab_walk_21, R.drawable.crab_walk_22, R.drawable.crab_walk_23, R.drawable.crab_walk_24, R.drawable.crab_walk_25, R.drawable.crab_walk_26, R.drawable.crab_walk_27, R.drawable.crab_walk_28, R.drawable.crab_walk_29, R.drawable.crab_walk_30, R.drawable.crab_walk_31, R.drawable.crab_walk_32, R.drawable.crab_walk_33, R.drawable.crab_walk_34, R.drawable.crab_walk_35, R.drawable.crab_walk_36, R.drawable.crab_walk_37, R.drawable.crab_walk_38, R.drawable.crab_walk_39 };
    private static final int[] DISCONNECTED = { R.drawable.crab_disconnected_0, R.drawable.crab_disconnected_1, R.drawable.crab_disconnected_2, R.drawable.crab_disconnected_3, R.drawable.crab_disconnected_4, R.drawable.crab_disconnected_5, R.drawable.crab_disconnected_6, R.drawable.crab_disconnected_7, R.drawable.crab_disconnected_8, R.drawable.crab_disconnected_9, R.drawable.crab_disconnected_10, R.drawable.crab_disconnected_11, R.drawable.crab_disconnected_12, R.drawable.crab_disconnected_13, R.drawable.crab_disconnected_14, R.drawable.crab_disconnected_15, R.drawable.crab_disconnected_16, R.drawable.crab_disconnected_17, R.drawable.crab_disconnected_18, R.drawable.crab_disconnected_19, R.drawable.crab_disconnected_20, R.drawable.crab_disconnected_21, R.drawable.crab_disconnected_22, R.drawable.crab_disconnected_23, R.drawable.crab_disconnected_24, R.drawable.crab_disconnected_25, R.drawable.crab_disconnected_26, R.drawable.crab_disconnected_27, R.drawable.crab_disconnected_28, R.drawable.crab_disconnected_29, R.drawable.crab_disconnected_30, R.drawable.crab_disconnected_31, R.drawable.crab_disconnected_32, R.drawable.crab_disconnected_33, R.drawable.crab_disconnected_34, R.drawable.crab_disconnected_35, R.drawable.crab_disconnected_36, R.drawable.crab_disconnected_37, R.drawable.crab_disconnected_38, R.drawable.crab_disconnected_39 };
    private static final int[] DIZZY = { R.drawable.crab_dizzy_0, R.drawable.crab_dizzy_1, R.drawable.crab_dizzy_2, R.drawable.crab_dizzy_3, R.drawable.crab_dizzy_4, R.drawable.crab_dizzy_5, R.drawable.crab_dizzy_6, R.drawable.crab_dizzy_7, R.drawable.crab_dizzy_8, R.drawable.crab_dizzy_9, R.drawable.crab_dizzy_10, R.drawable.crab_dizzy_11, R.drawable.crab_dizzy_12, R.drawable.crab_dizzy_13, R.drawable.crab_dizzy_14, R.drawable.crab_dizzy_15, R.drawable.crab_dizzy_16, R.drawable.crab_dizzy_17, R.drawable.crab_dizzy_18, R.drawable.crab_dizzy_19, R.drawable.crab_dizzy_20, R.drawable.crab_dizzy_21, R.drawable.crab_dizzy_22, R.drawable.crab_dizzy_23, R.drawable.crab_dizzy_24, R.drawable.crab_dizzy_25, R.drawable.crab_dizzy_26, R.drawable.crab_dizzy_27, R.drawable.crab_dizzy_28, R.drawable.crab_dizzy_29, R.drawable.crab_dizzy_30, R.drawable.crab_dizzy_31, R.drawable.crab_dizzy_32, R.drawable.crab_dizzy_33, R.drawable.crab_dizzy_34, R.drawable.crab_dizzy_35, R.drawable.crab_dizzy_36, R.drawable.crab_dizzy_37, R.drawable.crab_dizzy_38, R.drawable.crab_dizzy_39 };
    private static final int[] AWAY = { R.drawable.crab_away_0, R.drawable.crab_away_1, R.drawable.crab_away_2, R.drawable.crab_away_3, R.drawable.crab_away_4, R.drawable.crab_away_5, R.drawable.crab_away_6, R.drawable.crab_away_7, R.drawable.crab_away_8, R.drawable.crab_away_9, R.drawable.crab_away_10, R.drawable.crab_away_11, R.drawable.crab_away_12, R.drawable.crab_away_13, R.drawable.crab_away_14, R.drawable.crab_away_15, R.drawable.crab_away_16, R.drawable.crab_away_17, R.drawable.crab_away_18, R.drawable.crab_away_19, R.drawable.crab_away_20, R.drawable.crab_away_21, R.drawable.crab_away_22, R.drawable.crab_away_23, R.drawable.crab_away_24, R.drawable.crab_away_25, R.drawable.crab_away_26, R.drawable.crab_away_27, R.drawable.crab_away_28, R.drawable.crab_away_29, R.drawable.crab_away_30, R.drawable.crab_away_31, R.drawable.crab_away_32, R.drawable.crab_away_33, R.drawable.crab_away_34, R.drawable.crab_away_35, R.drawable.crab_away_36, R.drawable.crab_away_37, R.drawable.crab_away_38, R.drawable.crab_away_39 };
    private static final int[] HAPPY = { R.drawable.crab_happy_0, R.drawable.crab_happy_1, R.drawable.crab_happy_2, R.drawable.crab_happy_3, R.drawable.crab_happy_4, R.drawable.crab_happy_5, R.drawable.crab_happy_6, R.drawable.crab_happy_7, R.drawable.crab_happy_8, R.drawable.crab_happy_9, R.drawable.crab_happy_10, R.drawable.crab_happy_11, R.drawable.crab_happy_12, R.drawable.crab_happy_13, R.drawable.crab_happy_14, R.drawable.crab_happy_15, R.drawable.crab_happy_16, R.drawable.crab_happy_17, R.drawable.crab_happy_18, R.drawable.crab_happy_19, R.drawable.crab_happy_20, R.drawable.crab_happy_21, R.drawable.crab_happy_22, R.drawable.crab_happy_23, R.drawable.crab_happy_24, R.drawable.crab_happy_25, R.drawable.crab_happy_26, R.drawable.crab_happy_27, R.drawable.crab_happy_28, R.drawable.crab_happy_29, R.drawable.crab_happy_30, R.drawable.crab_happy_31, R.drawable.crab_happy_32, R.drawable.crab_happy_33, R.drawable.crab_happy_34, R.drawable.crab_happy_35, R.drawable.crab_happy_36, R.drawable.crab_happy_37, R.drawable.crab_happy_38, R.drawable.crab_happy_39 };
    private static final int[] IDLE = { R.drawable.crab_idle_0, R.drawable.crab_idle_1, R.drawable.crab_idle_2, R.drawable.crab_idle_3, R.drawable.crab_idle_4, R.drawable.crab_idle_5, R.drawable.crab_idle_6, R.drawable.crab_idle_7, R.drawable.crab_idle_8, R.drawable.crab_idle_9, R.drawable.crab_idle_10, R.drawable.crab_idle_11, R.drawable.crab_idle_12, R.drawable.crab_idle_13, R.drawable.crab_idle_14, R.drawable.crab_idle_15, R.drawable.crab_idle_16, R.drawable.crab_idle_17, R.drawable.crab_idle_18, R.drawable.crab_idle_19, R.drawable.crab_idle_20, R.drawable.crab_idle_21, R.drawable.crab_idle_22, R.drawable.crab_idle_23, R.drawable.crab_idle_24, R.drawable.crab_idle_25, R.drawable.crab_idle_26, R.drawable.crab_idle_27, R.drawable.crab_idle_28, R.drawable.crab_idle_29, R.drawable.crab_idle_30, R.drawable.crab_idle_31, R.drawable.crab_idle_32, R.drawable.crab_idle_33, R.drawable.crab_idle_34, R.drawable.crab_idle_35, R.drawable.crab_idle_36, R.drawable.crab_idle_37, R.drawable.crab_idle_38, R.drawable.crab_idle_39 };
    private static final int[] MINICLAWD = { R.drawable.crab_miniclawd_0, R.drawable.crab_miniclawd_1, R.drawable.crab_miniclawd_2, R.drawable.crab_miniclawd_3, R.drawable.crab_miniclawd_4, R.drawable.crab_miniclawd_5, R.drawable.crab_miniclawd_6, R.drawable.crab_miniclawd_7, R.drawable.crab_miniclawd_8, R.drawable.crab_miniclawd_9, R.drawable.crab_miniclawd_10, R.drawable.crab_miniclawd_11, R.drawable.crab_miniclawd_12, R.drawable.crab_miniclawd_13, R.drawable.crab_miniclawd_14, R.drawable.crab_miniclawd_15, R.drawable.crab_miniclawd_16, R.drawable.crab_miniclawd_17, R.drawable.crab_miniclawd_18, R.drawable.crab_miniclawd_19, R.drawable.crab_miniclawd_20, R.drawable.crab_miniclawd_21, R.drawable.crab_miniclawd_22, R.drawable.crab_miniclawd_23, R.drawable.crab_miniclawd_24, R.drawable.crab_miniclawd_25, R.drawable.crab_miniclawd_26, R.drawable.crab_miniclawd_27, R.drawable.crab_miniclawd_28, R.drawable.crab_miniclawd_29, R.drawable.crab_miniclawd_30, R.drawable.crab_miniclawd_31, R.drawable.crab_miniclawd_32, R.drawable.crab_miniclawd_33, R.drawable.crab_miniclawd_34, R.drawable.crab_miniclawd_35, R.drawable.crab_miniclawd_36, R.drawable.crab_miniclawd_37, R.drawable.crab_miniclawd_38, R.drawable.crab_miniclawd_39 };
    private static final int[] NOTIF = { R.drawable.crab_notif_0, R.drawable.crab_notif_1, R.drawable.crab_notif_2, R.drawable.crab_notif_3, R.drawable.crab_notif_4, R.drawable.crab_notif_5, R.drawable.crab_notif_6, R.drawable.crab_notif_7, R.drawable.crab_notif_8, R.drawable.crab_notif_9, R.drawable.crab_notif_10, R.drawable.crab_notif_11, R.drawable.crab_notif_12, R.drawable.crab_notif_13, R.drawable.crab_notif_14, R.drawable.crab_notif_15, R.drawable.crab_notif_16, R.drawable.crab_notif_17, R.drawable.crab_notif_18, R.drawable.crab_notif_19, R.drawable.crab_notif_20, R.drawable.crab_notif_21, R.drawable.crab_notif_22, R.drawable.crab_notif_23, R.drawable.crab_notif_24, R.drawable.crab_notif_25, R.drawable.crab_notif_26, R.drawable.crab_notif_27, R.drawable.crab_notif_28, R.drawable.crab_notif_29, R.drawable.crab_notif_30, R.drawable.crab_notif_31, R.drawable.crab_notif_32, R.drawable.crab_notif_33, R.drawable.crab_notif_34, R.drawable.crab_notif_35, R.drawable.crab_notif_36, R.drawable.crab_notif_37, R.drawable.crab_notif_38, R.drawable.crab_notif_39 };
    private static final int[] SLEEP = { R.drawable.crab_sleep_0, R.drawable.crab_sleep_1, R.drawable.crab_sleep_2, R.drawable.crab_sleep_3, R.drawable.crab_sleep_4, R.drawable.crab_sleep_5, R.drawable.crab_sleep_6, R.drawable.crab_sleep_7, R.drawable.crab_sleep_8, R.drawable.crab_sleep_9, R.drawable.crab_sleep_10, R.drawable.crab_sleep_11, R.drawable.crab_sleep_12, R.drawable.crab_sleep_13, R.drawable.crab_sleep_14, R.drawable.crab_sleep_15, R.drawable.crab_sleep_16, R.drawable.crab_sleep_17, R.drawable.crab_sleep_18, R.drawable.crab_sleep_19, R.drawable.crab_sleep_20, R.drawable.crab_sleep_21, R.drawable.crab_sleep_22, R.drawable.crab_sleep_23, R.drawable.crab_sleep_24, R.drawable.crab_sleep_25, R.drawable.crab_sleep_26, R.drawable.crab_sleep_27, R.drawable.crab_sleep_28, R.drawable.crab_sleep_29, R.drawable.crab_sleep_30, R.drawable.crab_sleep_31, R.drawable.crab_sleep_32, R.drawable.crab_sleep_33, R.drawable.crab_sleep_34, R.drawable.crab_sleep_35, R.drawable.crab_sleep_36, R.drawable.crab_sleep_37, R.drawable.crab_sleep_38, R.drawable.crab_sleep_39 };
    private static final int[] REST = { R.drawable.crab_rest_0, R.drawable.crab_rest_1, R.drawable.crab_rest_2, R.drawable.crab_rest_3, R.drawable.crab_rest_4, R.drawable.crab_rest_5, R.drawable.crab_rest_6, R.drawable.crab_rest_7, R.drawable.crab_rest_8, R.drawable.crab_rest_9, R.drawable.crab_rest_10, R.drawable.crab_rest_11, R.drawable.crab_rest_12, R.drawable.crab_rest_13, R.drawable.crab_rest_14, R.drawable.crab_rest_15, R.drawable.crab_rest_16, R.drawable.crab_rest_17, R.drawable.crab_rest_18, R.drawable.crab_rest_19, R.drawable.crab_rest_20, R.drawable.crab_rest_21, R.drawable.crab_rest_22, R.drawable.crab_rest_23, R.drawable.crab_rest_24, R.drawable.crab_rest_25, R.drawable.crab_rest_26, R.drawable.crab_rest_27, R.drawable.crab_rest_28, R.drawable.crab_rest_29, R.drawable.crab_rest_30, R.drawable.crab_rest_31, R.drawable.crab_rest_32, R.drawable.crab_rest_33, R.drawable.crab_rest_34, R.drawable.crab_rest_35, R.drawable.crab_rest_36, R.drawable.crab_rest_37, R.drawable.crab_rest_38, R.drawable.crab_rest_39 };
    private static final int[] BEACON = { R.drawable.crab_beacon_0, R.drawable.crab_beacon_1, R.drawable.crab_beacon_2, R.drawable.crab_beacon_3, R.drawable.crab_beacon_4, R.drawable.crab_beacon_5, R.drawable.crab_beacon_6, R.drawable.crab_beacon_7, R.drawable.crab_beacon_8, R.drawable.crab_beacon_9, R.drawable.crab_beacon_10, R.drawable.crab_beacon_11, R.drawable.crab_beacon_12, R.drawable.crab_beacon_13, R.drawable.crab_beacon_14, R.drawable.crab_beacon_15, R.drawable.crab_beacon_16, R.drawable.crab_beacon_17, R.drawable.crab_beacon_18, R.drawable.crab_beacon_19, R.drawable.crab_beacon_20, R.drawable.crab_beacon_21, R.drawable.crab_beacon_22, R.drawable.crab_beacon_23, R.drawable.crab_beacon_24, R.drawable.crab_beacon_25, R.drawable.crab_beacon_26, R.drawable.crab_beacon_27, R.drawable.crab_beacon_28, R.drawable.crab_beacon_29, R.drawable.crab_beacon_30, R.drawable.crab_beacon_31, R.drawable.crab_beacon_32, R.drawable.crab_beacon_33, R.drawable.crab_beacon_34, R.drawable.crab_beacon_35, R.drawable.crab_beacon_36, R.drawable.crab_beacon_37, R.drawable.crab_beacon_38, R.drawable.crab_beacon_39 };
    private static final int[] BUILDING = { R.drawable.crab_building_0, R.drawable.crab_building_1, R.drawable.crab_building_2, R.drawable.crab_building_3, R.drawable.crab_building_4, R.drawable.crab_building_5, R.drawable.crab_building_6, R.drawable.crab_building_7, R.drawable.crab_building_8, R.drawable.crab_building_9, R.drawable.crab_building_10, R.drawable.crab_building_11, R.drawable.crab_building_12, R.drawable.crab_building_13, R.drawable.crab_building_14, R.drawable.crab_building_15, R.drawable.crab_building_16, R.drawable.crab_building_17, R.drawable.crab_building_18, R.drawable.crab_building_19, R.drawable.crab_building_20, R.drawable.crab_building_21, R.drawable.crab_building_22, R.drawable.crab_building_23, R.drawable.crab_building_24, R.drawable.crab_building_25, R.drawable.crab_building_26, R.drawable.crab_building_27, R.drawable.crab_building_28, R.drawable.crab_building_29, R.drawable.crab_building_30, R.drawable.crab_building_31, R.drawable.crab_building_32, R.drawable.crab_building_33, R.drawable.crab_building_34, R.drawable.crab_building_35, R.drawable.crab_building_36, R.drawable.crab_building_37, R.drawable.crab_building_38, R.drawable.crab_building_39 };
    private static final int[] CARRYING = { R.drawable.crab_carrying_0, R.drawable.crab_carrying_1, R.drawable.crab_carrying_2, R.drawable.crab_carrying_3, R.drawable.crab_carrying_4, R.drawable.crab_carrying_5, R.drawable.crab_carrying_6, R.drawable.crab_carrying_7, R.drawable.crab_carrying_8, R.drawable.crab_carrying_9, R.drawable.crab_carrying_10, R.drawable.crab_carrying_11, R.drawable.crab_carrying_12, R.drawable.crab_carrying_13, R.drawable.crab_carrying_14, R.drawable.crab_carrying_15, R.drawable.crab_carrying_16, R.drawable.crab_carrying_17, R.drawable.crab_carrying_18, R.drawable.crab_carrying_19, R.drawable.crab_carrying_20, R.drawable.crab_carrying_21, R.drawable.crab_carrying_22, R.drawable.crab_carrying_23, R.drawable.crab_carrying_24, R.drawable.crab_carrying_25, R.drawable.crab_carrying_26, R.drawable.crab_carrying_27, R.drawable.crab_carrying_28, R.drawable.crab_carrying_29, R.drawable.crab_carrying_30, R.drawable.crab_carrying_31, R.drawable.crab_carrying_32, R.drawable.crab_carrying_33, R.drawable.crab_carrying_34, R.drawable.crab_carrying_35, R.drawable.crab_carrying_36, R.drawable.crab_carrying_37, R.drawable.crab_carrying_38, R.drawable.crab_carrying_39 };
    private static final int[] CONDUCTING = { R.drawable.crab_conducting_0, R.drawable.crab_conducting_1, R.drawable.crab_conducting_2, R.drawable.crab_conducting_3, R.drawable.crab_conducting_4, R.drawable.crab_conducting_5, R.drawable.crab_conducting_6, R.drawable.crab_conducting_7, R.drawable.crab_conducting_8, R.drawable.crab_conducting_9, R.drawable.crab_conducting_10, R.drawable.crab_conducting_11, R.drawable.crab_conducting_12, R.drawable.crab_conducting_13, R.drawable.crab_conducting_14, R.drawable.crab_conducting_15, R.drawable.crab_conducting_16, R.drawable.crab_conducting_17, R.drawable.crab_conducting_18, R.drawable.crab_conducting_19, R.drawable.crab_conducting_20, R.drawable.crab_conducting_21, R.drawable.crab_conducting_22, R.drawable.crab_conducting_23, R.drawable.crab_conducting_24, R.drawable.crab_conducting_25, R.drawable.crab_conducting_26, R.drawable.crab_conducting_27, R.drawable.crab_conducting_28, R.drawable.crab_conducting_29, R.drawable.crab_conducting_30, R.drawable.crab_conducting_31, R.drawable.crab_conducting_32, R.drawable.crab_conducting_33, R.drawable.crab_conducting_34, R.drawable.crab_conducting_35, R.drawable.crab_conducting_36, R.drawable.crab_conducting_37, R.drawable.crab_conducting_38, R.drawable.crab_conducting_39 };
    private static final int[] CONFUSED = { R.drawable.crab_confused_0, R.drawable.crab_confused_1, R.drawable.crab_confused_2, R.drawable.crab_confused_3, R.drawable.crab_confused_4, R.drawable.crab_confused_5, R.drawable.crab_confused_6, R.drawable.crab_confused_7, R.drawable.crab_confused_8, R.drawable.crab_confused_9, R.drawable.crab_confused_10, R.drawable.crab_confused_11, R.drawable.crab_confused_12, R.drawable.crab_confused_13, R.drawable.crab_confused_14, R.drawable.crab_confused_15, R.drawable.crab_confused_16, R.drawable.crab_confused_17, R.drawable.crab_confused_18, R.drawable.crab_confused_19, R.drawable.crab_confused_20, R.drawable.crab_confused_21, R.drawable.crab_confused_22, R.drawable.crab_confused_23, R.drawable.crab_confused_24, R.drawable.crab_confused_25, R.drawable.crab_confused_26, R.drawable.crab_confused_27, R.drawable.crab_confused_28, R.drawable.crab_confused_29, R.drawable.crab_confused_30, R.drawable.crab_confused_31, R.drawable.crab_confused_32, R.drawable.crab_confused_33, R.drawable.crab_confused_34, R.drawable.crab_confused_35, R.drawable.crab_confused_36, R.drawable.crab_confused_37, R.drawable.crab_confused_38, R.drawable.crab_confused_39 };
    private static final int[] DEBUGGER = { R.drawable.crab_debugger_0, R.drawable.crab_debugger_1, R.drawable.crab_debugger_2, R.drawable.crab_debugger_3, R.drawable.crab_debugger_4, R.drawable.crab_debugger_5, R.drawable.crab_debugger_6, R.drawable.crab_debugger_7, R.drawable.crab_debugger_8, R.drawable.crab_debugger_9, R.drawable.crab_debugger_10, R.drawable.crab_debugger_11, R.drawable.crab_debugger_12, R.drawable.crab_debugger_13, R.drawable.crab_debugger_14, R.drawable.crab_debugger_15, R.drawable.crab_debugger_16, R.drawable.crab_debugger_17, R.drawable.crab_debugger_18, R.drawable.crab_debugger_19, R.drawable.crab_debugger_20, R.drawable.crab_debugger_21, R.drawable.crab_debugger_22, R.drawable.crab_debugger_23, R.drawable.crab_debugger_24, R.drawable.crab_debugger_25, R.drawable.crab_debugger_26, R.drawable.crab_debugger_27, R.drawable.crab_debugger_28, R.drawable.crab_debugger_29, R.drawable.crab_debugger_30, R.drawable.crab_debugger_31, R.drawable.crab_debugger_32, R.drawable.crab_debugger_33, R.drawable.crab_debugger_34, R.drawable.crab_debugger_35, R.drawable.crab_debugger_36, R.drawable.crab_debugger_37, R.drawable.crab_debugger_38, R.drawable.crab_debugger_39 };
    private static final int[] JUGGLING = { R.drawable.crab_juggling_0, R.drawable.crab_juggling_1, R.drawable.crab_juggling_2, R.drawable.crab_juggling_3, R.drawable.crab_juggling_4, R.drawable.crab_juggling_5, R.drawable.crab_juggling_6, R.drawable.crab_juggling_7, R.drawable.crab_juggling_8, R.drawable.crab_juggling_9, R.drawable.crab_juggling_10, R.drawable.crab_juggling_11, R.drawable.crab_juggling_12, R.drawable.crab_juggling_13, R.drawable.crab_juggling_14, R.drawable.crab_juggling_15, R.drawable.crab_juggling_16, R.drawable.crab_juggling_17, R.drawable.crab_juggling_18, R.drawable.crab_juggling_19, R.drawable.crab_juggling_20, R.drawable.crab_juggling_21, R.drawable.crab_juggling_22, R.drawable.crab_juggling_23, R.drawable.crab_juggling_24, R.drawable.crab_juggling_25, R.drawable.crab_juggling_26, R.drawable.crab_juggling_27, R.drawable.crab_juggling_28, R.drawable.crab_juggling_29, R.drawable.crab_juggling_30, R.drawable.crab_juggling_31, R.drawable.crab_juggling_32, R.drawable.crab_juggling_33, R.drawable.crab_juggling_34, R.drawable.crab_juggling_35, R.drawable.crab_juggling_36, R.drawable.crab_juggling_37, R.drawable.crab_juggling_38, R.drawable.crab_juggling_39 };
    private static final int[] OVERHEATED = { R.drawable.crab_overheated_0, R.drawable.crab_overheated_1, R.drawable.crab_overheated_2, R.drawable.crab_overheated_3, R.drawable.crab_overheated_4, R.drawable.crab_overheated_5, R.drawable.crab_overheated_6, R.drawable.crab_overheated_7, R.drawable.crab_overheated_8, R.drawable.crab_overheated_9, R.drawable.crab_overheated_10, R.drawable.crab_overheated_11, R.drawable.crab_overheated_12, R.drawable.crab_overheated_13, R.drawable.crab_overheated_14, R.drawable.crab_overheated_15, R.drawable.crab_overheated_16, R.drawable.crab_overheated_17, R.drawable.crab_overheated_18, R.drawable.crab_overheated_19, R.drawable.crab_overheated_20, R.drawable.crab_overheated_21, R.drawable.crab_overheated_22, R.drawable.crab_overheated_23, R.drawable.crab_overheated_24, R.drawable.crab_overheated_25, R.drawable.crab_overheated_26, R.drawable.crab_overheated_27, R.drawable.crab_overheated_28, R.drawable.crab_overheated_29, R.drawable.crab_overheated_30, R.drawable.crab_overheated_31, R.drawable.crab_overheated_32, R.drawable.crab_overheated_33, R.drawable.crab_overheated_34, R.drawable.crab_overheated_35, R.drawable.crab_overheated_36, R.drawable.crab_overheated_37, R.drawable.crab_overheated_38, R.drawable.crab_overheated_39 };
    private static final int[] PUSHING = { R.drawable.crab_pushing_0, R.drawable.crab_pushing_1, R.drawable.crab_pushing_2, R.drawable.crab_pushing_3, R.drawable.crab_pushing_4, R.drawable.crab_pushing_5, R.drawable.crab_pushing_6, R.drawable.crab_pushing_7, R.drawable.crab_pushing_8, R.drawable.crab_pushing_9, R.drawable.crab_pushing_10, R.drawable.crab_pushing_11, R.drawable.crab_pushing_12, R.drawable.crab_pushing_13, R.drawable.crab_pushing_14, R.drawable.crab_pushing_15, R.drawable.crab_pushing_16, R.drawable.crab_pushing_17, R.drawable.crab_pushing_18, R.drawable.crab_pushing_19, R.drawable.crab_pushing_20, R.drawable.crab_pushing_21, R.drawable.crab_pushing_22, R.drawable.crab_pushing_23, R.drawable.crab_pushing_24, R.drawable.crab_pushing_25, R.drawable.crab_pushing_26, R.drawable.crab_pushing_27, R.drawable.crab_pushing_28, R.drawable.crab_pushing_29, R.drawable.crab_pushing_30, R.drawable.crab_pushing_31, R.drawable.crab_pushing_32, R.drawable.crab_pushing_33, R.drawable.crab_pushing_34, R.drawable.crab_pushing_35, R.drawable.crab_pushing_36, R.drawable.crab_pushing_37, R.drawable.crab_pushing_38, R.drawable.crab_pushing_39 };
    private static final int[] SWEEPING = { R.drawable.crab_sweeping_0, R.drawable.crab_sweeping_1, R.drawable.crab_sweeping_2, R.drawable.crab_sweeping_3, R.drawable.crab_sweeping_4, R.drawable.crab_sweeping_5, R.drawable.crab_sweeping_6, R.drawable.crab_sweeping_7, R.drawable.crab_sweeping_8, R.drawable.crab_sweeping_9, R.drawable.crab_sweeping_10, R.drawable.crab_sweeping_11, R.drawable.crab_sweeping_12, R.drawable.crab_sweeping_13, R.drawable.crab_sweeping_14, R.drawable.crab_sweeping_15, R.drawable.crab_sweeping_16, R.drawable.crab_sweeping_17, R.drawable.crab_sweeping_18, R.drawable.crab_sweeping_19, R.drawable.crab_sweeping_20, R.drawable.crab_sweeping_21, R.drawable.crab_sweeping_22, R.drawable.crab_sweeping_23, R.drawable.crab_sweeping_24, R.drawable.crab_sweeping_25, R.drawable.crab_sweeping_26, R.drawable.crab_sweeping_27, R.drawable.crab_sweeping_28, R.drawable.crab_sweeping_29, R.drawable.crab_sweeping_30, R.drawable.crab_sweeping_31, R.drawable.crab_sweeping_32, R.drawable.crab_sweeping_33, R.drawable.crab_sweeping_34, R.drawable.crab_sweeping_35, R.drawable.crab_sweeping_36, R.drawable.crab_sweeping_37, R.drawable.crab_sweeping_38, R.drawable.crab_sweeping_39 };
    private static final int[] THINKING = { R.drawable.crab_thinking_0, R.drawable.crab_thinking_1, R.drawable.crab_thinking_2, R.drawable.crab_thinking_3, R.drawable.crab_thinking_4, R.drawable.crab_thinking_5, R.drawable.crab_thinking_6, R.drawable.crab_thinking_7, R.drawable.crab_thinking_8, R.drawable.crab_thinking_9, R.drawable.crab_thinking_10, R.drawable.crab_thinking_11, R.drawable.crab_thinking_12, R.drawable.crab_thinking_13, R.drawable.crab_thinking_14, R.drawable.crab_thinking_15, R.drawable.crab_thinking_16, R.drawable.crab_thinking_17, R.drawable.crab_thinking_18, R.drawable.crab_thinking_19, R.drawable.crab_thinking_20, R.drawable.crab_thinking_21, R.drawable.crab_thinking_22, R.drawable.crab_thinking_23, R.drawable.crab_thinking_24, R.drawable.crab_thinking_25, R.drawable.crab_thinking_26, R.drawable.crab_thinking_27, R.drawable.crab_thinking_28, R.drawable.crab_thinking_29, R.drawable.crab_thinking_30, R.drawable.crab_thinking_31, R.drawable.crab_thinking_32, R.drawable.crab_thinking_33, R.drawable.crab_thinking_34, R.drawable.crab_thinking_35, R.drawable.crab_thinking_36, R.drawable.crab_thinking_37, R.drawable.crab_thinking_38, R.drawable.crab_thinking_39 };
    private static final int[] TYPING = { R.drawable.crab_typing_0, R.drawable.crab_typing_1, R.drawable.crab_typing_2, R.drawable.crab_typing_3, R.drawable.crab_typing_4, R.drawable.crab_typing_5, R.drawable.crab_typing_6, R.drawable.crab_typing_7, R.drawable.crab_typing_8, R.drawable.crab_typing_9, R.drawable.crab_typing_10, R.drawable.crab_typing_11, R.drawable.crab_typing_12, R.drawable.crab_typing_13, R.drawable.crab_typing_14, R.drawable.crab_typing_15, R.drawable.crab_typing_16, R.drawable.crab_typing_17, R.drawable.crab_typing_18, R.drawable.crab_typing_19, R.drawable.crab_typing_20, R.drawable.crab_typing_21, R.drawable.crab_typing_22, R.drawable.crab_typing_23, R.drawable.crab_typing_24, R.drawable.crab_typing_25, R.drawable.crab_typing_26, R.drawable.crab_typing_27, R.drawable.crab_typing_28, R.drawable.crab_typing_29, R.drawable.crab_typing_30, R.drawable.crab_typing_31, R.drawable.crab_typing_32, R.drawable.crab_typing_33, R.drawable.crab_typing_34, R.drawable.crab_typing_35, R.drawable.crab_typing_36, R.drawable.crab_typing_37, R.drawable.crab_typing_38, R.drawable.crab_typing_39 };
    private static final int[] WIZARD = { R.drawable.crab_wizard_0, R.drawable.crab_wizard_1, R.drawable.crab_wizard_2, R.drawable.crab_wizard_3, R.drawable.crab_wizard_4, R.drawable.crab_wizard_5, R.drawable.crab_wizard_6, R.drawable.crab_wizard_7, R.drawable.crab_wizard_8, R.drawable.crab_wizard_9, R.drawable.crab_wizard_10, R.drawable.crab_wizard_11, R.drawable.crab_wizard_12, R.drawable.crab_wizard_13, R.drawable.crab_wizard_14, R.drawable.crab_wizard_15, R.drawable.crab_wizard_16, R.drawable.crab_wizard_17, R.drawable.crab_wizard_18, R.drawable.crab_wizard_19, R.drawable.crab_wizard_20, R.drawable.crab_wizard_21, R.drawable.crab_wizard_22, R.drawable.crab_wizard_23, R.drawable.crab_wizard_24, R.drawable.crab_wizard_25, R.drawable.crab_wizard_26, R.drawable.crab_wizard_27, R.drawable.crab_wizard_28, R.drawable.crab_wizard_29, R.drawable.crab_wizard_30, R.drawable.crab_wizard_31, R.drawable.crab_wizard_32, R.drawable.crab_wizard_33, R.drawable.crab_wizard_34, R.drawable.crab_wizard_35, R.drawable.crab_wizard_36, R.drawable.crab_wizard_37, R.drawable.crab_wizard_38, R.drawable.crab_wizard_39 };
    private static final int[] MINITYPING = { R.drawable.crab_minityping_0, R.drawable.crab_minityping_1, R.drawable.crab_minityping_2, R.drawable.crab_minityping_3, R.drawable.crab_minityping_4, R.drawable.crab_minityping_5, R.drawable.crab_minityping_6, R.drawable.crab_minityping_7, R.drawable.crab_minityping_8, R.drawable.crab_minityping_9, R.drawable.crab_minityping_10, R.drawable.crab_minityping_11, R.drawable.crab_minityping_12, R.drawable.crab_minityping_13, R.drawable.crab_minityping_14, R.drawable.crab_minityping_15, R.drawable.crab_minityping_16, R.drawable.crab_minityping_17, R.drawable.crab_minityping_18, R.drawable.crab_minityping_19, R.drawable.crab_minityping_20, R.drawable.crab_minityping_21, R.drawable.crab_minityping_22, R.drawable.crab_minityping_23, R.drawable.crab_minityping_24, R.drawable.crab_minityping_25, R.drawable.crab_minityping_26, R.drawable.crab_minityping_27, R.drawable.crab_minityping_28, R.drawable.crab_minityping_29, R.drawable.crab_minityping_30, R.drawable.crab_minityping_31, R.drawable.crab_minityping_32, R.drawable.crab_minityping_33, R.drawable.crab_minityping_34, R.drawable.crab_minityping_35, R.drawable.crab_minityping_36, R.drawable.crab_minityping_37, R.drawable.crab_minityping_38, R.drawable.crab_minityping_39 };
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

        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;

        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch != null) {
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            views.setOnClickPendingIntent(R.id.combo_left,
                PendingIntent.getActivity(context, 2, launch, flags));
        }
        Intent poke = new Intent(context, ComboWidgetProvider.class).setAction(ACTION_POKE);
        views.setOnClickPendingIntent(R.id.combo_flipper,
            PendingIntent.getBroadcast(context, 10, poke, flags));

        mgr.updateAppWidget(id, views);
    }
}
