package com.guardface.sentinel

import android.graphics.Bitmap
import android.graphics.PointF
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.face.Face
import com.google.mlkit.vision.face.FaceDetection
import com.google.mlkit.vision.face.FaceDetectorOptions
import com.google.mlkit.vision.face.FaceLandmark
import kotlin.math.sqrt

/**
 * On-device face engine built on Google ML Kit (a third-party face library that runs fully
 * offline — no photo ever leaves the device for the recognition step).
 *
 * We turn a detected face into a compact "signature": the geometry of its landmarks (eyes,
 * ears, cheeks, nose, mouth) normalised against the face bounding box, plus the eye/smile
 * classifier probabilities. Two signatures are compared with cosine similarity.
 *
 * NOTE ON ACCURACY: landmark geometry is a lightweight recogniser — great for a hobby/anti-theft
 * guard, but it is not bank-grade biometric identity. For production strength, swap
 * [signatureFor] with a MobileFaceNet / FaceNet TFLite embedding model (same interface, just a
 * longer float vector). The rest of the app does not change.
 */
object FaceEngine {

    private const val MATCH_THRESHOLD = 0.92f  // cosine similarity; higher = stricter

    private val detector by lazy {
        FaceDetection.getClient(
            FaceDetectorOptions.Builder()
                .setPerformanceMode(FaceDetectorOptions.PERFORMANCE_MODE_ACCURATE)
                .setLandmarkMode(FaceDetectorOptions.LANDMARK_MODE_ALL)
                .setClassificationMode(FaceDetectorOptions.CLASSIFICATION_MODE_ALL)
                .setMinFaceSize(0.15f)
                .build()
        )
    }

    /** Blocking detection — always call from a background thread / coroutine. */
    private fun detect(bitmap: Bitmap): Face? {
        val image = InputImage.fromBitmap(bitmap, 0)
        val faces = Tasks.await(detector.process(image))
        // Pick the largest face (closest to the camera).
        return faces.maxByOrNull { it.boundingBox.width() * it.boundingBox.height() }
    }

    /** Returns a signature vector for the biggest face in the image, or null if no face found. */
    fun signatureFor(bitmap: Bitmap): FloatArray? {
        val face = detect(bitmap) ?: return null
        val box = face.boundingBox
        val w = box.width().toFloat().coerceAtLeast(1f)
        val h = box.height().toFloat().coerceAtLeast(1f)
        val ox = box.left.toFloat()
        val oy = box.top.toFloat()

        val types = intArrayOf(
            FaceLandmark.LEFT_EYE, FaceLandmark.RIGHT_EYE,
            FaceLandmark.LEFT_EAR, FaceLandmark.RIGHT_EAR,
            FaceLandmark.LEFT_CHEEK, FaceLandmark.RIGHT_CHEEK,
            FaceLandmark.NOSE_BASE,
            FaceLandmark.MOUTH_LEFT, FaceLandmark.MOUTH_RIGHT, FaceLandmark.MOUTH_BOTTOM
        )

        val vec = ArrayList<Float>()
        for (t in types) {
            val p: PointF? = face.getLandmark(t)?.position
            if (p == null) {
                vec.add(0f); vec.add(0f)
            } else {
                vec.add((p.x - ox) / w)   // normalised x within face box
                vec.add((p.y - oy) / h)   // normalised y within face box
            }
        }
        // A few pose/expression scalars for extra separation.
        vec.add((face.smilingProbability ?: 0f))
        vec.add((face.leftEyeOpenProbability ?: 0f))
        vec.add((face.rightEyeOpenProbability ?: 0f))

        return l2normalize(vec.toFloatArray())
    }

    /** Cosine similarity of two signatures (both are L2-normalised, so this is a dot product). */
    fun similarity(a: FloatArray, b: FloatArray): Float {
        if (a.size != b.size) return 0f
        var dot = 0f
        for (i in a.indices) dot += a[i] * b[i]
        return dot
    }

    /** True when [candidate] is the same person as the enrolled [owner] signature. */
    fun isOwner(owner: FloatArray, candidate: FloatArray): Boolean =
        similarity(owner, candidate) >= MATCH_THRESHOLD

    private fun l2normalize(v: FloatArray): FloatArray {
        var sum = 0f
        for (x in v) sum += x * x
        val norm = sqrt(sum).coerceAtLeast(1e-6f)
        return FloatArray(v.size) { v[it] / norm }
    }
}
