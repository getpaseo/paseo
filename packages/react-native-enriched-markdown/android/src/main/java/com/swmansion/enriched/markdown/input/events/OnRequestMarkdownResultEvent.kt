package com.swmansion.enriched.markdown.input.events

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

class OnRequestMarkdownResultEvent(
  surfaceId: Int,
  viewId: Int,
  private val requestId: Int,
  private val markdown: String,
) : Event<OnRequestMarkdownResultEvent>(surfaceId, viewId) {
  override fun getEventName(): String = EVENT_NAME

  override fun getEventData(): WritableMap =
    Arguments.createMap().apply {
      putInt("requestId", requestId)
      putString("markdown", markdown)
    }

  companion object {
    const val EVENT_NAME = "onRequestMarkdownResult"
  }
}
