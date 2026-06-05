package com.cocoraina.nimbuschat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Receives ACTION_SEND intents from other apps (share sheet).
 * The intent text is captured by MainActivity and stored in a static
 * field; this plugin exposes it to JavaScript on next app foreground.
 */
@CapacitorPlugin(name = "ShareReceiver")
public class ShareReceiverPlugin extends Plugin {
    private static volatile String pendingShareText = null;
    private static volatile String pendingShareTitle = null;

    public static void setPendingShare(String title, String text) {
        pendingShareTitle = title;
        pendingShareText = text;
    }

    @PluginMethod
    public void getPendingShare(PluginCall call) {
        JSObject ret = new JSObject();
        String text = pendingShareText;
        String title = pendingShareTitle;
        if (text != null) {
            ret.put("text", text);
            ret.put("title", title != null ? title : "");
            pendingShareText = null;
            pendingShareTitle = null;
        } else {
            ret.put("text", (String) null);
            ret.put("title", "");
        }
        call.resolve(ret);
    }
}
