package com.guardface.sentinel

import android.app.admin.DeviceAdminReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

/**
 * Device-admin hook. When Android reports a FAILED unlock attempt (wrong PIN / pattern /
 * password) it calls [onPasswordFailed] — that is our cue that someone who isn't the owner may
 * be poking at the lock screen, so we run an intruder check.
 */
class AdminReceiver : DeviceAdminReceiver() {

    override fun onEnabled(context: Context, intent: Intent) {
        Log.d("GuardFace", "device admin enabled")
    }

    override fun onPasswordFailed(context: Context, intent: Intent) {
        Log.d("GuardFace", "password failed -> intruder check")
        CoroutineScope(Dispatchers.Default).launch {
            Guardian.runIntruderCheck(context.applicationContext, "password_failed")
        }
    }

    override fun onDisableRequested(context: Context, intent: Intent): CharSequence {
        return "Disabling GuardFace admin will stop anti-theft protection and unlock the phone's guard."
    }
}
