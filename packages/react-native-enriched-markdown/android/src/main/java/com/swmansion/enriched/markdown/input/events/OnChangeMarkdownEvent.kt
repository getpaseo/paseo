package com.swmansion.enriched.markdown.input.events

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

class OnChangeMarkdownEvent(
  surfaceId: Int,
  viewId: Int,
  private val markdown: String,
) : Event<OnChangeMarkdownEvent>(surfaceId, viewId) {
  override fun getEventName(): String = EVENT_NAME

  override fun getEventData(): WritableMap =
    Arguments.createMap().apply {
      putString("value", markdown)
    }

  companion object {
    const val EVENT_NAME = "onChangeMarkdown"
  }
}
