package com.swmansion.enriched.markdown.events

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

class TaskListItemPressEvent(
  surfaceId: Int,
  viewId: Int,
  private val taskIndex: Int,
  private val checked: Boolean,
  private val itemText: String,
) : Event<TaskListItemPressEvent>(surfaceId, viewId) {
  override fun getEventName(): String = EVENT_NAME

  override fun getEventData(): WritableMap =
    Arguments.createMap().apply {
      putInt("index", taskIndex)
      putBoolean("checked", checked)
      putString("text", itemText)
    }

  companion object {
    const val EVENT_NAME: String = "onTaskListItemPress"
  }
}
