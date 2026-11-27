package sh.paseo.refreshrate

import android.app.Activity
import android.os.Build
import android.view.Display
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Asks for the display's highest refresh rate through the window's `preferredRefreshRate`.
//
// ColorOS picks each window's refresh rate from a per-package table (`dumpsys oplusscreenmode`)
// and caps packages it does not list at 60 Hz, touch boost included. Layer votes
// (`View.setRequestedFrameRate`, `SurfaceControl.Transaction.setFrameRate`) reach SurfaceFlinger
// but stay under that cap; the window attribute is what the policy reads. It raises the ceiling
// only: a static screen still drops to the system's idle rate. Other Android builds keep their
// own policy. See docs/android.md.
class PaseoRefreshRateModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PaseoRefreshRate")

    OnActivityEntersForeground {
      if (!usesColorOsRefreshRatePolicy(Build.MANUFACTURER, Build.BRAND)) return@OnActivityEntersForeground
      val activity = appContext.currentActivity ?: return@OnActivityEntersForeground
      activity.runOnUiThread { preferPeakRefreshRate(activity) }
    }
  }

  private fun preferPeakRefreshRate(activity: Activity) {
    val display = activity.window.decorView.display ?: return
    val peak = peakRefreshRate(display.supportedModes.map { it.spec() }, display.mode.spec()) ?: return
    val attrs = activity.window.attributes
    if (attrs.preferredRefreshRate == peak) return
    attrs.preferredRefreshRate = peak
    activity.window.attributes = attrs
  }

  private fun Display.Mode.spec() = DisplayModeSpec(physicalWidth, physicalHeight, refreshRate)
}
