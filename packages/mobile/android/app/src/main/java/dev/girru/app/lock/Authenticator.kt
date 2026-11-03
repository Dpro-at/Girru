package dev.girru.app.lock

import android.app.Activity
import android.os.Build
import android.view.WindowManager
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity

/**
 * The system unlock prompt: a fingerprint or face, with the phone's own
 * passcode as fallback. Create it in onCreate (BiometricPrompt needs that).
 * One prompt at a time; a second request while one is open is refused.
 */
class Authenticator(private val activity: FragmentActivity) {
    enum class Availability { READY, NO_SCREEN_LOCK, UNAVAILABLE }

    private var pending: ((Boolean) -> Unit)? = null

    private val prompt = BiometricPrompt(
        activity,
        ContextCompat.getMainExecutor(activity),
        object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) = finish(true)

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) = finish(false)

            // onAuthenticationFailed (a wrong finger) keeps the prompt open; nothing to do.
        },
    )

    val isBusy: Boolean get() = pending != null

    fun availability(): Availability =
        when (BiometricManager.from(activity).canAuthenticate(ALLOWED)) {
            BiometricManager.BIOMETRIC_SUCCESS -> Availability.READY
            // With DEVICE_CREDENTIAL allowed, "none enrolled" means the phone has no screen lock at all.
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> Availability.NO_SCREEN_LOCK
            else -> Availability.UNAVAILABLE
        }

    fun authenticate(title: CharSequence, subtitle: CharSequence?, onResult: (Boolean) -> Unit) {
        if (pending != null) {
            onResult(false)
            return
        }
        pending = onResult
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(title)
            .apply { if (subtitle != null) setSubtitle(subtitle) }
            // No negative button: it is not allowed together with DEVICE_CREDENTIAL.
            .setAllowedAuthenticators(ALLOWED)
            .build()
        prompt.authenticate(info)
    }

    private fun finish(ok: Boolean) {
        val callback = pending
        pending = null
        callback?.invoke(ok)
    }

    companion object {
        /**
         * Android 11+: strong biometrics or the passcode, matching the identity key.
         * Android 10 cannot combine STRONG with DEVICE_CREDENTIAL in the prompt, so
         * it uses WEAK; on Android 10 a weak face unlock may then not unlock the key
         * and signing asks again (see README, "Open decisions").
         */
        val ALLOWED: Int
            get() = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                BIOMETRIC_STRONG or DEVICE_CREDENTIAL
            } else {
                BIOMETRIC_WEAK or DEVICE_CREDENTIAL
            }
    }
}

/** Hides app content from screenshots, screen recording and the recent-apps preview. */
object SecureWindow {
    fun apply(activity: Activity) {
        activity.window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) activity.setRecentsScreenshotEnabled(false)
    }
}
