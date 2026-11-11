package org.effort.publicdemo;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.text.TextUtils;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.List;

/**
 * Android receives an ACTION_SEND text share and opens the same local
 * ?share= intake path used by the browser service-worker share target.
 */
public class MainActivity extends BridgeActivity {
    private boolean shareHandled = false;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        handleShareIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        shareHandled = false;
        handleShareIntent(intent);
    }

    @Override
    protected void onResume() {
        super.onResume();
        handleShareIntent(getIntent());
    }

    private void handleShareIntent(Intent intent) {
        if (shareHandled || intent == null || !Intent.ACTION_SEND.equals(intent.getAction())
                || !"text/plain".equals(intent.getType())) return;
        String text = sharedText(intent);
        if (text.isEmpty()) return;
        String encoded = Uri.encode(text);
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null) return;
        shareHandled = true;
        webView.loadUrl("https://localhost/public/?share=" + encoded);
    }

    private String sharedText(Intent intent) {
        List<String> parts = new ArrayList<>();
        String title = intent.getStringExtra(Intent.EXTRA_TITLE);
        String body = intent.getStringExtra(Intent.EXTRA_TEXT);
        if (!TextUtils.isEmpty(title)) parts.add(title);
        if (!TextUtils.isEmpty(body)) parts.add(body);
        String joined = TextUtils.join("\n\n", parts);
        // Match the browser target's bounded, text-only capture contract.
        return joined.length() <= 4000 ? joined : joined.substring(0, 4000);
    }
}
