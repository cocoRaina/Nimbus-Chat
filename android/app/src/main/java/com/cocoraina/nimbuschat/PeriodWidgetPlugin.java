package com.cocoraina.nimbuschat;

import android.content.Context;
import android.content.SharedPreferences;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Lets the web app push the latest period data into the SharedPreferences
 * file that {@link PeriodWidgetProvider} reads, then refreshes any live
 * home-screen widgets immediately. Called from src/storage/periodWidget.ts.
 */
@CapacitorPlugin(name = "PeriodWidget")
public class PeriodWidgetPlugin extends Plugin {

    @PluginMethod
    public void update(PluginCall call) {
        Context ctx = getContext();
        SharedPreferences prefs = ctx.getSharedPreferences(PeriodCalc.PREFS, Context.MODE_PRIVATE);
        SharedPreferences.Editor e = prefs.edit();
        e.putBoolean("hasData", Boolean.TRUE.equals(call.getBoolean("hasData", false)));
        e.putString("startDate", call.getString("startDate", ""));
        String endDate = call.getString("endDate", null);
        e.putString("endDate", endDate == null ? "" : endDate);
        Integer cycleLength = call.getInt("cycleLength");
        e.putInt("cycleLength", cycleLength == null ? 28 : cycleLength);
        e.apply();

        PeriodWidgetProvider.updateAll(ctx);
        PetWidgetProvider.updateAll(ctx);
        call.resolve();
    }
}
