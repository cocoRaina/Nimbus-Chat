package com.cocoraina.nimbuschat;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.media.AudioDeviceInfo;
import android.media.AudioManager;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Reads lightweight, low-sensitivity ambient phone state for the AI context:
 *   - ringer mode (silent / vibrate / normal)
 *   - audio output route (phone speaker / wired / bluetooth) + the bluetooth
 *     device's advertised name so the model can tell earbuds from a car stereo
 *   - whether the active network is Wi-Fi vs cellular (just the transport, never
 *     the SSID — by the user's choice we only report "connected to Wi-Fi or not")
 *
 * All synchronous system-service reads: no background work, no polling, no
 * network. Injected into the chat prompt like the weather snapshot so the
 * companion feels present ("戴耳机听歌呢？" / "在车上？慢点开").
 *
 * The bluetooth device NAME needs BLUETOOTH_CONNECT (Android 12+). Without the
 * grant we still report that bluetooth audio is connected, just unnamed, and
 * the prompt degrades to a plain "蓝牙音频".
 */
@CapacitorPlugin(
    name = "EnvState",
    permissions = {
        @Permission(alias = "bluetooth", strings = { Manifest.permission.BLUETOOTH_CONNECT })
    }
)
public class EnvStatePlugin extends Plugin {

    /** Request BLUETOOTH_CONNECT (needed to read the BT device name). No-op
     *  below Android 12 where it isn't a runtime permission. */
    @PluginMethod
    public void requestBluetooth(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                || getPermissionState("bluetooth") == PermissionState.GRANTED) {
            JSObject ret = new JSObject();
            ret.put("granted", true);
            call.resolve(ret);
            return;
        }
        requestPermissionForAlias("bluetooth", call, "btPermCallback");
    }

    @PermissionCallback
    private void btPermCallback(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", getPermissionState("bluetooth") == PermissionState.GRANTED);
        call.resolve(ret);
    }

    @PluginMethod
    public void get(PluginCall call) {
        Context ctx = getContext();
        JSObject ret = new JSObject();

        // --- Ringer mode -------------------------------------------------
        String ringer = "normal";
        try {
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                switch (am.getRingerMode()) {
                    case AudioManager.RINGER_MODE_SILENT:  ringer = "silent";  break;
                    case AudioManager.RINGER_MODE_VIBRATE: ringer = "vibrate"; break;
                    default:                                ringer = "normal";  break;
                }
            }
        } catch (Exception ignored) {}
        ret.put("ringer", ringer);

        // --- Audio output route + bluetooth name -------------------------
        String audio = "speaker";
        String btName = null;
        try {
            AudioManager am = (AudioManager) ctx.getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                boolean wired = false, bt = false;
                for (AudioDeviceInfo d : am.getDevices(AudioManager.GET_DEVICES_OUTPUTS)) {
                    int t = d.getType();
                    if (t == AudioDeviceInfo.TYPE_WIRED_HEADPHONES
                            || t == AudioDeviceInfo.TYPE_WIRED_HEADSET) {
                        wired = true;
                    } else if (t == AudioDeviceInfo.TYPE_BLUETOOTH_A2DP
                            || t == AudioDeviceInfo.TYPE_BLUETOOTH_SCO) {
                        bt = true;
                        // getProductName() is API 30 (Android 11)+. minSdk is 26,
                        // so guard it — calling it on 8–10 (common on older
                        // Huawei) would NoSuchMethodError. Below 30 we just
                        // report unnamed "蓝牙音频".
                        if (btName == null && hasBluetoothPerm()
                                && Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                            CharSequence name = d.getProductName();
                            if (name != null) {
                                String n = name.toString().trim();
                                // Drop the generic phone-model fallback Android
                                // hands back when it can't read the real name.
                                if (!n.isEmpty() && !n.equalsIgnoreCase(Build.MODEL)) {
                                    btName = n;
                                }
                            }
                        }
                    }
                }
                if (bt) audio = "bluetooth";
                else if (wired) audio = "wired";
            }
        } catch (Exception ignored) {}
        ret.put("audio", audio);
        if (btName != null) ret.put("btName", btName);

        // --- Network transport (Wi-Fi vs cellular; no SSID) --------------
        String network = "none";
        try {
            ConnectivityManager cm =
                (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm != null) {
                Network active = cm.getActiveNetwork();
                NetworkCapabilities caps = active == null ? null : cm.getNetworkCapabilities(active);
                if (caps != null) {
                    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)) {
                        network = "wifi";
                    } else if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) {
                        network = "cellular";
                    } else {
                        network = "other";
                    }
                }
            }
        } catch (Exception ignored) {}
        ret.put("network", network);

        call.resolve(ret);
    }

    private boolean hasBluetoothPerm() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        return getContext().checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)
                == PackageManager.PERMISSION_GRANTED;
    }
}
