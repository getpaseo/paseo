package sh.paseo.refreshrate

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PeakRefreshRateTest {
  private fun mode(width: Int, height: Int, rate: Float) = DisplayModeSpec(width, height, rate)

  @Test fun picksTheHighestRateAtTheCurrentResolution() {
    val current = mode(1980, 2800, 60f)
    val modes = listOf(
      mode(1980, 2800, 120.00001f),
      mode(1980, 2800, 90f),
      current,
      mode(1980, 2800, 30.000002f),
    )

    assertEquals(120.00001f, peakRefreshRate(modes, current))
  }

  @Test fun ignoresFasterModesThatChangeResolution() {
    val current = mode(1080, 2400, 60f)
    val modes = listOf(current, mode(1080, 2400, 90f), mode(720, 1600, 120f))

    assertEquals(90f, peakRefreshRate(modes, current))
  }

  @Test fun returnsNullWhenNoModeMatchesTheCurrentResolution() {
    assertNull(peakRefreshRate(listOf(mode(720, 1600, 120f)), mode(1080, 2400, 60f)))
  }

  @Test fun appliesToColorOsBrands() {
    assertTrue(usesColorOsRefreshRatePolicy("OPPO", "OPPO"))
    assertTrue(usesColorOsRefreshRatePolicy("OnePlus", "OnePlus"))
    assertTrue(usesColorOsRefreshRatePolicy("realme", "realme"))
  }

  @Test fun leavesOtherBrandsToTheSystemPolicy() {
    assertFalse(usesColorOsRefreshRatePolicy("Google", "google"))
    assertFalse(usesColorOsRefreshRatePolicy("samsung", "samsung"))
    assertFalse(usesColorOsRefreshRatePolicy("Xiaomi", "Redmi"))
  }
}
