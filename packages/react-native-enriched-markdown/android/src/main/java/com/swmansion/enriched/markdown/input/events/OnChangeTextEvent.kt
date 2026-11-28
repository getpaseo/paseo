package com.swmansion.enriched.markdown.input.events

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

class OnChangeTextEvent(
  surfaceId: Int,
  viewId: Int,
  private val text: String,
) : Event<OnChangeTextEvent>(surfaceId, viewId) {
  override fun getEventName(): String = EVENT_NAME

  override fun getEventData(): WritableMap =
    Arguments.createMap().apply {
      putString("value", text)
    }

  companion object {
    const val EVENT_NAME = "onChangeText"
  }
}
