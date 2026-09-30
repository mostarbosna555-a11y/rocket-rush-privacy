package com.guardface.sentinel

import android.content.Context

/**
 * Tiny persistence layer over SharedPreferences.
 * Holds the owner's face signature, the alert email, and the SMTP sender credentials.
 */
class Settings(context: Context) {

    private val prefs = context.getSharedPreferences("guardface", Context.MODE_PRIVATE)

    var alertEmail: String
        get() = prefs.getString("alert_email", "") ?: ""
        set(v) = prefs.edit().putString("alert_email", v).apply()

    var smtpUser: String
        get() = prefs.getString("smtp_user", "") ?: ""
        set(v) = prefs.edit().putString("smtp_user", v).apply()

    var smtpPass: String
        get() = prefs.getString("smtp_pass", "") ?: ""
        set(v) = prefs.edit().putString("smtp_pass", v).apply()

    var protectionEnabled: Boolean
        get() = prefs.getBoolean("protection", false)
        set(v) = prefs.edit().putBoolean("protection", v).apply()

    /** Owner face signature stored as a comma separated float vector. Empty = not enrolled. */
    var ownerSignature: FloatArray?
        get() {
            val raw = prefs.getString("owner_sig", "") ?: ""
            if (raw.isBlank()) return null
            return raw.split(",").mapNotNull { it.toFloatOrNull() }.toFloatArray()
        }
        set(v) {
            val raw = v?.joinToString(",") { it.toString() } ?: ""
            prefs.edit().putString("owner_sig", raw).apply()
        }

    val isEnrolled: Boolean get() = ownerSignature != null

    val isConfigured: Boolean
        get() = alertEmail.isNotBlank() && smtpUser.isNotBlank() &&
                smtpPass.isNotBlank() && isEnrolled
}
