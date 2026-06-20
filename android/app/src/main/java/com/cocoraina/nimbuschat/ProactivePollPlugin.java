package com.cocoraina.nimbuschat;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.concurrent.TimeUnit;

/**
 * Bridge for the WorkManager-based spontaneous-message poller. Called from
 * src/plugins/ProactivePoll.ts. Stores the Supabase config in SharedPreferences
 * (so {@link ProactivePollWorker} can read it when the app isn't running) and
 * schedules the periodic work.
 */
@CapacitorPlugin(name = "ProactivePoll")
public class ProactivePollPlugin extends Plugin {
    private static final String WORK_NAME = "proactive_poll_periodic";

    @PluginMethod
    public void configure(PluginCall call) {
        Context ctx = getContext();
        SharedPreferences prefs =
                ctx.getSharedPreferences(ProactivePollWorker.PREFS, Context.MODE_PRIVATE);
        SharedPreferences.Editor e = prefs.edit();
        e.putString("supabase_url", call.getString("supabaseUrl", ""));
        e.putString("anon_key", call.getString("anonKey", ""));
        e.putString("user_id", call.getString("userId", ""));
        e.putString("persona", call.getString("persona", "AI"));
        // Seed the since-pointer on first config so we don't notify for the
        // entire message backlog. Later foregrounds advance it via setSeen().
        if (!prefs.contains("since")) {
            e.putString("since", call.getString("now", ""));
        }
        e.apply();

        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        PeriodicWorkRequest req = new PeriodicWorkRequest.Builder(
                ProactivePollWorker.class, 15, TimeUnit.MINUTES)
                .setConstraints(constraints)
                .build();
        // KEEP: don't reset the 15-min timer on every app launch. The worker
        // reads config fresh from SharedPreferences each run, so updates to
        // user_id / persona still take effect without rescheduling.
        WorkManager.getInstance(ctx).enqueueUniquePeriodicWork(
                WORK_NAME, ExistingPeriodicWorkPolicy.KEEP, req);
        call.resolve();
    }

    /** Advance the since-pointer to `now` so messages the user is already
     *  seeing in-app aren't re-surfaced as notifications. Called on foreground. */
    @PluginMethod
    public void setSeen(PluginCall call) {
        Context ctx = getContext();
        SharedPreferences prefs =
                ctx.getSharedPreferences(ProactivePollWorker.PREFS, Context.MODE_PRIVATE);
        String now = call.getString("now", "");
        if (!now.isEmpty()) {
            prefs.edit().putString("since", now).apply();
        }
        call.resolve();
    }

    @PluginMethod
    public void disable(PluginCall call) {
        WorkManager.getInstance(getContext()).cancelUniqueWork(WORK_NAME);
        call.resolve();
    }
}
