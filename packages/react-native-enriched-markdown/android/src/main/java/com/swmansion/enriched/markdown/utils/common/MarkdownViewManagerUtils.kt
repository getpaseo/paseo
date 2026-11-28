package com.swmansion.enriched.markdown.utils.common

import android.view.View
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.uimanager.UIManagerHelper
import com.swmansion.enriched.markdown.accessibility.AccessibilityLabels
import com.swmansion.enriched.markdown.events.CodeBlockPressEvent
import com.swmansion.enriched.markdown.events.ContextMenuItemPressEvent
import com.swmansion.enriched.markdown.events.CopyPressEvent
import com.swmansion.enriched.markdown.events.LatexErrorEvent
import com.swmansion.enriched.markdown.events.LinkLongPressEvent
import com.swmansion.enriched.markdown.events.LinkPressEvent
import com.swmansion.enriched.markdown.events.TaskListItemPressEvent
import com.swmansion.enriched.markdown.parser.Md4cFlags
import com.swmansion.enriched.markdown.styles.LinkPillContent
import com.swmansion.enriched.markdown.utils.text.view.SelectionMenuConfig

fun markdownEventTypeConstants(): MutableMap<String, Any> {
  val map = mutableMapOf<String, Any>()
  map[LinkPressEvent.EVENT_NAME] = mapOf("registrationName" to LinkPressEvent.EVENT_NAME)
  map[LinkLongPressEvent.EVENT_NAME] =
    mapOf("registrationName" to LinkLongPressEvent.EVENT_NAME)
  map[TaskListItemPressEvent.EVENT_NAME] =
    mapOf("registrationName" to TaskListItemPressEvent.EVENT_NAME)
  map[CopyPressEvent.EVENT_NAME] =
    mapOf("registrationName" to CopyPressEvent.EVENT_NAME)
  map[CodeBlockPressEvent.EVENT_NAME] =
    mapOf("registrationName" to CodeBlockPressEvent.EVENT_NAME)
  map[ContextMenuItemPressEvent.EVENT_NAME] =
    mapOf("registrationName" to ContextMenuItemPressEvent.EVENT_NAME)
  map[LatexErrorEvent.EVENT_NAME] =
    mapOf("registrationName" to LatexErrorEvent.EVENT_NAME)
  return map
}

fun emitLinkPress(
  view: View,
  url: String,
  sourceType: String,
) {
  val context = view.context as com.facebook.react.bridge.ReactContext
  val surfaceId = UIManagerHelper.getSurfaceId(context)
  val eventDispatcher = UIManagerHelper.getEventDispatcherForReactTag(context, view.id)
  eventDispatcher?.dispatchEvent(LinkPressEvent(surfaceId, view.id, url, sourceType))
}

fun emitLinkLongPress(
  view: View,
  url: String,
) {
  val context = view.context as com.facebook.react.bridge.ReactContext
  val surfaceId = UIManagerHelper.getSurfaceId(context)
  val eventDispatcher = UIManagerHelper.getEventDispatcherForReactTag(context, view.id)
  eventDispatcher?.dispatchEvent(LinkLongPressEvent(surfaceId, view.id, url))
}

fun emitTaskListItemPress(
  view: View,
  taskIndex: Int,
  checked: Boolean,
  itemText: String,
) {
  val context = view.context as com.facebook.react.bridge.ReactContext
  val surfaceId = UIManagerHelper.getSurfaceId(context)
  val eventDispatcher = UIManagerHelper.getEventDispatcherForReactTag(context, view.id)
  eventDispatcher?.dispatchEvent(
    TaskListItemPressEvent(surfaceId, view.id, taskIndex, checked, itemText),
  )
}

fun emitCopyPress(
  view: View,
  code: String,
  language: String,
) {
  val context = view.context as com.facebook.react.bridge.ReactContext
  val surfaceId = UIManagerHelper.getSurfaceId(context)
  val eventDispatcher = UIManagerHelper.getEventDispatcherForReactTag(context, view.id)
  eventDispatcher?.dispatchEvent(
    CopyPressEvent(surfaceId, view.id, code, language),
  )
}

fun emitLatexError(
  view: View,
  source: String,
  message: String?,
  displayMode: Boolean,
) {
  val context = view.context as com.facebook.react.bridge.ReactContext
  val surfaceId = UIManagerHelper.getSurfaceId(context)
  val eventDispatcher = UIManagerHelper.getEventDispatcherForReactTag(context, view.id)
  eventDispatcher?.dispatchEvent(
    LatexErrorEvent(surfaceId, view.id, source, message, displayMode),
  )
}

