package com.swmansion.enriched.markdown.input.events

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableMap
import com.facebook.react.uimanager.events.Event

class OnContextMenuItemPressEvent(
  surfaceId: Int,
  viewId: Int,
  private val itemText: String,
  private val selectedText: String,
  private val selectionStart: Int,
  private val selectionEnd: Int,
  private val isBold: Boolean,
  private val isItalic: Boolean,
  private val isUnderline: Boolean,
  private val isStrikethrough: Boolean,
  private val isSpoiler: Boolean,
  private val isLink: Boolean,
  private val linkDestination: String,
  private val headingLevel: Int,
  private val isUnorderedList: Boolean,
  private val unorderedListDepth: Int,
  private val isOrderedList: Boolean,
  private val orderedListDepth: Int,
) : Event<OnContextMenuItemPressEvent>(surfaceId, viewId) {
  override fun getEventName(): String = EVENT_NAME

  override fun getEventData(): WritableMap {
    fun styleEntry(isActive: Boolean) = Arguments.createMap().apply { putBoolean("isActive", isActive) }

    fun linkEntry(
      isActive: Boolean,
      destination: String,
    ) = Arguments.createMap().apply {
      putBoolean("isActive", isActive)
      putString("destination", destination)
    }

    return Arguments.createMap().apply {
      putString("itemText", itemText)
      putString("selectedText", selectedText)
      putInt("selectionStart", selectionStart)
      putInt("selectionEnd", selectionEnd)
      putMap(
        "styleState",
        Arguments.createMap().apply {
          putMap("bold", styleEntry(isBold))
          putMap("italic", styleEntry(isItalic))
          putMap("underline", styleEntry(isUnderline))
          putMap("strikethrough", styleEntry(isStrikethrough))
          putMap("spoiler", styleEntry(isSpoiler))
          putMap("link", linkEntry(isLink, linkDestination))
          putMap(
            "heading",
            Arguments.createMap().apply {
              putBoolean("isActive", headingLevel > 0)
              putInt("level", headingLevel)
            },
          )
          putMap(
            "unorderedList",
            Arguments.createMap().apply {
              putBoolean("isActive", isUnorderedList)
              putInt("depth", unorderedListDepth)
            },
          )
          putMap(
            "orderedList",
            Arguments.createMap().apply {
              putBoolean("isActive", isOrderedList)
              putInt("depth", orderedListDepth)
            },
          )
        },
      )
    }
  }

  companion object {
    const val EVENT_NAME = "onContextMenuItemPress"
  }
}
