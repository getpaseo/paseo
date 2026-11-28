package com.swmansion.enriched.markdown.events

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

class CodeBlockPressEvent(
  surfaceId: Int,
  viewId: Int,
  private val code: String,
  private val language: String,
) : Event<CodeBlockPressEvent>(surfaceId, viewId) {
  override fun getEventName(): String = EVENT_NAME

  override fun getEventData(): WritableMap =
    Arguments.createMap().apply {
      putString("code", code)
      putString("language", language)
    }

  companion object {
    const val EVENT_NAME: String = "onCodeBlockPress"
  }
}
