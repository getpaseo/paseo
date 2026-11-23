package com.swmansion.enriched.markdown.utils.common

import android.text.TextUtils.TruncateAt

/**
 * Resolves an ellipsizeMode prop value (string) to the TruncateAt used by
 * StaticLayout.Builder.setEllipsize() and TextView.setEllipsize().
 *
 * "clip" maps to null: with maxLines set, the layout still truncates but draws
 * no ellipsis glyph. Mirrors React Native's TextAttributeProps.getEllipsizeMode.
 *
 * Stateless like [BreakStrategyUtils]: the mode is a per-view prop stored per
 * viewId in [com.swmansion.enriched.markdown.MeasurementStore]. Measurement and
 * render paths must resolve the same value, or the measured line count diverges
 * from the rendered one and the view is sized incorrectly.
 */
object EllipsizeUtils {
  const val DEFAULT_MODE = "tail"

  fun resolveTruncateAt(mode: String?): TruncateAt? =
    when (mode) {
      "head" -> TruncateAt.START
      "middle" -> TruncateAt.MIDDLE
      "clip" -> null
      else -> TruncateAt.END
    }
}
