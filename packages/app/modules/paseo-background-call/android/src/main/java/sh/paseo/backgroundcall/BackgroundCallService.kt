package sh.paseo.backgroundcall

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Person
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

        val notificationManager = getSystemService(NotificationManager::class.java)

        // Once a channel exists the user owns its importance, and
        // `createNotificationChannel` silently declines to raise it. Moving from
        // IMPORTANCE_LOW to DEFAULT therefore needs a new channel id, and the old
        // one has to go or it lingers in settings as a dead entry.
        notificationManager.deleteNotificationChannel(LEGACY_NOTIFICATION_CHANNEL_ID)

        val channel = NotificationChannel(
            NOTIFICATION_CHANNEL_ID,
            "Live Voice calls",
            NotificationManager.IMPORTANCE_DEFAULT,
        )
        channel.description = "Keeps an active Live Voice call connected"
        // DEFAULT is what earns CallStyle its full treatment, but it also makes a
        // channel alert by default. The app already plays its own connect cue, so
        // the notification stays silent rather than beeping over it.
        channel.setSound(null, null)
        channel.enableVibration(false)
        notificationManager.createNotificationChannel(channel)
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

        val muteAction = buildAction(
            icon = if (isMuted) {
                android.R.drawable.ic_lock_silent_mode_off
            } else {
                android.R.drawable.ic_lock_silent_mode
            },
            title = if (isMuted) "Unmute" else "Mute",
            action = ACTION_TOGGLE_MUTE,
            requestCode = REQUEST_TOGGLE_MUTE,
        )
        val hangUpIntent = servicePendingIntent(ACTION_END, REQUEST_END)

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            // CallStyle is what a watch and the lock screen recognize as a call. It
            // supplies its own hang-up button, so only mute is added; CallStyle
            // renders custom actions alongside the one it owns.
            builder.setStyle(
                Notification.CallStyle.forOngoingCall(
                    Person.Builder().setName(CALLER_NAME).setImportant(true).build(),
                    hangUpIntent,
                ),
            )
            builder.addAction(muteAction)
        } else {
            builder.addAction(muteAction)
            builder.addAction(
                buildAction(
                    icon = android.R.drawable.ic_menu_close_clear_cancel,
                    title = "End call",
                    action = ACTION_END,
                    requestCode = REQUEST_END,
                ),
            )
        }

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

    private fun servicePendingIntent(action: String, requestCode: Int): PendingIntent {
        val intent = Intent(this, BackgroundCallService::class.java).setAction(action)
        return PendingIntent.getService(this, requestCode, intent, pendingIntentFlags())
    }

    private fun buildAction(
        icon: Int,
        title: String,
        action: String,
        requestCode: Int,
    ): Notification.Action {
        val pendingIntent = servicePendingIntent(action, requestCode)
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
        /** Superseded by the v2 channel when the importance had to be raised. */
        const val LEGACY_NOTIFICATION_CHANNEL_ID = "paseo_live_voice_call"
        const val NOTIFICATION_CHANNEL_ID = "paseo_live_voice_call_v2"
        const val NOTIFICATION_ID = 7102

        /** CallStyle renders this as who the call is with. */
        const val CALLER_NAME = "Live Voice"
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
