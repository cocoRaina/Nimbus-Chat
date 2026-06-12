package com.cocoraina.nimbuschat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;

/**
 * Receives ACTION_SEND intents from other apps (share sheet).
 * The intent text is captured by MainActivity and stored in a queue;
 * this plugin exposes it to JavaScript on next app foreground.
 */
@CapacitorPlugin(name = "ShareReceiver")
public class ShareReceiverPlugin extends Plugin {
    private static final List<String> pendingShareTexts = new ArrayList<>();
    private static final List<String> pendingShareTitles = new ArrayList<>();

    public static synchronized void setPendingShare(String title, String text) {
        pendingShareTitles.add(title != null ? title : "");
        pendingShareTexts.add(text);
    }

    @PluginMethod
    public synchronized void getPendingShare(PluginCall call) {
        JSObject ret = new JSObject();
        if (!pendingShareTexts.isEmpty()) {
            ret.put("text", pendingShareTexts.remove(0));
            ret.put("title", pendingShareTitles.remove(0));
        } else {
            ret.put("text", (String) null);
            ret.put("title", "");
        }
        call.resolve(ret);
    }
}
