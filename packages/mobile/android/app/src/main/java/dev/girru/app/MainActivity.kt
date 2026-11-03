package dev.girru.app

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.RadioGroup
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.isVisible
import dev.girru.app.lock.Authenticator
import dev.girru.app.lock.LockPolicy
import dev.girru.app.lock.SecureWindow
import dev.girru.app.link.PairingClient
import dev.girru.app.pairing.PairedComputer
import dev.girru.app.pairing.PairingMessages
import dev.girru.app.pairing.PairingLifetime
import dev.girru.app.pairing.PairingPayload
import dev.girru.app.pairing.PairingPayloadParser
import dev.girru.app.pairing.PairingRepository
import dev.girru.app.push.Notifier
import dev.girru.app.push.PushSetup
import dev.girru.app.screens.PhoneTabs
import dev.girru.app.web.NativeBridge
import dev.girru.app.web.WebHost
import dev.girru.app.web.WebOrigin
import java.security.GeneralSecurityException
import java.security.ProviderException

/**
 * The one window. Order is fixed: unlock first (always), then pairing when
 * there is none, then the computer's screens in the web host.
 */
class MainActivity : AppCompatActivity(), NativeBridge.Handler {
    private enum class Screen { LOCKED, NEEDS_SCREEN_LOCK, PAIR, WAITING, WEB }

    private val app get() = application as GirruApplication
    private lateinit var auth: Authenticator
    private var webHost: WebHost? = null
    private var tabs: PhoneTabs? = null
    private var webView: WebView? = null
    private var promptedThisForeground = false

    // A read code before it is sent; after that the waiting record (encrypted store) holds the pairing.
    private var payload: PairingPayload? = null
    private var requestReached = false
    private val codeExpiry = Runnable { render() }

