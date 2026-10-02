package sh.paseo.screengeometry

import android.os.Build
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PaseoScreenGeometryModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PaseoScreenGeometry")

    Function("getPhysicalScreenSize") {
      val activity = appContext.currentActivity ?: throw Exceptions.MissingActivity()
      val display = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        activity.display
      } else {
        @Suppress("DEPRECATION")
        activity.windowManager.defaultDisplay
      }
      val mode = display.mode
      val density = activity.resources.displayMetrics.density
      mapOf(
        "width" to mode.physicalWidth / density,
        "height" to mode.physicalHeight / density,
      )
    }
  }
}
