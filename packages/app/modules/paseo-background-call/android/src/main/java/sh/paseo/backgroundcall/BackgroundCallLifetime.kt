package sh.paseo.backgroundcall

import android.content.Context
import android.content.Intent
import android.os.Build

internal object BackgroundCallLifetime {
    @Volatile
    private var isActive = false

    /**
     * Set by the Expo module while it is alive. Notification buttons arrive on a
     * binder thread with no React context of their own, so they land here and the
     * module forwards them to JS. A null listener means JS is gone — the button
     * press is dropped rather than queued, because a control that acts on a call
     * the user can no longer see is worse than one that does nothing.
     */
    @Volatile
    var actionListener: ((String) -> Unit)? = null

    fun begin(context: Context) {
        if (isActive) {
            return
        }

        startService(context, Intent(context, BackgroundCallService::class.java))
        isActive = true
    }

    /**
     * Re-posts the notification with current call state. No-op when no call is up,
     * so a late update from JS cannot resurrect a service that just stopped.
     */
    fun update(context: Context, isMuted: Boolean) {
        if (!isActive) {
            return
        }

        startService(
            context,
            Intent(context, BackgroundCallService::class.java)
                .putExtra(BackgroundCallService.EXTRA_IS_MUTED, isMuted),
        )
    }

    fun end(context: Context) {
        if (!isActive) {
            return
        }

        isActive = false
        context.stopService(Intent(context, BackgroundCallService::class.java))
    }

    fun serviceStopped() {
        isActive = false
    }

    fun dispatchAction(action: String) {
        actionListener?.invoke(action)
    }

    private fun startService(context: Context, intent: Intent) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
    }
}
