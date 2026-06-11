package com.cocoraina.nimbuschat;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.widget.RemoteViews;
import java.util.Calendar;

/**
 * Emoji desktop pet widget. Shares the period data pushed via
 * {@link PeriodWidgetPlugin} and shows a little creature whose face + line
 * reflect the cycle phase and time of day. The face is two emoji frames in a
 * ViewFlipper (auto-flips) so it gently "blinks" without any animation code.
 * No image assets needed — emoji render crisp at any size.
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

        // face = [normal frame, blink frame], plus a mood line.
        String faceA, faceB, line;
        if (!r.hasData) {
            faceA = "🐱"; faceB = "😺"; line = "戳我去设置经期吧~";
        } else if (isNight()) {
            faceA = "😴"; faceB = "😪"; line = "夜深了，早点睡哦…";
        } else {
            switch (r.phase) {
                case "经期中":
                    faceA = "🥺"; faceB = "😣"; line = "今天要多喝热水哦";
                    break;
                case "滤泡期":
                    faceA = "😊"; faceB = "😄"; line = "状态回来啦~";
                    break;
                case "排卵期":
                    faceA = "😻"; faceB = "😺"; line = "元气满满！";
                    break;
                default: // 黄体期
                    faceA = "😌"; faceB = "🙂"; line = "想被多关心一点…";
                    break;
            }
        }

        views.setTextViewText(R.id.widget_pet_a, faceA);
        views.setTextViewText(R.id.widget_pet_b, faceB);
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
