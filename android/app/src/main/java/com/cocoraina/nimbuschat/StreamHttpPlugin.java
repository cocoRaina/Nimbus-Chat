package com.cocoraina.nimbuschat;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Native streaming HTTP for the chat request — the ONE thing CapacitorHttp
 * can't do.
 *
 * Why this exists: capacitor.config has CapacitorHttp enabled so relay calls
 * bypass the WebView CORS wall (most 中转 don't allow the https://localhost
 * origin). But CapacitorHttp's patched fetch BUFFERS the whole response before
 * handing it to JS — it never streams. That made chat replies (thinking + text)
 * arrive as one lump after a long blank "正在输入…", on every provider, because
 * the breakage was at the native-HTTP layer, not the relay.
 *
 * This plugin does its own native HTTP (HttpURLConnection, chunked read) so it
 * BOTH bypasses CORS (native layer, no WebView origin enforcement) AND streams
 * the body chunk-by-chunk back to JS via listener events. JS wraps those events
 * in a ReadableStream Response (see src/native/streamHttp.ts), so the existing
 * SSE parser is unchanged. It's a direct plugin call, not window.fetch, so
 * CapacitorHttp doesn't intercept it — the two coexist cleanly.
 *
 * Contract (JS side generates streamId to correlate events):
 *   startStream({ streamId, url, method, headers, body }) -> { status, headers }
 *     then emits: "streamChunk" { streamId, chunk(base64) }
 *                 "streamEnd"   { streamId }
 *                 "streamError" { streamId, error }
 *   cancelStream({ streamId })
 *
 * Chunks are base64 of the RAW bytes (not a decoded string): a UTF-8 multibyte
 * char can straddle a read boundary, so we never decode natively — JS does it
 * with a streaming TextDecoder that handles partial sequences.
 */
@CapacitorPlugin(name = "StreamHttp")
public class StreamHttpPlugin extends Plugin {

    // Live connections, keyed by the JS-supplied streamId, so cancelStream can
    // abort the right one. A request also flips its own cancelled flag.
    private final Map<String, HttpURLConnection> connections = new ConcurrentHashMap<>();
    private final Map<String, Boolean> cancelled = new ConcurrentHashMap<>();

    @PluginMethod
    public void startStream(final PluginCall call) {
        final String streamId = call.getString("streamId");
        final String url = call.getString("url");
        if (streamId == null || url == null) {
            call.reject("streamId and url are required");
            return;
        }
        final String method = call.getString("method", "POST");
        final JSObject headers = call.getObject("headers");
        final String body = call.getString("body");

        cancelled.put(streamId, false);

        // Network must be off the main thread.
        new Thread(new Runnable() {
            @Override
            public void run() {
                HttpURLConnection conn = null;
                // Tracks whether startStream's promise has been settled, so the
                // catch can decide between rejecting the await vs emitting an
                // error event (PluginCall has no portable isResolved()).
                boolean[] resolved = { false };
                try {
                    conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setRequestMethod(method);
                    conn.setConnectTimeout(30000);
                    // No read timeout: a streaming relay can sit quiet between
                    // tokens (esp. during extended thinking) without it being a
                    // hang. The JS-side stall watchdog handles real stalls.
                    conn.setReadTimeout(0);
                    conn.setDoInput(true);
                    // Disable gzip: HttpURLConnection auto-negotiates
                    // Accept-Encoding: gzip and transparently decompresses, but
                    // the gzip decompressor buffers the ENTIRE compressed stream
                    // before outputting anything — SSE chunks are held until the
                    // server closes the connection (exactly the "一大坨" symptom
                    // we're trying to fix). Forcing identity encoding means the
                    // relay sends raw bytes that stream through immediately.
                    conn.setRequestProperty("Accept-Encoding", "identity");

                    if (headers != null) {
                        Iterator<String> keys = headers.keys();
                        while (keys.hasNext()) {
                            String k = keys.next();
                            conn.setRequestProperty(k, headers.optString(k));
                        }
                    }

                    if (body != null && !"GET".equalsIgnoreCase(method)) {
                        conn.setDoOutput(true);
                        byte[] out = body.getBytes(StandardCharsets.UTF_8);
                        conn.setFixedLengthStreamingMode(out.length);
                        OutputStream os = conn.getOutputStream();
                        os.write(out);
                        os.flush();
                        os.close();
                    }

                    conn.connect();
                    connections.put(streamId, conn);

                    int status = conn.getResponseCode();

                    // Hand back status + response headers immediately so JS can
                    // build the Response (content-type drives the SSE path).
                    JSObject respHeaders = new JSObject();
                    for (Map.Entry<String, List<String>> e : conn.getHeaderFields().entrySet()) {
                        if (e.getKey() == null || e.getValue() == null || e.getValue().isEmpty()) continue;
                        respHeaders.put(e.getKey().toLowerCase(), e.getValue().get(0));
                    }
                    JSObject ret = new JSObject();
                    ret.put("status", status);
                    ret.put("headers", respHeaders);
                    call.resolve(ret);
                    resolved[0] = true;

                    InputStream is = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
                    if (is == null) {
                        emitEnd(streamId);
                        return;
                    }

                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = is.read(buf)) != -1) {
                        if (Boolean.TRUE.equals(cancelled.get(streamId))) break;
                        if (n == 0) continue;
                        JSObject ev = new JSObject();
                        ev.put("streamId", streamId);
                        ev.put("chunk", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP));
                        notifyListeners("streamChunk", ev);
                    }
                    is.close();
                    emitEnd(streamId);
                } catch (Exception ex) {
                    if (Boolean.TRUE.equals(cancelled.get(streamId))) {
                        // Aborted by JS (user pressed stop / new stream) — not an
                        // error worth surfacing; the JS side already moved on.
                        emitEnd(streamId);
                    } else {
                        // If startStream hasn't resolved yet, reject it so the JS
                        // caller's await throws; if it has, surface via the error
                        // event instead (the ReadableStream errors mid-flight).
                        if (!resolved[0]) {
                            call.reject(ex.getMessage() != null ? ex.getMessage() : "stream failed");
                        }
                        JSObject ev = new JSObject();
                        ev.put("streamId", streamId);
                        ev.put("error", ex.getMessage() != null ? ex.getMessage() : "stream failed");
                        notifyListeners("streamError", ev);
                    }
                } finally {
                    if (conn != null) {
                        try { conn.disconnect(); } catch (Exception ignored) {}
                    }
                    connections.remove(streamId);
                    cancelled.remove(streamId);
                }
            }
        }).start();
    }

    @PluginMethod
    public void cancelStream(PluginCall call) {
        String streamId = call.getString("streamId");
        if (streamId != null) {
            cancelled.put(streamId, true);
            HttpURLConnection conn = connections.get(streamId);
            if (conn != null) {
                try { conn.disconnect(); } catch (Exception ignored) {}
            }
        }
        call.resolve();
    }

    private void emitEnd(String streamId) {
        JSObject ev = new JSObject();
        ev.put("streamId", streamId);
        notifyListeners("streamEnd", ev);
    }
}
