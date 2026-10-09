package com.rocketrush.fakecasino;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

public class MainActivity extends Activity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#0e0b1f"));

        WebView web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#0e0b1f"));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // keeps the fake balance between launches
        setContentView(web);
        web.loadUrl("file:///android_asset/index.html");
    }
}
