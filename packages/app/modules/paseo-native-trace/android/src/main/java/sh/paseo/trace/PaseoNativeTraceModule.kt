package sh.paseo.trace

import android.os.Trace
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PaseoNativeTraceModule : Module() {
  private var recorder: DiagnosticRecorder? = null

  override fun definition() = ModuleDefinition {
    Name("PaseoNativeTrace")

    Function("startRecorder") { metadata: Map<String, String> ->
      if (recorder == null) {
        appContext.reactContext?.applicationContext?.let { recorder = DiagnosticRecorder(it, metadata) }
      }
      HeartbeatTiming.intervalMs
    }
    Function("record") { name: String, data: Map<String, String> -> recorder?.record(name, data) }
    Function("heartbeat") { recorder?.heartbeat() }
    OnActivityEntersForeground { recorder?.active(true) }
    OnActivityEntersBackground { recorder?.active(false) }
    OnDestroy { recorder?.close(); recorder = null }

    Function("beginSection") { name: String ->
      Trace.beginSection(name.take(127))
    }

    Function("endSection") {
      Trace.endSection()
    }
  }
}
