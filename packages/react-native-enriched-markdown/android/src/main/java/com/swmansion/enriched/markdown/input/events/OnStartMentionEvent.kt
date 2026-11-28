package com.swmansion.enriched.markdown.input.events

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

class OnStartMentionEvent(
  surfaceId: Int,
  viewId: Int,
  private val indicator: String,
) : Event<OnStartMentionEvent>(surfaceId, viewId) {
  override fun getEventName(): String = EVENT_NAME

  override fun getEventData(): WritableMap =
    Arguments.createMap().apply {
      putString("indicator", indicator)
    }

  companion object {
    const val EVENT_NAME = "onStartMention"
  }
}
