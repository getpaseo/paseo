package sh.paseo.refreshrate

internal data class DisplayModeSpec(val width: Int, val height: Int, val refreshRate: Float)

// The highest refresh rate the display offers without changing resolution.
internal fun peakRefreshRate(modes: List<DisplayModeSpec>, current: DisplayModeSpec): Float? =
  modes
    .filter { it.width == current.width && it.height == current.height }
    .maxOfOrNull { it.refreshRate }

// OPPO, OnePlus and realme ship the same ColorOS display framework and its per-package refresh
// rate table. Elsewhere the system's own policy already gives the app the panel's peak.
internal fun usesColorOsRefreshRatePolicy(manufacturer: String, brand: String): Boolean {
  val identity = "$manufacturer $brand".lowercase()
  return listOf("oppo", "oneplus", "realme").any { identity.contains(it) }
}
