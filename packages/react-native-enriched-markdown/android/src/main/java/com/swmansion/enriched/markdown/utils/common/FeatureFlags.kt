package com.swmansion.enriched.markdown.utils.common

import com.swmansion.enriched.markdown.BuildConfig

object FeatureFlags {
  const val IS_MATH_ENABLED: Boolean = BuildConfig.ENABLE_MATH
  const val IS_VIDEO_ENABLED: Boolean = BuildConfig.ENABLE_VIDEO
  const val IS_CODE_HIGHLIGHT_ENABLED: Boolean = BuildConfig.ENABLE_CODE_HIGHLIGHT
}
