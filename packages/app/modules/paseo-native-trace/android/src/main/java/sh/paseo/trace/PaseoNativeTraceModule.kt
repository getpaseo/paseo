package sh.paseo.trace

import android.os.Trace
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.bridge.ReactContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PaseoNativeTraceModule : Module() {
  private var recorder: DiagnosticRecorder? = null
  private var touches: TouchDiagnostics? = null

  override fun definition() = ModuleDefinition {
    Name("PaseoNativeTrace")

    Function("startRecorder") { metadata: Map<String, String> ->
      if (recorder == null) {
        (appContext.reactContext as? ReactContext)?.let { context ->
          val sink = DiagnosticRecorder(context.applicationContext, metadata)
          recorder = sink
          UiThreadUtil.runOnUiThread {
            if (recorder === sink) {
              touches = TouchDiagnostics(context, sink::record).also { it.start(appContext.currentActivity?.window) }
            }
          }
        }
      }
      HeartbeatTiming.intervalMs
    }
    Function("record") { name: String, data: Map<String, String> -> recorder?.record(name, data) }
    Function("heartbeat") { recorder?.heartbeat() }
    OnActivityEntersForeground {
      recorder?.active(true)
      UiThreadUtil.runOnUiThread { touches?.activity(appContext.currentActivity?.window) }
    }
    OnActivityEntersBackground { recorder?.active(false) }
    OnDestroy {
      val sink = recorder
      recorder = null
      UiThreadUtil.runOnUiThread {
        touches?.close()
        touches = null
        sink?.close()
      }
    }

    Function("beginSection") { name: String ->
      Trace.beginSection(name.take(127))
    }

    Function("endSection") {
      Trace.endSection()
    }
  }
}
