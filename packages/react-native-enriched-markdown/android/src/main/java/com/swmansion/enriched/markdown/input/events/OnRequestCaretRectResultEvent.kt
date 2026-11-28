package com.swmansion.enriched.markdown.input.events

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event
import com.swmansion.enriched.markdown.input.model.CaretRect

class OnRequestCaretRectResultEvent(
  surfaceId: Int,
  viewId: Int,
  private val requestId: Int,
  private val rect: CaretRect,
) : Event<OnRequestCaretRectResultEvent>(surfaceId, viewId) {
  override fun getEventName(): String = EVENT_NAME

  override fun getEventData(): WritableMap =
    Arguments.createMap().apply {
      putInt("requestId", requestId)
      rect.putInto(this)
    }

  companion object {
    const val EVENT_NAME = "onRequestCaretRectResult"
  }
}
