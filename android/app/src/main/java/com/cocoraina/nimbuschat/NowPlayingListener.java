package com.cocoraina.nimbuschat;

import android.service.notification.NotificationListenerService;

/**
 * Intentionally-empty notification-listener service.
 *
 * We never actually read any notifications here. Its sole purpose is to let
 * this app become an *enabled notification listener*, which is the gate
 * Android requires before MediaSessionManager.getActiveSessions() will hand
 * back other apps' media sessions. Those sessions give us:
 *   - now-playing metadata (title / artist / album / position) for the
 *     get_now_playing tool, and
 *   - precise transport controls (play/pause/next) for control_media, which
 *     are more reliable than broadcasting a global media key.
 *
 * The user grants this once in Settings → 通知使用权
 * (Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS). Until then the media
 * tools fall back gracefully (control_media uses media-key broadcast,
 * get_now_playing reports NO_PERMISSION).
 */
public class NowPlayingListener extends NotificationListenerService {
}
