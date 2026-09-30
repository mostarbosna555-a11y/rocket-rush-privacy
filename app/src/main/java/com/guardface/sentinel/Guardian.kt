package com.guardface.sentinel

import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * The brain of the app. Runs one "intruder check":
 *   1. take a silent front-camera photo of whoever is holding the phone
 *   2. turn it into a face signature and compare with the enrolled owner
 *   3. if it is NOT the owner (or no face at all) -> lock the phone + email the photo to the owner
 *
 * Everything the platform allows a normal app to do. It CANNOT power the phone off (that needs
 * root / a system app), so the strongest lawful response is an immediate device-admin lock.
 */
object Guardian {

    private const val TAG = "GuardFace"

    suspend fun runIntruderCheck(context: Context, reason: String) = withContext(Dispatchers.Default) {
        val settings = Settings(context)
        val owner = settings.ownerSignature
        if (!settings.protectionEnabled || owner == null) {
            Log.d(TAG, "check skipped ($reason): protection off or not enrolled")
            return@withContext
        }

        val photo = try {
            IntruderCamera(context).capture()
        } catch (e: Exception) {
            Log.e(TAG, "camera capture failed", e)
            null
        }

        // No usable photo -> we cannot verify, so we do nothing (avoid locking the owner out on a glitch).
        if (photo == null) return@withContext

        val candidate = FaceEngine.signatureFor(photo)
        val similarity = if (candidate != null) FaceEngine.similarity(owner, candidate) else 0f
        val isOwner = candidate != null && FaceEngine.isOwner(owner, candidate)

        Log.d(TAG, "check ($reason): faceFound=${candidate != null} similarity=$similarity isOwner=$isOwner")

        if (isOwner) return@withContext  // it's you — do nothing

        // ---- INTRUDER ----
        lockPhone(context)

        if (settings.alertEmail.isNotBlank() && settings.smtpUser.isNotBlank()) {
            try {
                MailSender.sendIntruderAlert(
                    smtpUser = settings.smtpUser,
                    smtpPass = settings.smtpPass,
                    toEmail = settings.alertEmail,
                    photo = photo,
                    similarityPct = (similarity * 100).toInt()
                )
                Log.d(TAG, "intruder alert emailed to ${settings.alertEmail}")
            } catch (e: Exception) {
                Log.e(TAG, "email send failed", e)
            }
        }
    }

    fun lockPhone(context: Context) {
        val dpm = context.getSystemService(Context.DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val admin = ComponentName(context, AdminReceiver::class.java)
        if (dpm.isAdminActive(admin)) {
            try {
                dpm.lockNow()
                Log.d(TAG, "device locked")
            } catch (e: SecurityException) {
                Log.e(TAG, "lockNow denied", e)
            }
        } else {
            Log.w(TAG, "cannot lock: device admin not active")
        }
    }
}
