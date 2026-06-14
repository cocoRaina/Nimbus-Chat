package com.cocoraina.nimbuschat;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSessionManager;
import android.media.session.PlaybackState;
import android.net.Uri;
import android.provider.Settings;
import android.view.KeyEvent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;

/**
 * Native media bridge for the control_media + get_now_playing tools.
 *
 * Two capability tiers:
 *   - WITHOUT notification access: control() still works by broadcasting a
 *     global media key (AudioManager.dispatchMediaKeyEvent). get_now_playing
 *     can't read metadata, so it returns NO_PERMISSION.
 *   - WITH notification access (user enabled NowPlayingListener in
 *     Settings → 通知使用权): we can enumerate active MediaControllers, so
 *     control() targets the actually-playing session precisely, and
 *     getNowPlaying() returns title/artist/album/position/app.
 */
@CapacitorPlugin(name = "MediaControl")
public class MediaControlPlugin extends Plugin {

    @PluginMethod
    public void control(PluginCall call) {
        String action = call.getString("action", "pause");

        // Prefer precise control via the active media session.
        if (controlViaSession(action)) {
            JSObject result = new JSObject();
            result.put("ok", true);
            result.put("action", action);
            result.put("method", "session");
            call.resolve(result);
            return;
        }

        // Fallback: broadcast a global media key. Works without any special
        // permission, but goes to whichever app currently holds audio focus.
        AudioManager am = (AudioManager) getContext().getSystemService(Context.AUDIO_SERVICE);
        int keyCode;
        switch (action) {
            case "next":     keyCode = KeyEvent.KEYCODE_MEDIA_NEXT;     break;
            case "previous": keyCode = KeyEvent.KEYCODE_MEDIA_PREVIOUS; break;
            case "play":     keyCode = KeyEvent.KEYCODE_MEDIA_PLAY;     break;
            case "pause":    keyCode = KeyEvent.KEYCODE_MEDIA_PAUSE;    break;
            default:         keyCode = KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE; break;
        }
        am.dispatchMediaKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, keyCode));
        am.dispatchMediaKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, keyCode));

        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("action", action);
        result.put("method", "mediakey");
        call.resolve(result);
    }

    @PluginMethod
    public void getNowPlaying(PluginCall call) {
        if (!isNotificationAccessGranted()) {
            call.reject("NO_PERMISSION");
            return;
        }

        MediaController controller = pickActiveController();
        if (controller == null) {
            JSObject ret = new JSObject();
            ret.put("playing", false);
            call.resolve(ret);
            return;
        }

        JSObject ret = new JSObject();
        PlaybackState ps = controller.getPlaybackState();
        boolean playing = ps != null && ps.getState() == PlaybackState.STATE_PLAYING;
        ret.put("playing", playing);

        MediaMetadata md = controller.getMetadata();
        if (md != null) {
            String title = md.getString(MediaMetadata.METADATA_KEY_TITLE);
            String artist = md.getString(MediaMetadata.METADATA_KEY_ARTIST);
            String album = md.getString(MediaMetadata.METADATA_KEY_ALBUM);
            if (title != null) ret.put("title", title);
            if (artist != null) ret.put("artist", artist);
            if (album != null) ret.put("album", album);
            long dur = md.getLong(MediaMetadata.METADATA_KEY_DURATION);
            if (dur > 0) ret.put("duration_seconds", dur / 1000);
        }
        if (ps != null && ps.getPosition() >= 0) {
            ret.put("position_seconds", ps.getPosition() / 1000);
        }

        String pkg = controller.getPackageName();
        ret.put("package_name", pkg);
        ret.put("app", appLabel(pkg));

        call.resolve(ret);
    }

    /**
     * Fire an ACTION_VIEW intent for a URL.
     *
     * For play_music we pass url = "https://music.163.com/song?id=xxx" and
     * packageName = "com.netease.cloudmusic". Setting the package makes
     * Android skip the browser chooser and route straight into NetEase;
     * the https URL is registered as an App Link by NetEase and correctly
     * navigates to + auto-plays the specific song.
     *
     * If the explicit-package launch fails (app not installed, or the
     * URL isn't one the target app handles), we retry without the package
     * restriction so Android falls back to the normal chooser.
     */
    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("url required");
            return;
        }
        String packageName = call.getString("packageName", null);
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            if (packageName != null && !packageName.isEmpty()) {
                intent.setPackage(packageName);
            }
            try {
                getContext().startActivity(intent);
            } catch (Exception firstErr) {
                // Package-restricted launch failed; retry without restriction.
                intent.setPackage(null);
                getContext().startActivity(intent);
            }
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("Failed to open url: " + e.getMessage());
        }
    }

    @PluginMethod
    public void hasPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", isNotificationAccessGranted());
        call.resolve(ret);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        Intent intent = new Intent(Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("Failed to open notification access settings: " + e.getMessage());
        }
    }

    // --- helpers ---------------------------------------------------------

    private boolean controlViaSession(String action) {
        MediaController controller = pickActiveController();
        if (controller == null) return false;
        try {
            MediaController.TransportControls tc = controller.getTransportControls();
            switch (action) {
                case "next":     tc.skipToNext();     break;
                case "previous": tc.skipToPrevious(); break;
                case "play":     tc.play();           break;
                case "pause":    tc.pause();          break;
                default:
                    PlaybackState ps = controller.getPlaybackState();
                    if (ps != null && ps.getState() == PlaybackState.STATE_PLAYING) {
                        tc.pause();
                    } else {
                        tc.play();
                    }
            }
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    /**
     * The active session most likely to be "the music": prefer one currently
     * in STATE_PLAYING, else fall back to the first session the system lists
     * (ordered by recency). Returns null without notification access or when
     * nothing is sounding.
     */
    private MediaController pickActiveController() {
        if (!isNotificationAccessGranted()) return null;
        try {
            MediaSessionManager msm =
                (MediaSessionManager) getContext().getSystemService(Context.MEDIA_SESSION_SERVICE);
            if (msm == null) return null;
            ComponentName cn = new ComponentName(getContext(), NowPlayingListener.class);
            List<MediaController> controllers = msm.getActiveSessions(cn);
            if (controllers == null || controllers.isEmpty()) return null;
            for (MediaController c : controllers) {
                PlaybackState ps = c.getPlaybackState();
                if (ps != null && ps.getState() == PlaybackState.STATE_PLAYING) {
                    return c;
                }
            }
            return controllers.get(0);
        } catch (SecurityException e) {
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    private String appLabel(String pkg) {
        if (pkg == null) return null;
        try {
            PackageManager pm = getContext().getPackageManager();
            return pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString();
        } catch (Exception e) {
            return pkg;
        }
    }

    private boolean isNotificationAccessGranted() {
        String flat = Settings.Secure.getString(
            getContext().getContentResolver(), "enabled_notification_listeners");
        if (flat == null || flat.isEmpty()) return false;
        String pkg = getContext().getPackageName();
        for (String name : flat.split(":")) {
            ComponentName cn = ComponentName.unflattenFromString(name);
            if (cn != null && pkg.equals(cn.getPackageName())) return true;
        }
        return false;
    }
}
