package com.swmansion.enriched.markdown.input.events

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event
import com.swmansion.enriched.markdown.input.model.CaretRect

class OnCaretRectChangeEvent(
  surfaceId: Int,
  viewId: Int,
  private val rect: CaretRect,
) : Event<OnCaretRectChangeEvent>(surfaceId, viewId) {
  override fun getEventName(): String = EVENT_NAME

  override fun getEventData(): WritableMap = Arguments.createMap().also { rect.putInto(it) }

  companion object {
    const val EVENT_NAME = "onCaretRectChange"
  }
}
