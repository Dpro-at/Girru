package dev.girru.app.push

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import dev.girru.app.storage.SecureStore

/**
 * Firebase is off until the phone is paired (auto-init is disabled in the
 * manifest), so an unpaired phone never contacts Google for a token. Builds
 * without google-services.json have no Firebase app at all; push is then
 * simply unavailable.
 */
object PushSetup {
    const val K_TOKEN = "push.token"

    private fun available(context: Context) = FirebaseApp.getApps(context).isNotEmpty()

    fun enable(context: Context, store: SecureStore) {
        if (!available(context)) return
        val messaging = FirebaseMessaging.getInstance()
        messaging.isAutoInitEnabled = true
        messaging.token.addOnSuccessListener { token -> store.edit { it[K_TOKEN] = token } }
    }

    fun disable(context: Context, store: SecureStore) {
        store.edit { it.remove(K_TOKEN) }
        if (!available(context)) return
        val messaging = FirebaseMessaging.getInstance()
        messaging.isAutoInitEnabled = false
        messaging.deleteToken()
    }
}
