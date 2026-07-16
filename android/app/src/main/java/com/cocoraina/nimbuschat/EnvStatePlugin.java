package com.cocoraina.nimbuschat;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
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
 *   - ambient light level (lux) so the companion can tell lights-off darkness
 *     from daylight ("灯都关了还刷手机？该睡了")
 *
 * All synchronous system-service reads: no background work, no polling, no
 * network. Injected into the chat prompt like the weather snapshot so the
 * companion feels present ("戴耳机听歌呢？" / "在车上？慢点开").
 *
 * Light sensor lifecycle: the light sensor is event-driven (no synchronous
 * "read now" API), so a listener registered on foreground caches the latest
 * lux into a volatile field that get() reads instantly. Registered in
 * handleOnResume / unregistered in handleOnPause — zero battery cost while
 * backgrounded, and the light sensor itself is one of the cheapest sensors
 * on the SoC. Devices without the sensor simply never populate the field.
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

    // Latest ambient light reading in lux; -1 = no reading yet (sensor absent,
    // or first event hasn't arrived). Written on the sensor thread, read on the
    // Capacitor thread — volatile is all the sync a single float needs.
    private volatile float lastLux = -1f;
    private SensorManager sensorManager;
    private Sensor lightSensor;
    private final SensorEventListener lightListener = new SensorEventListener() {
        @Override
        public void onSensorChanged(SensorEvent event) {
            if (event.values != null && event.values.length > 0) {
                lastLux = event.values[0];
            }
        }

        @Override
        public void onAccuracyChanged(Sensor sensor, int accuracy) {}
    };

    @Override
    public void load() {
        try {
            sensorManager = (SensorManager) getContext().getSystemService(Context.SENSOR_SERVICE);
            if (sensorManager != null) {
                lightSensor = sensorManager.getDefaultSensor(Sensor.TYPE_LIGHT);
            }
        } catch (Exception ignored) {}
        registerLightListener();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        registerLightListener();
    }

    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        try {
            if (sensorManager != null) sensorManager.unregisterListener(lightListener);
        } catch (Exception ignored) {}
        // Stale darkness from inside a pocket shouldn't survive into the next
        // foreground — drop the cached value; resume re-registers and the
        // sensor re-delivers the current level within a frame or two.
        lastLux = -1f;
    }

    private void registerLightListener() {
        try {
            if (sensorManager != null && lightSensor != null) {
                sensorManager.registerListener(
                    lightListener, lightSensor, SensorManager.SENSOR_DELAY_NORMAL);
            }
        } catch (Exception ignored) {}
    }

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

        // --- Ambient light (lux) ------------------------------------------
        float lux = lastLux;
        if (lux >= 0f) {
            ret.put("lux", (double) lux);
        }

        call.resolve(ret);
    }

    private boolean hasBluetoothPerm() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true;
        return getContext().checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)
                == PackageManager.PERMISSION_GRANTED;
    }
}
