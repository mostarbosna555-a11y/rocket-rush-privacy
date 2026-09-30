package com.guardface.sentinel

import android.Manifest
import android.app.admin.DevicePolicyManager
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.os.Build
import android.os.Bundle
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.core.Preview
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.guardface.sentinel.databinding.ActivityMainBinding
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : AppCompatActivity() {

    private lateinit var ui: ActivityMainBinding
    private lateinit var settings: Settings
    private var imageCapture: ImageCapture? = null

    private val permLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { startCamera() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        ui = ActivityMainBinding.inflate(layoutInflater)
        setContentView(ui.root)
        settings = Settings(this)

        // Prefill saved settings.
        ui.inEmail.setText(settings.alertEmail)
        ui.inSmtpUser.setText(settings.smtpUser)
        ui.inSmtpPass.setText(settings.smtpPass)

        ui.btnSave.setOnClickListener { saveSettings() }
        ui.btnEnroll.setOnClickListener { enrollFace() }
        ui.btnAdmin.setOnClickListener { requestDeviceAdmin() }
        ui.btnStart.setOnClickListener { startProtection() }
        ui.btnTest.setOnClickListener { runTest() }

        requestPerms()
        refreshStatus()
    }

    private fun requestPerms() {
        val perms = mutableListOf(Manifest.permission.CAMERA)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            perms.add(Manifest.permission.POST_NOTIFICATIONS)
        }
        val missing = perms.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) startCamera() else permLauncher.launch(missing.toTypedArray())
    }

    private fun startCamera() {
        val future = ProcessCameraProvider.getInstance(this)
        future.addListener({
            try {
                val provider = future.get()
                val preview = Preview.Builder().build().also {
                    it.setSurfaceProvider(ui.preview.surfaceProvider)
                }
                imageCapture = ImageCapture.Builder()
                    .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                    .build()
                provider.unbindAll()
                provider.bindToLifecycle(
                    this, CameraSelector.DEFAULT_FRONT_CAMERA, preview, imageCapture
                )
            } catch (e: Exception) {
                toast("Camera error: ${e.message}")
            }
        }, ContextCompat.getMainExecutor(this))
    }

    private fun saveSettings() {
        settings.alertEmail = ui.inEmail.text.toString().trim()
        settings.smtpUser = ui.inSmtpUser.text.toString().trim()
        settings.smtpPass = ui.inSmtpPass.text.toString().trim()
        toast("Settings saved")
        refreshStatus()
    }

    private fun enrollFace() {
        val capture = imageCapture ?: run { toast("Camera not ready"); return }
        toast("Hold still…")
        capture.takePicture(
            ContextCompat.getMainExecutor(this),
            object : ImageCapture.OnImageCapturedCallback() {
                override fun onCaptureSuccess(image: ImageProxy) {
                    val bmp = image.toBitmap()
                    image.close()
                    lifecycleScope.launch {
                        val sig = withContext(Dispatchers.Default) { FaceEngine.signatureFor(bmp) }
                        if (sig == null) {
                            toast("No face detected — try again, face the camera")
                        } else {
                            settings.ownerSignature = sig
                            toast("✅ Face enrolled")
                            refreshStatus()
                        }
                    }
                }

                override fun onError(exc: ImageCaptureException) {
                    toast("Capture failed: ${exc.message}")
                }
            }
        )
    }

    private fun requestDeviceAdmin() {
        val admin = ComponentName(this, AdminReceiver::class.java)
        val dpm = getSystemService(DEVICE_POLICY_SERVICE) as DevicePolicyManager
        if (dpm.isAdminActive(admin)) {
            toast("Device admin already enabled")
            return
        }
        val intent = Intent(DevicePolicyManager.ACTION_ADD_DEVICE_ADMIN).apply {
            putExtra(DevicePolicyManager.EXTRA_DEVICE_ADMIN, admin)
            putExtra(
                DevicePolicyManager.EXTRA_ADD_EXPLANATION,
                "GuardFace needs admin rights so it can lock your phone the moment an intruder is detected."
            )
        }
        startActivity(intent)
    }

    private fun startProtection() {
        if (!settings.isConfigured) {
            toast("Finish setup first: email, sender, and enroll your face")
            return
        }
        val admin = ComponentName(this, AdminReceiver::class.java)
        val dpm = getSystemService(DEVICE_POLICY_SERVICE) as DevicePolicyManager
        if (!dpm.isAdminActive(admin)) {
            toast("Enable Device Admin first")
            return
        }
        settings.protectionEnabled = true
        ContextCompat.startForegroundService(this, Intent(this, SentinelService::class.java))
        toast("🛡️ Protection started")
        refreshStatus()
    }

    private fun runTest() {
        if (!settings.isEnrolled) { toast("Enroll your face first"); return }
        toast("Running intruder check…")
        lifecycleScope.launch {
            Guardian.runIntruderCheck(applicationContext, "manual_test")
            toast("Test done — check logcat / your email if it flagged an intruder")
        }
    }

    private fun refreshStatus() {
        val admin = ComponentName(this, AdminReceiver::class.java)
        val dpm = getSystemService(DEVICE_POLICY_SERVICE) as DevicePolicyManager
        val parts = listOf(
            if (settings.isEnrolled) "face ✓" else "face ✗",
            if (settings.alertEmail.isNotBlank()) "email ✓" else "email ✗",
            if (dpm.isAdminActive(admin)) "admin ✓" else "admin ✗",
            if (settings.protectionEnabled) "PROTECTING" else "idle"
        )
        ui.status.text = "Status: " + parts.joinToString("  ·  ")
    }

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    private fun ImageProxy.toBitmap(): Bitmap {
        val buffer = planes[0].buffer
        val bytes = ByteArray(buffer.remaining())
        buffer.get(bytes)
        var bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        val rotation = imageInfo.rotationDegrees
        if (rotation != 0) {
            val m = Matrix().apply { postRotate(rotation.toFloat()) }
            bmp = Bitmap.createBitmap(bmp, 0, 0, bmp.width, bmp.height, m, true)
        }
        return bmp
    }
}
