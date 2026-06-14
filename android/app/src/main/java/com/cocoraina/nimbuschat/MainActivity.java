package com.cocoraina.nimbuschat;

import android.content.Intent;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(UsageStatsPlugin.class);
        registerPlugin(ShareReceiverPlugin.class);
        registerPlugin(PeriodWidgetPlugin.class);
        registerPlugin(MediaControlPlugin.class);
        super.onCreate(savedInstanceState);
        handleShareIntent(getIntent());
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleShareIntent(intent);
    }

    private void handleShareIntent(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) {
            return;
        }
        String type = intent.getType();
        if (type == null) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (text == null || text.trim().isEmpty()) return;
        String title = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        if (title == null) title = intent.getStringExtra(Intent.EXTRA_TITLE);
        ShareReceiverPlugin.setPendingShare(title, text.trim());
    }
}
