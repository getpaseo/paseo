package com.swmansion.enriched.markdown.utils.common

import android.text.Layout

/**
 * Resolves a textBreakStrategy prop value (string) to the integer constant used
 * by StaticLayout.Builder.setBreakStrategy() and TextView.setBreakStrategy().
 *
 * Stateless on purpose: textBreakStrategy is a per-view prop. Storage lives in
 * [com.swmansion.enriched.markdown.MeasurementStore] (per viewId), and each
 * view applies the resolved value to its own TextView. Both measurement and
 * render paths must use the same value — mismatch causes measured line count
 * to differ from the rendered line count, sizing the view incorrectly and
 * causing ScrollingMovementMethod (inherited via LinkMovementMethod) to
 * silently scroll the overflow.
 *
 * Note: call sites in StaticLayout.Builder suppress "WrongConstant" lint. This is
 * intentional - Layout.BREAK_STRATEGY_SIMPLE and LineBreaker.BREAK_STRATEGY_SIMPLE
 * are the same integer (0), but the @IntDef annotation on StaticLayout.Builder
 * .setBreakStrategy() was changed from Layout.* to LineBreaker.* in API 29.
 * The suppression is safe; the Layout.* constants share the same integer values.
 */
object BreakStrategyUtils {
  const val DEFAULT_STRATEGY = "highQuality"

  fun resolveBreakStrategy(strategy: String?): Int =
    when (strategy) {
      "simple" -> Layout.BREAK_STRATEGY_SIMPLE
      "balanced" -> Layout.BREAK_STRATEGY_BALANCED
      else -> Layout.BREAK_STRATEGY_HIGH_QUALITY
    }
}
