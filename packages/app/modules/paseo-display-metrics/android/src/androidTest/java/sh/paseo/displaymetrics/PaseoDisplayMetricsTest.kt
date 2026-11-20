package sh.paseo.displaymetrics

import android.util.DisplayMetrics
import android.util.TypedValue
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.facebook.react.uimanager.PixelUtil
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class PaseoDisplayMetricsTest {
  private lateinit var display: DisplayMetrics

  @Before
  fun readDisplayLikeReactNative() {
    DisplayMetricsHolder.initDisplayMetrics(InstrumentationRegistry.getInstrumentation().targetContext)
    display = DisplayMetricsHolder.getScreenDisplayMetrics()
  }

  @After
  fun forgetDisplay() {
    DisplayMetricsHolder.setScreenDisplayMetrics(null)
  }

  @Test
  fun reservesRoomForTextAtTheWindowDensity() {
    // A DeX window at two thirds of the phone's density (240 dpi on a 360 dpi phone). React Native
    // reads the font scale from the window but the density from the phone's display.
    val window = windowAt(display.densityDpi * 2 / 3)
    DisplayMetricsHolder.setScreenDisplayMetrics(
      DisplayMetrics().apply {
        setTo(display)
        scaledDensity = window.scaledDensity
      },
    )
    assertTrue(reservedTextPx(window) < drawnTextPx())

    PaseoDisplayMetrics.syncWithWindow(window)

    assertEquals(drawnTextPx(), reservedTextPx(window), 0.01f)
    assertEquals(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 16f, window), drawnTextPx(), 0.01f)
    val synced = DisplayMetricsHolder.getScreenDisplayMetrics()
    assertEquals(window.densityDpi, synced.densityDpi)
    assertEquals(display.widthPixels, synced.widthPixels)
    assertEquals(display.heightPixels, synced.heightPixels)
  }

  @Test
  fun leavesTheBuiltInDisplayAlone() {
    PaseoDisplayMetrics.syncWithWindow(windowAt(display.densityDpi))

    assertSame(display, DisplayMetricsHolder.getScreenDisplayMetrics())
  }

  @Test
  fun waitsForReactNativeToReadTheDisplay() {
    DisplayMetricsHolder.setScreenDisplayMetrics(null)

    PaseoDisplayMetrics.syncWithWindow(windowAt(display.densityDpi / 2))

    assertThrows(IllegalStateException::class.java) { DisplayMetricsHolder.getScreenDisplayMetrics() }
  }

  private fun windowAt(densityDpi: Int): DisplayMetrics =
    DisplayMetrics().apply {
      setTo(display)
      this.densityDpi = densityDpi
      density = densityDpi.toFloat() / DisplayMetrics.DENSITY_DEFAULT
      scaledDensity = density * display.scaledDensity / display.density
    }

  /** A 16sp font as React Native draws it, in pixels. */
  private fun drawnTextPx(): Float = PixelUtil.toPixelFromSP(16f)

  /** The box React Native lays out for that font, once the window renders it in pixels. */
  private fun reservedTextPx(window: DisplayMetrics): Float =
    PixelUtil.toDIPFromPixel(drawnTextPx()) * window.density
}
