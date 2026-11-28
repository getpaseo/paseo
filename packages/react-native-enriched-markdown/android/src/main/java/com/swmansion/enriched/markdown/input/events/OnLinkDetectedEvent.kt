package com.swmansion.enriched.markdown.input.events

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

class OnLinkDetectedEvent(
  surfaceId: Int,
  viewId: Int,
  private val text: String,
  private val url: String,
  private val start: Int,
  private val end: Int,
) : Event<OnLinkDetectedEvent>(surfaceId, viewId) {
  override fun getEventName(): String = EVENT_NAME

  override fun getEventData(): WritableMap =
    Arguments.createMap().apply {
      putString("text", text)
      putString("url", url)
      putInt("start", start)
      putInt("end", end)
    }

  companion object {
    const val EVENT_NAME = "onLinkDetected"
  }
}