    private var pendingPermission: ((Boolean) -> Unit)? = null
    private val notificationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            pendingPermission?.invoke(granted)
            pendingPermission = null
        }

    private lateinit var root: View
    private lateinit var webContainer: FrameLayout
    private lateinit var lockScreen: View
    private lateinit var lockComputer: TextView
    private lateinit var lockError: TextView
    private lateinit var screenLockNeeded: View
    private lateinit var pairScreen: View
    private lateinit var pairNotice: TextView
    private lateinit var scanButton: Button
    private lateinit var scannerNote: TextView
    private lateinit var typeCodeButton: Button
    private lateinit var codeGroup: View
    private lateinit var codeInput: EditText
    private lateinit var codeError: TextView
    private lateinit var confirmGroup: View
    private lateinit var confirmComputer: TextView
    private lateinit var lifetimeGroup: RadioGroup
    private lateinit var neverWarning: TextView
    private lateinit var waitingScreen: View
    private lateinit var waitingCheckCode: TextView
    private lateinit var waitingCheckCodeHint: TextView
    private lateinit var waitingForCode: TextView
    private lateinit var waitingBody: TextView
    private lateinit var finishPairingButton: Button
    private lateinit var waitingNotReached: TextView
    private lateinit var debugContinue: Button

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        SecureWindow.apply(this)
        setContentView(R.layout.activity_main)
        root = findViewById(R.id.root)
        // Edge to edge is the default on Android 15; keep content clear of bars and keyboard.
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }
        auth = Authenticator(this)
        bindViews()
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                val host = webHost
                if (host != null && webContainer.isVisible && host.canGoBack()) {
                    host.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                    isEnabled = true
                }
            }
        })
    }

    override fun onStart() {
        super.onStart()
        if (app.lock.onForeground(app.now(), promptStillOpen = auth.isBusy)) promptedThisForeground = false
        render()
    }

    override fun onResume() {
        super.onResume()
        if (currentScreen() == Screen.LOCKED && !promptedThisForeground && !auth.isBusy) {
            promptedThisForeground = true
            unlock()
        }
    }

    override fun onStop() {
        super.onStop()
        // Always recorded, also during our own prompt; LockPolicy decides when the prompt ends (fails closed).
        app.lock.onBackground(app.now())
    }

    override fun onDestroy() {
        root.removeCallbacks(codeExpiry)
        destroyWeb()
        super.onDestroy()
    }

    // ---------- screens ----------

    private fun currentScreen(): Screen {
        if (app.lock.isLocked(app.now())) {
            return if (auth.availability() == Authenticator.Availability.NO_SCREEN_LOCK) Screen.NEEDS_SCREEN_LOCK else Screen.LOCKED
        }
        return when (app.pairing.status(System.currentTimeMillis())) {
            is PairingRepository.Status.NotPaired -> Screen.PAIR
            is PairingRepository.Status.Waiting -> Screen.WAITING
            is PairingRepository.Status.Paired -> Screen.WEB
        }
    }

    private fun render() {
        val screen = currentScreen()
        // Locking forgets every terminal: the next use asks for the check again.
        if (screen == Screen.LOCKED) app.content.terminal.forget()
        lockScreen.isVisible = screen == Screen.LOCKED
        screenLockNeeded.isVisible = screen == Screen.NEEDS_SCREEN_LOCK
        pairScreen.isVisible = screen == Screen.PAIR
        waitingScreen.isVisible = screen == Screen.WAITING
        webContainer.isVisible = screen == Screen.WEB
        when (screen) {
            Screen.LOCKED -> renderLock()
            Screen.PAIR -> renderPair()
            Screen.WAITING -> renderWaiting()
            Screen.WEB -> ensureWeb()
            Screen.NEEDS_SCREEN_LOCK -> Unit
        }
        // A locked app keeps its page (hidden); anything else without a pairing drops it.
        if (screen != Screen.WEB && screen != Screen.LOCKED && screen != Screen.NEEDS_SCREEN_LOCK) destroyWeb()
    }

    private fun renderLock() {
        val computer = app.pairing.load()?.takeIf { it.state == PairedComputer.State.PAIRED }
        lockComputer.isVisible = computer != null
        lockComputer.text = computer?.let { getString(R.string.lock_computer, it.name) }
        lockError.isVisible = auth.availability() == Authenticator.Availability.UNAVAILABLE
    }

    private fun unlock() {
        if (auth.availability() != Authenticator.Availability.READY) {
            render()
            return
        }
        ask(LockPolicy.Prompt.UNLOCK, getString(R.string.unlock_prompt_title), null) { }
    }

    /**
     * Every system prompt goes through here so the lock policy knows one is
     * open and decides the outcome: an unlock unlocks only on success; a
     * confirm that is cancelled, fails, or during which the app was stopped
     * locks the app.
     */
    private fun ask(kind: LockPolicy.Prompt, title: String, subtitle: CharSequence?, done: (Boolean) -> Unit) {
        if (auth.isBusy) {
            done(false)
            return
        }
        app.lock.onPromptStarted(kind)
        auth.authenticate(title, subtitle) { ok ->
            app.lock.onPromptFinished(kind, ok, app.now())
            render()
            done(ok)
        }
    }

    private fun renderPair() {
        val status = app.pairing.status(System.currentTimeMillis())
        val notice = (status as? PairingRepository.Status.NotPaired)?.notice
        pairNotice.isVisible = notice != null
        pairNotice.text = when (notice) {
            PairingRepository.Notice.EXPIRED -> getString(R.string.pair_notice_expired)
            PairingRepository.Notice.REMOVED_ON_COMPUTER -> getString(R.string.pair_notice_removed)
            PairingRepository.Notice.CODE_EXPIRED -> getString(R.string.pair_notice_code_expired)
            null -> null
        }
        val scanner = app.qrScanner.isAvailable
        scanButton.isVisible = scanner
        typeCodeButton.isVisible = scanner && !codeGroup.isVisible
        scannerNote.isVisible = !scanner
        // Without a scanner, typing the code is the way in.
        if (!scanner) codeGroup.isVisible = true
        // A shown code renews on the computer every 2 minutes: an old one asks for the new code.
        if (payload?.let { it.expiresAtSec <= System.currentTimeMillis() / 1000 } == true) {
            payload = null
            codeError.text = getString(R.string.pair_error_expired)
            codeError.isVisible = true
        }
        confirmGroup.isVisible = payload != null
        neverWarning.isVisible = lifetimeGroup.checkedRadioButtonId == R.id.life_never
    }

    private fun renderWaiting() {
        val now = System.currentTimeMillis()
        val computer = (app.pairing.status(now) as? PairingRepository.Status.Waiting)?.computer
        val phoneKey = app.crypto.identityPublicKey()
        // No code before a verified challenge from the computer (PROTOCOL.md "Check challenge").
        val code = if (computer != null && phoneKey != null) computer.checkCode(phoneKey) else null
        val heldWelcome = computer?.pending?.welcome != null
        waitingCheckCode.isVisible = code != null
        waitingCheckCode.text = code?.let { getString(R.string.check_code, formatCode(it)) }
        waitingCheckCodeHint.isVisible = code != null && !heldWelcome
        waitingForCode.isVisible = code == null
        waitingBody.text = getString(if (heldWelcome) R.string.waiting_finish_body else R.string.waiting_body)
        finishPairingButton.isVisible = heldWelcome
        waitingNotReached.isVisible = !requestReached && code == null
        debugContinue.isVisible = BuildConfig.DEBUG
    }

    // ---------- pairing ----------

    private fun readCode() {
        codeError.isVisible = false
        payload = null
        root.removeCallbacks(codeExpiry)
        // The welcome's key is unwrapped with ECDH by the identity key, which needs Keystore ECDH (Android 12+).
        if (!app.crypto.supportsKeyAgreement()) return showCodeError(R.string.pair_error_android_version)
        val result = PairingPayloadParser.parse(codeInput.text.toString(), System.currentTimeMillis() / 1000)
        when (result) {
            is PairingPayloadParser.Result.Error -> {
                codeError.text = getString(errorText(result.reason))
                codeError.isVisible = true
            }
            is PairingPayloadParser.Result.Ok -> {
                val phoneKey = createIdentityOrNull()
                if (phoneKey == null) {
                    codeError.text = getString(R.string.pair_error_key)
                    codeError.isVisible = true
                    return
                }
                app.pairing.clearNotice()
                payload = result.payload
                confirmComputer.text = getString(R.string.pair_confirm_computer, result.payload.computerName)
                val left = result.payload.expiresAtSec * 1000 - System.currentTimeMillis()
                root.postDelayed(codeExpiry, left.coerceAtLeast(0) + 500)
            }
        }
        render()
    }

    /** Keystore refuses to create an unlock-bound key without a secure lock screen, among other failures. */
    private fun createIdentityOrNull(): ByteArray? = try {
        app.crypto.ensureIdentity()
    } catch (e: GeneralSecurityException) {
        null
    } catch (e: ProviderException) {
        null
    } catch (e: IllegalStateException) {
        null
    }

    private fun sendPairing() {
        val p = payload ?: return
        if (p.expiresAtSec <= System.currentTimeMillis() / 1000) return codeExpired()
        val phoneKey = app.crypto.identityPublicKey() ?: return
        val wish = selectedLifetime()
        // The request carries a signature by the unlock-bound identity key: ask for the unlock now.
        ask(LockPolicy.Prompt.CONFIRM, getString(R.string.pair_prompt_title), p.computerName) { ok ->
            if (ok) sealAndSend(p, phoneKey, wish)
        }
    }

    private fun sealAndSend(p: PairingPayload, phoneKey: ByteArray, wish: PairingLifetime) {
        if (p.expiresAtSec <= System.currentTimeMillis() / 1000) return codeExpired()
        val waiting = PairedComputer.waiting(p, wish, System.currentTimeMillis())
        val pending = waiting.pending ?: return
        val request = try {
            PairingMessages.buildRequest(
                pairingId = p.pairingId,
                pairingKey = pending.pairingKey,
                phoneSpki = phoneKey,
                signer = app.crypto.signer,
                phoneName = Build.MODEL ?: "Android",
                // Left out until the owner allows notifications (PROTOCOL.md); sent later in the session.
                pushToken = null,
                // "Never" cannot be asked for in the request; the owner picks it on the computer.
                lifetimeDays = wish.days,
            )
        } catch (e: GeneralSecurityException) {
            return showCodeError(R.string.pair_error_key)
        } catch (e: ProviderException) {
            return showCodeError(R.string.pair_error_key)
        } catch (e: IllegalStateException) {
            return showCodeError(R.string.pair_error_key)
        }
        app.pairing.save(waiting)
        requestReached = false
        payload = null
        root.removeCallbacks(codeExpiry)
        codeInput.text.clear()
        app.pairingClient.sendRequest(p, request, object : PairingClient.Events {
            override fun delivered(reached: Boolean) {
                requestReached = reached
                render()
            }

            override fun challenge(envelope: String) {
                app.pairing.onChallenge(envelope, phoneKey, System.currentTimeMillis())
                render()
            }

            override fun welcome(envelope: String) = onWelcome(envelope)
        })
        render()
    }

    private fun onWelcome(envelope: String) {
        val phoneId = app.crypto.deviceId() ?: return
        val result = app.pairing.onWelcome(envelope, phoneId, app.crypto.agreer, System.currentTimeMillis())
        if (result == PairingRepository.WelcomeResult.ACCEPTED) PushSetup.enable(this, app.store)
        render()
    }

    /** The welcome checked out but the identity key needs a fresh unlock to unwrap its key. */
    private fun finishPairing() {
        val phoneId = app.crypto.deviceId() ?: return
        ask(LockPolicy.Prompt.CONFIRM, getString(R.string.waiting_finish), null) { ok ->
            if (!ok) return@ask
            val result = app.pairing.finishWelcome(phoneId, app.crypto.agreer, System.currentTimeMillis())
            if (result == PairingRepository.WelcomeResult.ACCEPTED) PushSetup.enable(this, app.store)
            render()
        }
    }

    private fun codeExpired() {
        payload = null
        showCodeError(R.string.pair_error_expired)
    }

    private fun showCodeError(text: Int) {
        codeError.text = getString(text)
        codeError.isVisible = true
        render()
    }

    private fun selectedLifetime(): PairingLifetime = when (lifetimeGroup.checkedRadioButtonId) {
        R.id.life_30 -> PairingLifetime.DAYS_30
        R.id.life_60 -> PairingLifetime.DAYS_60
        R.id.life_120 -> PairingLifetime.DAYS_120
        R.id.life_never -> PairingLifetime.NEVER
        else -> PairingLifetime.DEFAULT
    }

    /** Debug builds only: stand in for the computer's approval until MOB-LINK-01 can deliver it. */
    private fun debugApprove() {
        if (!BuildConfig.DEBUG) return
        val computer = app.pairing.load() ?: return
        app.pairing.save(computer.copy(state = PairedComputer.State.PAIRED, pending = null).used(System.currentTimeMillis()))
        PushSetup.enable(this, app.store)
        render()
    }

    private fun removePairing() {
        app.pairing.remove()
        app.crypto.deleteIdentity()
        PushSetup.disable(this, app.store)
        payload = null
        render()
    }

    private fun errorText(reason: PairingPayloadParser.Reason): Int = when (reason) {
        PairingPayloadParser.Reason.EXPIRED -> R.string.pair_error_expired
        PairingPayloadParser.Reason.UNSUPPORTED_VERSION -> R.string.pair_error_version
        PairingPayloadParser.Reason.NO_ROUTE -> R.string.pair_error_route
        else -> R.string.pair_error_code
    }

    private fun formatCode(code: String) = code.take(3) + " " + code.drop(3)

    // ---------- web host ----------

    /** After pairing: the four places; Chat is the computer's chat page in the web host. */
    private fun ensureWeb() {
        if (webHost != null) return
        val origin = WebOrigin.COMPUTER
        val view = WebView(this)
        webView = view
        // The page's own terminal requests ask for the same check.
        app.terminalCheck = { reason, done -> ask(LockPolicy.Prompt.CONFIRM, getString(R.string.confirm_title), reason, done) }
        tabs = PhoneTabs(this, view, app.session, ::decideFromList, ::openTerminal).also {
            webContainer.addView(it, ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        }
        webHost = WebHost(view, origin, app.content, ::openExternal, ::onRendererGone)
            .also { it.start(NativeBridge(origin, this)) }
    }

    private fun destroyWeb() {
        webHost?.destroy()
        webHost = null
        tabs?.let { webContainer.removeView(it) }
        tabs = null
        webView = null
        app.terminalCheck = null
    }

    /** The terminal button: the fingerprint / screen-lock check, then the chat page opens its terminal full size. */
    private fun openTerminal() {
        ask(LockPolicy.Prompt.CONFIRM, getString(R.string.confirm_title), "Open the terminal") { ok ->
            if (!ok) return@ask
            app.content.terminal.checked()
            tabs?.select(PhoneTabs.Place.CHAT)
            webView?.evaluateJavascript("location.hash = 'terminal'", null)
        }
    }

    /** Approve or Deny on the Approvals screen: the confirm screen walks the full view and unlock steps. */
    private fun decideFromList(approvalId: String, approve: Boolean) {
        startActivity(
            Intent(this, ConfirmActionActivity::class.java)
                .putExtra(ConfirmActionActivity.EXTRA_APPROVAL_ID, approvalId)
                .putExtra(ConfirmActionActivity.EXTRA_APPROVE, approve)
                .putExtra(ConfirmActionActivity.EXTRA_FROM_LIST, true),
        )
    }

    private fun onRendererGone() {
        destroyWeb()
        render()
    }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE))
        } catch (e: ActivityNotFoundException) {
            // No browser: nothing to open.
        }
    }

    // ---------- bridge handler ----------

    override fun isLocked(): Boolean = app.lock.isLocked(app.now())

    override fun apiCall(method: String, path: String, body: String, done: (Int, String, String) -> Unit) {
        app.content.apiCall(method, path, body.ifEmpty { null }) { a ->
            // The bridge answers on the main thread.
            runOnUiThread { done(a.status, a.mimeType, String(a.body, Charsets.UTF_8)) }
        }
    }

    override fun relockSeconds(): Int = (app.lock.relockAfterMs / 1000).toInt()

    override fun setRelockSeconds(seconds: Int): Int = (app.setRelock(seconds * 1000L) / 1000).toInt()

    override fun confirmSensitive(reason: String, done: (Boolean) -> Unit) {
        ask(LockPolicy.Prompt.CONFIRM, getString(R.string.confirm_title), reason, done)
    }

    override fun openScanner(): Boolean {
        // TODO(QR decoder decision): with a scanner, the result goes to the native pairing screen, never to the page.
        return app.qrScanner.isAvailable
    }

    override fun requestNotificationPermission(done: (Boolean) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        ) {
            done(Notifier.canNotify(this))
            return
        }
        if (pendingPermission != null) {
            done(false)
            return
        }
        pendingPermission = done
        notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
    }

    override fun removePairing(done: (Boolean) -> Unit) {
        ask(LockPolicy.Prompt.CONFIRM, getString(R.string.remove_pairing_prompt), null) { ok ->
            if (ok) removePairing()
            done(ok)
        }
    }

    // ---------- views ----------

    private fun bindViews() {
        webContainer = findViewById(R.id.web_container)
        lockScreen = findViewById(R.id.lock_screen)
        lockComputer = findViewById(R.id.lock_computer)
        lockError = findViewById(R.id.lock_error)
        screenLockNeeded = findViewById(R.id.screen_lock_needed)
        pairScreen = findViewById(R.id.pair_screen)
        pairNotice = findViewById(R.id.pair_notice)
        scanButton = findViewById(R.id.scan_button)
        scannerNote = findViewById(R.id.scanner_note)
        typeCodeButton = findViewById(R.id.type_code_button)
        codeGroup = findViewById(R.id.code_group)
        codeInput = findViewById(R.id.code_input)
        codeError = findViewById(R.id.code_error)
        confirmGroup = findViewById(R.id.confirm_group)
        confirmComputer = findViewById(R.id.confirm_computer)
        lifetimeGroup = findViewById(R.id.lifetime_group)
        neverWarning = findViewById(R.id.never_warning)
        waitingScreen = findViewById(R.id.waiting_screen)
        waitingCheckCode = findViewById(R.id.waiting_check_code)
        waitingCheckCodeHint = findViewById(R.id.waiting_check_code_hint)
        waitingForCode = findViewById(R.id.waiting_for_code)
        waitingBody = findViewById(R.id.waiting_body)
        finishPairingButton = findViewById(R.id.finish_pairing_button)
        waitingNotReached = findViewById(R.id.waiting_not_reached)
        debugContinue = findViewById(R.id.debug_continue)

        findViewById<Button>(R.id.unlock_button).setOnClickListener { unlock() }
        findViewById<Button>(R.id.open_security_settings).setOnClickListener { openScreenLockSettings() }
        scanButton.setOnClickListener {
            app.qrScanner.scan(this) { text ->
                if (text != null) {
                    codeInput.setText(text)
                    readCode()
                }
            }
        }
        typeCodeButton.setOnClickListener {
            codeGroup.isVisible = true
            render()
        }
        findViewById<Button>(R.id.read_code_button).setOnClickListener { readCode() }
        lifetimeGroup.setOnCheckedChangeListener { _, checkedId -> neverWarning.isVisible = checkedId == R.id.life_never }
        findViewById<Button>(R.id.send_pairing_button).setOnClickListener { sendPairing() }
        findViewById<Button>(R.id.cancel_pairing_button).setOnClickListener { removePairing() }
        finishPairingButton.setOnClickListener { finishPairing() }
        debugContinue.setOnClickListener { debugApprove() }
    }

    private fun openScreenLockSettings() {
        val intent = Intent(Settings.ACTION_BIOMETRIC_ENROLL)
            .putExtra(Settings.EXTRA_BIOMETRIC_AUTHENTICATORS_ALLOWED, Authenticator.ALLOWED)
        try {
            startActivity(intent)
        } catch (e: ActivityNotFoundException) {
            startActivity(Intent(Settings.ACTION_SETTINGS))
        }
    }
}
