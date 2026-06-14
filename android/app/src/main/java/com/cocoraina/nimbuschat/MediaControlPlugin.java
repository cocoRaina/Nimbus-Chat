package com.cocoraina.nimbuschat;

import android.content.Context;
import android.media.AudioManager;
import android.view.KeyEvent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "MediaControl")
public class MediaControlPlugin extends Plugin {

    @PluginMethod
    public void control(PluginCall call) {
        String action = call.getString("action", "pause");
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
        call.resolve(result);
    }
}
