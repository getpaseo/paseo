package sh.paseo.backgroundcall

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.os.Build
import android.os.IBinder
import android.os.SystemClock

/**
 * Holds the foreground-service notification for an active Live Voice call.
 *
 * The notification is the call's only presence once Paseo is backgrounded, so it
 * carries the controls rather than just announcing itself: muting or hanging up
 * from the shade must not require reopening the app. The buttons come back
 * through this same service as intent actions, which are forwarded to JS through
 * [BackgroundCallLifetime]. The service never changes call state itself — it has
 * no idea what a WebRTC session is, and the runtime that does stays the only
 * writer.
 */
internal class BackgroundCallService : Service() {
    /**
     * Chronometer base for the call timer. Set once on the first start so that
     * later mute toggles rebuild the notification without restarting the clock.
     */
    private var callStartedAtRealtimeMs: Long = 0L
    private var isMuted = false
    private var isForeground = false

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_TOGGLE_MUTE -> {
                BackgroundCallLifetime.dispatchAction(ACTION_NAME_TOGGLE_MUTE)
                return START_NOT_STICKY
            }
            ACTION_END -> {
                BackgroundCallLifetime.dispatchAction(ACTION_NAME_END)
                return START_NOT_STICKY
            }
        }

        if (intent?.hasExtra(EXTRA_IS_MUTED) == true) {
            isMuted = intent.getBooleanExtra(EXTRA_IS_MUTED, false)
        }
        if (callStartedAtRealtimeMs == 0L) {
            callStartedAtRealtimeMs = SystemClock.elapsedRealtime()
        }

        val notification = createNotification()
        if (isForeground) {
            // Already promoted; re-posting the same id updates the shade in place.
            // Calling startForeground again would be harmless but re-triggers the
            // "immediate" behavior on S+, which flashes the notification.
            getSystemService(NotificationManager::class.java)
                .notify(NOTIFICATION_ID, notification)
            return START_NOT_STICKY
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val foregroundServiceTypes =
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            startForeground(NOTIFICATION_ID, notification, foregroundServiceTypes)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        isForeground = true
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(STOP_FOREGROUND_REMOVE)
        } else {
            @Suppress("DEPRECATION")
            stopForeground(true)
        }
        isForeground = false
        BackgroundCallLifetime.serviceStopped()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }

        val channel = NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            "Live Voice calls",
            NotificationManager.IMPORTANCE_LOW,
        )
        channel.description = "Keeps an active Live Voice call connected"
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun createNotification(): Notification {
        val builder =
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Notification.Builder(this, NOTIFICATION_CHANNEL_ID)
            } else {
                @Suppress("DEPRECATION")
                Notification.Builder(this)
        }

        packageManager.getLaunchIntentForPackage(packageName)?.let { launchIntent ->
            launchIntent.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            builder.setContentIntent(
                PendingIntent.getActivity(this, 0, launchIntent, pendingIntentFlags()),
            )
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            builder.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE)
        }

        builder.addAction(
            buildAction(
                icon = if (isMuted) {
                    android.R.drawable.ic_lock_silent_mode_off
                } else {
                    android.R.drawable.ic_lock_silent_mode
                },
                title = if (isMuted) "Unmute" else "Mute",
                action = ACTION_TOGGLE_MUTE,
                requestCode = REQUEST_TOGGLE_MUTE,
            ),
        )
        builder.addAction(
            buildAction(
                icon = android.R.drawable.ic_menu_close_clear_cancel,
                title = "End call",
                action = ACTION_END,
                requestCode = REQUEST_END,
            ),
        )

        return builder
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(if (isMuted) "Live Voice call — muted" else "Live Voice call")
            .setContentText(
                if (isMuted) {
                    "Your microphone is off. The call is still connected."
                } else {
                    "Paseo is listening and keeping the call connected"
                },
            )
            .setUsesChronometer(true)
            .setWhen(System.currentTimeMillis() - elapsedCallMs())
            .setCategory(Notification.CATEGORY_CALL)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .build()
    }

    /**
     * `setWhen` takes wall-clock time, but wall clock can jump while a call is up.
     * Measuring the call against [SystemClock.elapsedRealtime] and converting only
     * at post time keeps the timer honest across a clock change.
     */
    private fun elapsedCallMs(): Long {
        if (callStartedAtRealtimeMs == 0L) {
            return 0L
        }
        return SystemClock.elapsedRealtime() - callStartedAtRealtimeMs
    }

    private fun buildAction(
        icon: Int,
        title: String,
        action: String,
        requestCode: Int,
    ): Notification.Action {
        val intent = Intent(this, BackgroundCallService::class.java).setAction(action)
        val pendingIntent =
            PendingIntent.getService(this, requestCode, intent, pendingIntentFlags())
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            Notification.Action.Builder(
                Icon.createWithResource(this, icon),
                title,
                pendingIntent,
            ).build()
        } else {
            @Suppress("DEPRECATION")
            Notification.Action.Builder(icon, title, pendingIntent).build()
        }
    }

    private fun pendingIntentFlags(): Int {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        } else {
            PendingIntent.FLAG_UPDATE_CURRENT
        }
    }

    internal companion object {
        const val NOTIFICATION_CHANNEL_ID = "paseo_live_voice_call"
        const val NOTIFICATION_ID = 7102
        const val EXTRA_IS_MUTED = "sh.paseo.backgroundcall.IS_MUTED"
        const val ACTION_TOGGLE_MUTE = "sh.paseo.backgroundcall.TOGGLE_MUTE"
        const val ACTION_END = "sh.paseo.backgroundcall.END"

        /** The names JS sees. Kept short because they cross the bridge as data. */
        const val ACTION_NAME_TOGGLE_MUTE = "toggleMute"
        const val ACTION_NAME_END = "end"

        private const val REQUEST_TOGGLE_MUTE = 1
        private const val REQUEST_END = 2
    }
}
