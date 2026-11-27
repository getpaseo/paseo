package com.swmansion.enriched.markdown.input.layout

import android.os.Build
import com.facebook.react.bridge.Arguments
import com.swmansion.enriched.markdown.input.EnrichedMarkdownTextInputView

class InputLayoutManager(
  private val view: EnrichedMarkdownTextInputView,
) {
  private var forceHeightRecalculationCounter = 0

  /**
   * Re-measures and asks Fabric to adopt a new height when the result
   * changed. Call after text, block ranges, or text attributes that feed
   * [InputMeasurementStore] are in their final state.
   *
   * This only affects React Native's Yoga height, not EditText's DynamicLayout.
   */
  fun invalidateLayout() {
    if (view.stateWrapper == null) return

    val needUpdate =
      InputMeasurementStore.store(
        id = view.id,
        text = view.text,
        textAttributes = view.textAttributes,
        hint = view.hint?.toString(),
        paint = view.paint,
        minimumFontMetrics =
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.VANILLA_ICE_CREAM) view.minimumFontMetrics else null,
        blockRanges = view.blockStore.allRanges,
        formatter = view.formatter,
      )
    if (!needUpdate) return

    val state = Arguments.createMap()
    state.putInt("forceHeightRecalculationCounter", forceHeightRecalculationCounter++)
    view.stateWrapper?.updateState(state)
  }

  fun release() {
    InputMeasurementStore.release(view.id)
  }
}
