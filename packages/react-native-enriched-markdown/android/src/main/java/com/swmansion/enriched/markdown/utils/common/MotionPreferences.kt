package com.swmansion.enriched.markdown.utils.common

import android.animation.ValueAnimator
import android.content.Context
import android.os.Build

/**
 * Returns true when the user has asked the system to minimise motion.
 *
 * On API 26+ delegates to [ValueAnimator.areAnimatorsEnabled], which covers
 * the "Remove animations" accessibility setting, the "Animator duration scale"
 * developer toggle, and Battery Saver mode. Older API levels do not expose an
 * equivalent flag, hence the fall back to allowing animations.
 */
fun isReducedMotionEnabled(context: Context): Boolean {
  if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
  return !ValueAnimator.areAnimatorsEnabled()
}
