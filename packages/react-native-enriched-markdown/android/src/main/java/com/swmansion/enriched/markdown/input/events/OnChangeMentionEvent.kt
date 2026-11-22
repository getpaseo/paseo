package com.swmansion.enriched.markdown.input.events

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

class OnChangeMentionEvent(
  surfaceId: Int,
  viewId: Int,
  private val indicator: String,
  private val text: String,
) : Event<OnChangeMentionEvent>(surfaceId, viewId) {
  override fun getEventName(): String = EVENT_NAME

  override fun getEventData(): WritableMap =
    Arguments.createMap().apply {
      putString("indicator", indicator)
      putString("text", text)
    }

  companion object {
    const val EVENT_NAME = "onChangeMention"
  }
}
