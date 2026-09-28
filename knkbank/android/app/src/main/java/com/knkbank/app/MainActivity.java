package com.knkbank.app;

import android.Manifest;
import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.webkit.JavascriptInterface;
import android.webkit.WebSettings;
import android.webkit.WebView;

public class MainActivity extends Activity {
    private static final String CHANNEL_ID = "maas";
    private final Handler handler = new Handler(Looper.getMainLooper());
    private int notificationId = 1;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        createChannel();
        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, 1);
        }

        WebView web = new WebView(this);
        web.setBackgroundColor(0xFF0D0620);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        web.addJavascriptInterface(new Bridge(), "KnkNative");
        web.loadUrl("file:///android_asset/index.html");
        setContentView(web);
    }

    private void createChannel() {
        NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Hesap hareketleri",
                NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("Maaş yattı bildirimleri");
        ch.enableVibration(true);
        getSystemService(NotificationManager.class).createNotificationChannel(ch);
    }

    private void postNotification(String title, String body) {
        Intent open = new Intent(this, MainActivity.class);
        PendingIntent pi = PendingIntent.getActivity(this, 0, open,
                PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_stat_bank)
                .setColor(0xFF7B2FF7)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new Notification.BigTextStyle().bigText(body))
                .setContentIntent(pi)
                .setAutoCancel(true)
                .build();
        getSystemService(NotificationManager.class).notify(notificationId++, n);
    }

    private class Bridge {
        @JavascriptInterface
        public void notify(String title, String body, long delayMs) {
            handler.postDelayed(() -> postNotification(title, body), Math.max(0, delayMs));
        }
    }
}