fun emitCodeBlockPress(
  view: View,
  code: String,
  language: String,
) {
  val context = view.context as com.facebook.react.bridge.ReactContext
  val surfaceId = UIManagerHelper.getSurfaceId(context)
  val eventDispatcher = UIManagerHelper.getEventDispatcherForReactTag(context, view.id)
  eventDispatcher?.dispatchEvent(
    CodeBlockPressEvent(surfaceId, view.id, code, language),
  )
}

fun emitContextMenuItemPress(
  view: View,
  itemText: String,
  selectedText: String,
  selectionStart: Int,
  selectionEnd: Int,
) {
  val context = view.context as com.facebook.react.bridge.ReactContext
  val surfaceId = UIManagerHelper.getSurfaceId(context)
  val eventDispatcher = UIManagerHelper.getEventDispatcherForReactTag(context, view.id)
  eventDispatcher?.dispatchEvent(
    ContextMenuItemPressEvent(
      surfaceId,
      view.id,
      itemText,
      selectedText,
      selectionStart,
      selectionEnd,
    ),
  )
}

fun parseMd4cFlags(flags: ReadableMap?): Md4cFlags =
  Md4cFlags(
    underline = flags?.getBoolean("underline") ?: false,
    latexMath = FeatureFlags.IS_MATH_ENABLED && (flags?.getBoolean("latexMath") ?: true),
    superscript = flags?.getBoolean("superscript") ?: false,
    subscript = flags?.getBoolean("subscript") ?: false,
    highlight = flags?.getBoolean("highlight") ?: false,
    hardSoftBreaks = flags?.getBoolean("hardSoftBreaks") ?: false,
    preserveBlankLines = flags?.getBoolean("preserveBlankLines") ?: false,
    admonitions = flags?.getBoolean("admonitions") ?: true,
  )

fun parseContextMenuItems(value: ReadableArray?): List<String> =
  (0 until (value?.size() ?: 0)).mapNotNull { value?.getMap(it)?.getString("text") }

fun parseImageRequestHeaders(value: ReadableArray?): Map<String, String> =
  (0 until (value?.size() ?: 0))
    .mapNotNull { index ->
      val header = value?.getMap(index) ?: return@mapNotNull null
      val name = header.getString("name") ?: return@mapNotNull null
      val headerValue = header.getString("value") ?: return@mapNotNull null
      name to headerValue
    }.toMap()

fun parseLinkPillContent(value: ReadableArray?): Map<String, LinkPillContent> =
  (0 until (value?.size() ?: 0))
    .mapNotNull { index ->
      val entry = value?.getMap(index) ?: return@mapNotNull null
      val url = entry.getString("url") ?: return@mapNotNull null
      url to LinkPillContent.fromReadableMap(entry)
    }.toMap()

fun parseSelectionMenuConfig(value: ReadableMap?): SelectionMenuConfig {
  if (value == null) return SelectionMenuConfig()
  return SelectionMenuConfig(
    copyAsMarkdown = value.getBoolean("copyAsMarkdown"),
    copyImageUrl = value.getBoolean("copyImageUrl"),
    copyLabel = value.getString("copyLabel") ?: "",
    copyAsMarkdownLabel = value.getString("copyAsMarkdownLabel") ?: "",
    copyImageUrlLabel = value.getString("copyImageUrlLabel") ?: "",
    copyImageUrlsLabel = value.getString("copyImageUrlsLabel") ?: "",
    copyImageUrlPluralTemplates = parseStringList(value.getArray("copyImageUrlPluralTemplates")),
  )
}

fun parseAccessibilityLabels(value: ReadableMap?): AccessibilityLabels {
  if (value == null) return AccessibilityLabels()
  val list = value.getMap("list")
  val blockquote = value.getMap("blockquote")
  val table = value.getMap("table")
  val math = value.getMap("math")
  val rotor = value.getMap("rotor")
  return AccessibilityLabels(
    bulletPoint = list?.getString("bulletPoint") ?: "",
    nestedBulletPoint = list?.getString("nestedBulletPoint") ?: "",
    orderedItem = list?.getString("orderedItem") ?: "",
    nestedOrderedItem = list?.getString("nestedOrderedItem") ?: "",
    blockquote = blockquote?.getString("quote") ?: "",
    nestedBlockquote = blockquote?.getString("nestedQuote") ?: "",
    tableRow = table?.getString("row") ?: "",
    mathEquation = math?.getString("equation") ?: "",
    rotorHeadings = rotor?.getString("headings") ?: "",
    rotorLinks = rotor?.getString("links") ?: "",
    rotorImages = rotor?.getString("images") ?: "",
  )
}

private fun parseStringList(value: ReadableArray?): List<String> = (0 until (value?.size() ?: 0)).mapNotNull { value?.getString(it) }
