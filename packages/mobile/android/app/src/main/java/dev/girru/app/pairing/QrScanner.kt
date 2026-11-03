package dev.girru.app.pairing

import android.app.Activity

/**
 * Camera QR scanning. Android has no built-in QR decoder, and the usual ones
 * are third-party libraries, so none is included yet: "Type the code instead"
 * is the working path. TODO(owner decision, see README): pick a decoder
 * (our own on CameraX frames, or an approved library) and add the CAMERA
 * permission with it.
 */
interface QrScanner {
    val isAvailable: Boolean

    /** Calls [onResult] with the scanned text, or null when cancelled. */
    fun scan(activity: Activity, onResult: (String?) -> Unit)
}

object NoQrScanner : QrScanner {
    override val isAvailable = false

    override fun scan(activity: Activity, onResult: (String?) -> Unit) = onResult(null)
}
