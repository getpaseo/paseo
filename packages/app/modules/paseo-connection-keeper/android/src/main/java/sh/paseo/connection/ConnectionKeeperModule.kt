package sh.paseo.connection

import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Log
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class ConnectionKeeperModule : Module() {
  private val handler = Handler(Looper.getMainLooper())
  @Volatile private var enabled = false
  @Volatile private var background = false
  @Volatile private var serviceContext: Context? = null
  private val heartbeat = object : Runnable {
    override fun run() {
      if (!enabled || !background || !BackgroundConnectionService.running) return
      sendEvent("onBackgroundHeartbeat", emptyMap<String, Any>())
      handler.postDelayed(this, HEARTBEAT_INTERVAL_MS)
    }
  }

  private fun updateHeartbeat() {
    handler.removeCallbacks(heartbeat)
    if (enabled && background) handler.postDelayed(heartbeat, HEARTBEAT_INTERVAL_MS)
  }

  override fun definition() = ModuleDefinition {
    Name("PaseoConnectionKeeper")
    Events("onBackgroundHeartbeat")

    Function("setEnabled") { value: Boolean ->
      val context = appContext.reactContext?.applicationContext ?: serviceContext
      if (context == null) {
        false
      } else if (value) {
        try {
          if (!BackgroundConnectionService.running) {
            context.startForegroundService(Intent(context, BackgroundConnectionService::class.java))
          }
          serviceContext = context
          enabled = true
          handler.post { updateHeartbeat() }
          true
        } catch (error: RuntimeException) {
          enabled = false
          handler.post { updateHeartbeat() }
          context.stopService(Intent(context, BackgroundConnectionService::class.java))
          serviceContext = null
          Log.w("PaseoConnectionKeeper", "Could not start background connection service", error)
          false
        }
      } else {
        enabled = false
        handler.post { updateHeartbeat() }
        context.stopService(Intent(context, BackgroundConnectionService::class.java))
        serviceContext = null
        false
      }
    }

    OnActivityEntersBackground {
      background = true
      updateHeartbeat()
    }
    OnActivityEntersForeground {
      background = false
      updateHeartbeat()
    }
    OnDestroy {
      enabled = false
      handler.removeCallbacks(heartbeat)
      serviceContext?.let {
        it.stopService(Intent(it, BackgroundConnectionService::class.java))
      }
      serviceContext = null
    }
  }

  private companion object {
    const val HEARTBEAT_INTERVAL_MS = 10_000L
  }
}
