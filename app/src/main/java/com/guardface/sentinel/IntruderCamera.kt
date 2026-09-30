package com.guardface.sentinel

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import androidx.camera.core.CameraSelector
import androidx.camera.core.ImageCapture
import androidx.camera.core.ImageCaptureException
import androidx.camera.core.ImageProxy
import androidx.camera.lifecycle.ProcessCameraProvider
import androidx.core.content.ContextCompat
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlin.coroutines.suspendCoroutine

/**
 * Silently grabs one frame from the FRONT camera — no preview UI required — and returns it as a
 * Bitmap. Used to photograph whoever is holding the phone during a failed unlock.
 *
 * It carries its own [LifecycleOwner] so it can run from a background Service as well as an Activity.
 */
class IntruderCamera(private val context: Context) : LifecycleOwner {

    private val registry = LifecycleRegistry(this)
    override val lifecycle: Lifecycle get() = registry

    suspend fun capture(): Bitmap = suspendCoroutine { cont ->
        val mainExecutor = ContextCompat.getMainExecutor(context)
        // Everything to do with CameraX must run on the main thread.
        mainExecutor.execute {
            registry.currentState = Lifecycle.State.RESUMED
            val future = ProcessCameraProvider.getInstance(context)
            future.addListener({
                try {
                    val provider = future.get()
                    val imageCapture = ImageCapture.Builder()
                        .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
                        .build()
                    provider.unbindAll()
                    provider.bindToLifecycle(
                        this,
                        CameraSelector.DEFAULT_FRONT_CAMERA,
                        imageCapture
                    )
                    imageCapture.takePicture(
                        mainExecutor,
                        object : ImageCapture.OnImageCapturedCallback() {
                            override fun onCaptureSuccess(image: ImageProxy) {
                                try {
                                    val bmp = image.toBitmap()
                                    cont.resume(bmp)
                                } catch (e: Exception) {
                                    cont.resumeWithException(e)
                                } finally {
                                    image.close()
                                    cleanup(provider)
                                }
                            }

                            override fun onError(exc: ImageCaptureException) {
                                cleanup(provider)
                                cont.resumeWithException(exc)
                            }
                        }
                    )
                } catch (e: Exception) {
                    cont.resumeWithException(e)
                }
            }, mainExecutor)
        }
    }

    private fun cleanup(provider: ProcessCameraProvider) {
        try { provider.unbindAll() } catch (_: Exception) {}
        registry.currentState = Lifecycle.State.DESTROYED
    }

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
