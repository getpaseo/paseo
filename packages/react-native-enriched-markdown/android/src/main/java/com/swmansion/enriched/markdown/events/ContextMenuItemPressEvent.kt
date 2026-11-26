package com.swmansion.enriched.markdown.events

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

class ContextMenuItemPressEvent(
  surfaceId: Int,
  viewId: Int,
  private val itemText: String,
  private val selectedText: String,
  private val selectionStart: Int,
  private val selectionEnd: Int,
) : Event<ContextMenuItemPressEvent>(surfaceId, viewId) {
  override fun getEventName(): String = EVENT_NAME

  override fun getEventData(): WritableMap =
    Arguments.createMap().apply {
      putString("itemText", itemText)
      putString("selectedText", selectedText)
      putInt("selectionStart", selectionStart)
      putInt("selectionEnd", selectionEnd)
    }

  companion object {
    const val EVENT_NAME = "onContextMenuItemPress"
  }
}
