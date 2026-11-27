package com.swmansion.enriched.markdown.input.events

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

class OnInputKeyPressEvent(
  surfaceId: Int,
  viewId: Int,
  private val key: String,
) : Event<OnInputKeyPressEvent>(surfaceId, viewId) {
  override fun getEventName(): String = EVENT_NAME

  override fun getEventData(): WritableMap =
    Arguments.createMap().apply {
      putString("key", key)
    }

  override fun canCoalesce(): Boolean = false

  companion object {
    const val EVENT_NAME = "onInputKeyPress"
  }
}
