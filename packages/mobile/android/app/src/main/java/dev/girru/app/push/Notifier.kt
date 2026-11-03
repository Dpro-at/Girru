package dev.girru.app.push

import android.Manifest
import android.annotation.SuppressLint
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import dev.girru.app.ConfirmActionActivity
import dev.girru.app.MainActivity
import dev.girru.app.R

/**
 * Shows verified notices. Calm by default (the computer decides what is worth
 * a push and groups it, MOB-PUSH-01): approvals and alerts are loud,
 * summaries are quiet. Notices with the same group, or a repeat of the same
 * approval, replace each other instead of piling up.
 */
object Notifier {
    const val CHANNEL_APPROVALS = "approvals"
    const val CHANNEL_ALERTS = "alerts"
    const val CHANNEL_UPDATES = "updates"
    private const val NEUTRAL_ID = 1

    fun createChannels(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        manager.createNotificationChannels(
            listOf(
                NotificationChannel(CHANNEL_APPROVALS, context.getString(R.string.channel_approvals), NotificationManager.IMPORTANCE_HIGH),
                NotificationChannel(CHANNEL_ALERTS, context.getString(R.string.channel_alerts), NotificationManager.IMPORTANCE_HIGH),
                NotificationChannel(CHANNEL_UPDATES, context.getString(R.string.channel_updates), NotificationManager.IMPORTANCE_LOW),
            ),
        )
    }

    fun canNotify(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        return NotificationManagerCompat.from(context).areNotificationsEnabled()
    }

    /** Shows a notice that passed every check in NoticeEnvelope and the replay window. */
    fun show(context: Context, notice: PushNotice) {
        val channel = when (notice.kind) {
            PushNotice.Kind.APPROVAL, PushNotice.Kind.APPROVAL_SENSITIVE -> CHANNEL_APPROVALS
            PushNotice.Kind.SECURITY, PushNotice.Kind.TASK_FAILED -> CHANNEL_ALERTS
            PushNotice.Kind.SUMMARY -> CHANNEL_UPDATES
        }
        val id = notificationId(notice)
        val builder = base(context, channel)
            .setContentTitle(notice.title)
            .setContentText(notice.body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(notice.body))
            .setContentIntent(openApp(context, id))
            // The lock screen shows only the neutral line when the owner hides private content there.
            .setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
            .setPublicVersion(
                base(context, channel)
                    .setContentTitle(context.getString(R.string.app_name))
                    .setContentText(context.getString(if (notice.kind.isApproval) R.string.notice_public_approval else R.string.notice_neutral))
                    .build(),
            )
        val approvalId = notice.approvalId
        if (notice.kind.isApproval && approvalId != null) {
            builder.setCategory(NotificationCompat.CATEGORY_REMINDER)
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .addAction(0, context.getString(R.string.action_deny), decision(context, id, approvalId, approve = false))
                .addAction(0, context.getString(R.string.action_approve), decision(context, id, approvalId, approve = true))
        } else if (channel == CHANNEL_ALERTS) {
            builder.setCategory(NotificationCompat.CATEGORY_STATUS).setPriority(NotificationCompat.PRIORITY_HIGH)
        } else {
            builder.setPriority(NotificationCompat.PRIORITY_LOW)
        }
        notify(context, id, builder)
    }

    /** A notice that failed a check is never shown with content; one neutral line, replaced each time. */
    fun showNeutral(context: Context) {
        notify(
            context, NEUTRAL_ID,
            base(context, CHANNEL_UPDATES)
                .setContentTitle(context.getString(R.string.app_name))
                .setContentText(context.getString(R.string.notice_neutral))
                .setContentIntent(openApp(context, NEUTRAL_ID))
                .setPriority(NotificationCompat.PRIORITY_LOW),
        )
    }

    fun cancel(context: Context, id: Int) = NotificationManagerCompat.from(context).cancel(id)

    // canNotify() checks the permission first; lint cannot see through the helper.
    @SuppressLint("MissingPermission")
    private fun notify(context: Context, id: Int, builder: NotificationCompat.Builder) {
        if (!canNotify(context)) return
        try {
            NotificationManagerCompat.from(context).notify(id, builder.build())
        } catch (e: SecurityException) {
            // Permission was withdrawn between the check and the call.
        }
    }

    private fun base(context: Context, channel: String) = NotificationCompat.Builder(context, channel)
        .setSmallIcon(R.drawable.ic_stat_girru)
        .setAutoCancel(true)
        .setOnlyAlertOnce(true)

    private fun openApp(context: Context, requestCode: Int): PendingIntent = PendingIntent.getActivity(
        context, requestCode,
        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

    private fun notificationId(notice: PushNotice): Int {
        val key = notice.approvalId?.let { "a:$it" } ?: notice.group?.let { "g:$it" } ?: "${notice.kind.wire}:${notice.title}"
        // Never collide with the neutral line's id.
        return (key.hashCode() and 0x7fffffff).coerceAtLeast(NEUTRAL_ID + 1)
    }

    /**
     * Both answers open a confirmation, which acts only if the id is in the
     * verified-approvals list; the extras are a pointer, not a source of truth.
     */
    private fun decision(context: Context, notificationId: Int, approvalId: String, approve: Boolean): PendingIntent {
        val intent = Intent(context, ConfirmActionActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(ConfirmActionActivity.EXTRA_APPROVAL_ID, approvalId)
            .putExtra(ConfirmActionActivity.EXTRA_APPROVE, approve)
            .putExtra(ConfirmActionActivity.EXTRA_NOTIFICATION_ID, notificationId)
        // Distinct request codes keep Approve and Deny from replacing each other.
        val requestCode = (notificationId shl 1) or (if (approve) 1 else 0)
        return PendingIntent.getActivity(context, requestCode, intent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }
}
