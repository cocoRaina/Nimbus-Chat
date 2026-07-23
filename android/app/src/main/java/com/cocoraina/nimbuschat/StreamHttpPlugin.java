package com.cocoraina.nimbuschat;

import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.io.InputStream;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.TimeUnit;

import okhttp3.Call;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

/**
 * Native streaming HTTP for the chat request — the ONE thing CapacitorHttp
 * can't do (it buffers window.fetch entirely, killing SSE streaming).
 *
 * v2: switched from HttpURLConnection to OkHttp.
 * HttpURLConnection had two fatal flaws for SSE on Android:
 *   1. Auto-adds Accept-Encoding: gzip. The gzip decompressor buffers the
 *      ENTIRE compressed stream before outputting anything — no chunks
 *      arrive until the LLM finishes and the server closes the connection.
 *   2. On HTTP/2, Android's built-in H2 framing can batch DATA frames,
 *      causing similar stalls independent of gzip.
 * OkHttp handles both correctly out of the box. Its ResponseBody.byteStream()
 * delivers bytes as they arrive off the socket.
 *
 * Contract (unchanged from v1 — JS side is identical):
 *   startStream({ streamId, url, method, headers, body }) → { status, headers }
 *     then emits: "streamChunk" { streamId, chunk(base64) }
 *                 "streamEnd"   { streamId }
 *                 "streamError" { streamId, error }
 *   cancelStream({ streamId })
 */
@CapacitorPlugin(name = "StreamHttp")
public class StreamHttpPlugin extends Plugin {

    private final OkHttpClient httpClient = new OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            // No read timeout: a streaming relay can sit quiet between tokens
            // (esp. during extended thinking). JS-side stall watchdog handles stalls.
            .readTimeout(0, TimeUnit.MILLISECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            // 关掉 OkHttp 默认的连接失败自动重试(2026-07-23)。默认 true 时,连接
            // 一抖 OkHttp 会在 Java 层把整个请求**静默重发**——JS 完全看不见,也不受
            // JS 层首字节超时管。对慢中转(连接开得久、更易抖),重发的那一份已经到了
            // 中转、被计费,于是账面凭空翻倍「幽灵」(real 32k → 账面 65k),而服务器
            // 单请求探针复现不出。按 token 计费的 App 绝不能让 HTTP 层偷偷重发;
            // 真的连接失败交给 JS 层的缓冲兜底 + 用户可见的重发提示,不做静默重试。
            .retryOnConnectionFailure(false)
            .build();

    // Live OkHttp calls keyed by streamId so cancelStream can reach them.
    private final Map<String, Call> activeCalls = new ConcurrentHashMap<>();

    @PluginMethod
    public void startStream(final PluginCall pluginCall) {
        final String streamId = pluginCall.getString("streamId");
        final String url = pluginCall.getString("url");
        if (streamId == null || url == null) {
            pluginCall.reject("streamId and url are required");
            return;
        }
        final String method = pluginCall.getString("method", "POST");
        final JSObject headers = pluginCall.getObject("headers");
        final String body = pluginCall.getString("body");

        new Thread(() -> {
            // Tracks whether startStream's JS promise has been settled, so the
            // IOException catch can decide between reject (not yet resolved) vs
            // streamError event (already resolved, mid-stream failure).
            boolean[] resolved = { false };
            Call call = null;
            try {
                Request.Builder reqBuilder = new Request.Builder().url(url);

                // Copy caller-supplied headers first, then override Accept-Encoding
                // so the relay can't send gzip even if our headers include it.
                if (headers != null) {
                    Iterator<String> keys = headers.keys();
                    while (keys.hasNext()) {
                        String k = keys.next();
                        String v = headers.optString(k);
                        if (v != null && !v.isEmpty()) {
                            reqBuilder.header(k, v);
                        }
                    }
                }
                // Force identity encoding: gzip decompressors buffer the ENTIRE
                // compressed stream before outputting — kills SSE streaming.
                reqBuilder.header("Accept-Encoding", "identity");

                // Build request body (POST only).
                RequestBody requestBody = null;
                if (body != null && !"GET".equalsIgnoreCase(method)) {
                    requestBody = RequestBody.create(
                            body.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                            MediaType.parse("application/json; charset=utf-8"));
                }
                reqBuilder.method(method, requestBody);

                call = httpClient.newCall(reqBuilder.build());
                // Register before execute() so cancelStream can reach it at any point.
                activeCalls.put(streamId, call);

                try (Response response = call.execute()) {
                    // Resolve the startStream JS promise with status + response headers.
                    JSObject respHeaders = new JSObject();
                    for (String name : response.headers().names()) {
                        String value = response.header(name);
                        if (value != null) respHeaders.put(name.toLowerCase(), value);
                    }
                    JSObject ret = new JSObject();
                    ret.put("status", response.code());
                    ret.put("headers", respHeaders);
                    pluginCall.resolve(ret);
                    resolved[0] = true;

                    ResponseBody responseBody = response.body();
                    if (responseBody == null) {
                        emitEnd(streamId);
                        return;
                    }

                    // Stream body bytes to JS as base64 chunks.
                    // OkHttp's byteStream() delivers bytes as they arrive off the
                    // socket — no buffering, no gzip decompressor stall.
                    InputStream is = responseBody.byteStream();
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = is.read(buf)) != -1) {
                        if (n == 0) continue;
                        JSObject ev = new JSObject();
                        ev.put("streamId", streamId);
                        ev.put("chunk", Base64.encodeToString(buf, 0, n, Base64.NO_WRAP));
                        notifyListeners("streamChunk", ev);
                    }
                    emitEnd(streamId);
                }

            } catch (IOException ex) {
                // OkHttp throws IOException on cancel — not a user-visible error.
                if (call != null && call.isCanceled()) {
                    emitEnd(streamId);
                    return;
                }
                // Real network/protocol failure.
                String msg = ex.getMessage() != null ? ex.getMessage() : "stream failed";
                if (!resolved[0]) {
                    pluginCall.reject(msg);
                }
                JSObject ev = new JSObject();
                ev.put("streamId", streamId);
                ev.put("error", msg);
                notifyListeners("streamError", ev);
            } finally {
                activeCalls.remove(streamId);
            }
        }).start();
    }

    @PluginMethod
    public void cancelStream(PluginCall pluginCall) {
        String streamId = pluginCall.getString("streamId");
        if (streamId != null) {
            Call call = activeCalls.get(streamId);
            if (call != null) call.cancel();
        }
        pluginCall.resolve();
    }

    private void emitEnd(String streamId) {
        JSObject ev = new JSObject();
        ev.put("streamId", streamId);
        notifyListeners("streamEnd", ev);
    }
}
