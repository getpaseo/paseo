package sh.paseo.displaymetrics

import android.app.Activity
import android.util.DisplayMetrics
import com.facebook.react.uimanager.DisplayMetricsHolder

/**
 * React Native 0.86 converts between px and dp, and so sizes text, with the density of the
 * device's built-in display, because `DisplayMetricsHolder` reads `Display.getRealMetrics()`.
 * Fabric lays out at the window's density. On a display with another density, such as a Samsung
 * DeX monitor, text boxes come out too small and clip their text.
 *
 * Backports react/react-native#59087 (`useWindowDensityForDisplayMetricsAndroid`): keep the
 * window's density and take only the size from the display. Remove once the app runs React Native
 * 0.89 or later with that flag on.
 */
object PaseoDisplayMetrics {
  /** Call right after React Native reads the display, which it does again on each configuration change. */
  @JvmStatic
  fun syncWithWindow(activity: Activity) {
    syncWithWindow(activity.resources.displayMetrics)
  }

  @JvmStatic
  fun syncWithWindow(window: DisplayMetrics) {
    val screen =
      try {
        DisplayMetricsHolder.getScreenDisplayMetrics()
      } catch (_: IllegalStateException) {
        // React Native hasn't read the display yet, so there is nothing to correct.
        return
      }
    if (screen.densityDpi == window.densityDpi) return

    DisplayMetricsHolder.setScreenDisplayMetrics(
      DisplayMetrics().apply {
        setTo(screen)
        density = window.density
        densityDpi = window.densityDpi
      },
    )
  }
}
