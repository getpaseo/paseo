package com.swmansion.enriched.markdown.events

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

class ImagePressEvent(
  surfaceId: Int,
  viewId: Int,
  private val url: String,
  private val altText: String,
) : Event<ImagePressEvent>(surfaceId, viewId) {
  override fun getEventName(): String = EVENT_NAME

  override fun getEventData(): WritableMap {
    val eventData: WritableMap = Arguments.createMap()
    eventData.putString("url", url)
    eventData.putString("altText", altText)
    return eventData
  }

  companion object {
    const val EVENT_NAME: String = "onImagePress"
  }
}
