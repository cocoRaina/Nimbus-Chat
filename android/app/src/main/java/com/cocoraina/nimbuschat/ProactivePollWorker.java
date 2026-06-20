package com.cocoraina.nimbuschat;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;

/**
 * Periodic background poll (every ~15 min, the Android minimum) that asks the
 * poll_proactive Edge Function whether the server has written any spontaneous
 * AI messages since we last checked. If so, it raises a LOCAL notification.
 *
 * Why this exists: spontaneous messages are decided server-side at an arbitrary
 * time, so unlike scheduled proactives they can't pre-arm an on-device alarm.
 * The only way to surface them when the app is killed WITHOUT a push service
 * (FCM needs Google Play Services, absent on Huawei et al.) is to poll and post
 * a local notification ourselves. ~15 min latency is fine for a "reach out"
 * nudge; the trade-off vs FCM is latency, the win is it works on any phone.
 *
 * Config (Supabase URL, anon key, user_id, persona, since-pointer) is written
 * to SharedPreferences by {@link ProactivePollPlugin} while the app is open.
 */
public class ProactivePollWorker extends Worker {
    static final String PREFS = "proactive_poll";
    static final String CHANNEL_ID = "proactive_spontaneous";
    private static final int NOTIF_ID_BASE = 2100;

    public ProactivePollWorker(@NonNull Context context, @NonNull WorkerParameters params) {
        super(context, params);
    }

    @NonNull
    @Override
    public Result doWork() {
        Context ctx = getApplicationContext();
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String baseUrl = prefs.getString("supabase_url", "");
        String anonKey = prefs.getString("anon_key", "");
        String userId = prefs.getString("user_id", "");
        String since = prefs.getString("since", "");
        if (baseUrl.isEmpty() || anonKey.isEmpty() || userId.isEmpty() || since.isEmpty()) {
            return Result.success();
        }

        try {
            String endpoint = baseUrl.replaceAll("/+$", "") + "/functions/v1/poll_proactive";
            JSONObject reqBody = new JSONObject();
            reqBody.put("user_id", userId);
            reqBody.put("since", since);

            HttpURLConnection conn = (HttpURLConnection) new URL(endpoint).openConnection();
            conn.setRequestMethod("POST");
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("apikey", anonKey);
            conn.setRequestProperty("Authorization", "Bearer " + anonKey);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(15000);
            conn.setDoOutput(true);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(reqBody.toString().getBytes(StandardCharsets.UTF_8));
            }

            int code = conn.getResponseCode();
            if (code != 200) {
                // Back off silently; the next periodic run retries. Never throw
                // a retry storm at a failing endpoint.
                return Result.success();
            }

            StringBuilder sb = new StringBuilder();
            try (BufferedReader br = new BufferedReader(
                    new InputStreamReader(conn.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = br.readLine()) != null) sb.append(line);
            }

            JSONObject resp = new JSONObject(sb.toString());
            JSONArray messages = resp.optJSONArray("messages");
            if (messages != null && messages.length() > 0) {
                ensureChannel(ctx);
                String persona = prefs.getString("persona", "");
                if (persona.isEmpty()) persona = "AI";
                for (int i = 0; i < messages.length(); i++) {
                    String text = messages.getJSONObject(i).optString("text", "");
                    if (!text.isEmpty()) {
                        showNotification(ctx, NOTIF_ID_BASE + i, persona, text);
                    }
                }
                // Advance the pointer past the newest message so the next cycle
                // doesn't re-notify. The Edge Function orders ascending, so the
                // LAST element is newest — take it directly. (Do NOT string-
                // compare against `since`: it's JS toISOString format `...Z`
                // while created_at is Postgres `...+00:00`, so a lexical compare
                // is wrong and would leave the pointer un-advanced → duplicate
                // notifications every cycle.) The next query uses `.gt`, so the
                // strictly-greater filter excludes this exact message.
                String newest = messages.getJSONObject(messages.length() - 1)
                        .optString("created_at", "");
                if (!newest.isEmpty()) {
                    prefs.edit().putString("since", newest).apply();
                }
            }
            return Result.success();
        } catch (Exception e) {
            return Result.success();
        }
    }

    private void ensureChannel(Context ctx) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm =
                    (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_ID, "主动消息", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("AI 主动发来的消息");
                nm.createNotificationChannel(ch);
            }
        }
    }

    private void showNotification(Context ctx, int id, String title, String text) {
        Intent intent = new Intent(ctx, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent pi = PendingIntent.getActivity(ctx, id, intent, flags);

        NotificationCompat.Builder b = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(ctx.getApplicationInfo().icon)
                .setContentTitle(title)
                .setContentText(text)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setContentIntent(pi);

        NotificationManager nm =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        nm.notify(id, b.build());
    }
}
