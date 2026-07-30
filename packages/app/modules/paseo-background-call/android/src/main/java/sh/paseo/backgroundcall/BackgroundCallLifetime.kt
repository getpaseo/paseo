package sh.paseo.backgroundcall

import android.content.Context
import android.content.Intent
import android.os.Build

internal object BackgroundCallLifetime {
    @Volatile
    private var isActive = false

    fun begin(context: Context) {
        if (isActive) {
            return
        }

        val serviceIntent = Intent(context, BackgroundCallService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(serviceIntent)
        } else {
            context.startService(serviceIntent)
        }
        isActive = true
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
}
