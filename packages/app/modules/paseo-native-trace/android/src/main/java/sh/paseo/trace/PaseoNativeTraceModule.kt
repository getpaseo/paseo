package sh.paseo.trace

import android.os.Trace
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PaseoNativeTraceModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PaseoNativeTrace")

    Function("beginSection") { name: String ->
      Trace.beginSection(name.take(127))
    }

    Function("endSection") {
      Trace.endSection()
    }
  }
}
