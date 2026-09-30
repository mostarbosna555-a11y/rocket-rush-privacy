package com.guardface.sentinel

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat

/** Restarts protection after the phone reboots. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            if (Settings(context).protectionEnabled) {
                ContextCompat.startForegroundService(
                    context,
                    Intent(context, SentinelService::class.java)
                )
            }
        }
    }
}
