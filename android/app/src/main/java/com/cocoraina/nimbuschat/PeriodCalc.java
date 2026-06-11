package com.cocoraina.nimbuschat;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.Calendar;
import java.util.TimeZone;

/**
 * Shared period math for the home-screen widgets (PeriodWidgetProvider +
 * PetWidgetProvider). Reads the data the app pushed via PeriodWidgetPlugin
 * and recomputes phase / cycle day on demand, so the widgets stay correct
 * across day rollovers without the app running.
 *
 * Dates are compared as UTC-midnight day numbers (date-only), mirroring the
 * timezone-safe comparison in src/hooks/useHomeWidgetData.ts.
 */
class PeriodCalc {
    static final String PREFS = "NimbusPeriodWidget";
    private static final long ONE_DAY = 24L * 60 * 60 * 1000;

    static class Result {
        boolean hasData;
        int cycleDay;     // 1-indexed; "day 1" = start_date
        int daysToNext;   // >0 remaining, 0 due today, <0 late
        String phase;     // 经期中 / 滤泡期 / 排卵期 / 黄体期
    }

    static long dateNum(String s) {
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

    static long todayNum() {
        Calendar local = Calendar.getInstance();
        Calendar c = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
        c.clear();
        c.set(local.get(Calendar.YEAR), local.get(Calendar.MONTH), local.get(Calendar.DAY_OF_MONTH));
        return c.getTimeInMillis();
    }

    static Result fromPrefs(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        Result r = new Result();
        boolean hasData = prefs.getBoolean("hasData", false);
        String startDate = prefs.getString("startDate", "");
        String endDate = prefs.getString("endDate", "");
        int cycleLength = prefs.getInt("cycleLength", 28);

        if (!hasData || startDate.isEmpty() || dateNum(startDate) == Long.MIN_VALUE) {
            r.hasData = false;
            return r;
        }
        long startN = dateNum(startDate);
        long todayN = todayNum();
        int daysSinceStart = (int) Math.floor((double) (todayN - startN) / ONE_DAY);

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

        r.hasData = true;
        r.cycleDay = Math.max(1, daysSinceStart + 1);
        r.daysToNext = cycleLength - daysSinceStart;
        r.phase = phase;
        return r;
    }
}
