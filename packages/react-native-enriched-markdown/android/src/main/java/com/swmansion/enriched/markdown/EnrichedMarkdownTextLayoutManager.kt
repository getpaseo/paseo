package com.swmansion.enriched.markdown

import com.facebook.react.bridge.Arguments

class EnrichedMarkdownTextLayoutManager(
  private val view: EnrichedMarkdownText,
) {
  private var forceHeightRecalculationCounter = 0

  fun invalidateLayout() {
    val text = view.text
    val paint = view.paint
    val heightChanged = MeasurementStore.store(view.id, text, paint, view.trailingMarginBottomPx())
    if (!heightChanged) return
    val stateWrapper = view.stateWrapper ?: return
    val state = Arguments.createMap()
    state.putInt("forceHeightRecalculationCounter", ++forceHeightRecalculationCounter)
    stateWrapper.updateState(state)
  }

  fun releaseMeasurementStore() {
    MeasurementStore.release(view.id)
  }
}
