package com.swmansion.enriched.markdown.input.layout

import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.events.Event
import com.swmansion.enriched.markdown.input.EnrichedMarkdownTextInputView
import com.swmansion.enriched.markdown.input.events.OnCaretRectChangeEvent
import com.swmansion.enriched.markdown.input.events.OnChangeMarkdownEvent
import com.swmansion.enriched.markdown.input.events.OnChangeMentionEvent
import com.swmansion.enriched.markdown.input.events.OnChangeSelectionEvent
import com.swmansion.enriched.markdown.input.events.OnChangeStateEvent
import com.swmansion.enriched.markdown.input.events.OnChangeTextEvent
import com.swmansion.enriched.markdown.input.events.OnContextMenuItemPressEvent
import com.swmansion.enriched.markdown.input.events.OnEndMentionEvent
import com.swmansion.enriched.markdown.input.events.OnInputBlurEvent
import com.swmansion.enriched.markdown.input.events.OnInputFocusEvent
import com.swmansion.enriched.markdown.input.events.OnInputKeyPressEvent
import com.swmansion.enriched.markdown.input.events.OnLinkDetectedEvent
import com.swmansion.enriched.markdown.input.events.OnRequestCaretRectResultEvent
import com.swmansion.enriched.markdown.input.events.OnRequestMarkdownResultEvent
import com.swmansion.enriched.markdown.input.events.OnStartMentionEvent
import com.swmansion.enriched.markdown.input.formatting.MarkdownSerializer
import com.swmansion.enriched.markdown.input.model.BlockType
import com.swmansion.enriched.markdown.input.model.CaretRect
import com.swmansion.enriched.markdown.input.model.StyleType

class InputEventEmitter(
  private val view: EnrichedMarkdownTextInputView,
) {
  private var prevState: Map<StyleType, Boolean> = emptyMap()
  private var prevLink: Pair<Boolean, String> = false to ""
  private var prevHeadingLevel: Int = 0
  private var prevUnorderedList: Pair<Boolean, Int> = false to 0
  private var prevOrderedList: Pair<Boolean, Int> = false to 0
  private var prevCaretRect: CaretRect? = null

  fun emitChangeText() {
    // The empty-list-line ZWSP anchor is an internal editing detail — never leak
    // it to JS. Both output paths (plain text here, markdown) funnel through the
    // same MarkdownSerializer.stripZwsp choke point.
    val plainText = MarkdownSerializer.stripZwsp(view.text?.toString() ?: "")
    dispatch(OnChangeTextEvent(surfaceId(), view.id, plainText))
  }

  fun emitChangeMarkdown() {
    dispatch(OnChangeMarkdownEvent(surfaceId(), view.id, serializeToMarkdown()))
  }

  fun emitSelection(
    start: Int,
    end: Int,
  ): Boolean = dispatch(OnChangeSelectionEvent(surfaceId(), view.id, start, end))

  fun emitState() {
    val pos = view.selectionStart
    val linkRange = view.linkForSelection(view.selectionStart, view.selectionEnd)
    val link = (linkRange != null) to linkRange?.url.orEmpty()
    val current =
      StyleType.entries.associateWith { style ->
        isStyleEffectivelyActive(style, pos)
      }
    val headingLevel = view.headingLevelAtCursor()
    val unorderedList = view.listStateAtCursor(BlockType.UNORDERED_LIST_ITEM)
    val orderedList = view.listStateAtCursor(BlockType.ORDERED_LIST_ITEM)

    if (current == prevState && headingLevel == prevHeadingLevel && unorderedList == prevUnorderedList &&
      orderedList == prevOrderedList && link == prevLink
    ) {
      return
    }
    prevState = current
    prevLink = link
    prevHeadingLevel = headingLevel
    prevUnorderedList = unorderedList
    prevOrderedList = orderedList

    dispatch(
      OnChangeStateEvent(
        surfaceId(),
        view.id,
        current[StyleType.BOLD] ?: false,
        current[StyleType.ITALIC] ?: false,
        current[StyleType.UNDERLINE] ?: false,
        current[StyleType.STRIKETHROUGH] ?: false,
        current[StyleType.SPOILER] ?: false,
        link.first,
        link.second,
        headingLevel,
        unorderedList.first,
        unorderedList.second,
        orderedList.first,
        orderedList.second,
      ),
    )
  }

  fun emitKeyPress(key: String) {
    dispatch(OnInputKeyPressEvent(surfaceId(), view.id, key))
  }

  fun emitFocus() {
    dispatch(OnInputFocusEvent(surfaceId(), view.id))
  }

  fun emitBlur() {
    dispatch(OnInputBlurEvent(surfaceId(), view.id))
  }

  fun emitLinkDetected(
    text: String,
    url: String,
    start: Int,
    end: Int,
  ) {
    dispatch(OnLinkDetectedEvent(surfaceId(), view.id, text, url, start, end))
  }

  fun emitStartMention(indicator: String) {
    dispatch(OnStartMentionEvent(surfaceId(), view.id, indicator))
  }

  fun emitChangeMention(
    indicator: String,
    text: String,
  ) {
    dispatch(OnChangeMentionEvent(surfaceId(), view.id, indicator, text))
  }

  fun emitEndMention(indicator: String) {
    dispatch(OnEndMentionEvent(surfaceId(), view.id, indicator))
  }

  fun emitRequestMarkdownResult(requestId: Int) {
    dispatch(OnRequestMarkdownResultEvent(surfaceId(), view.id, requestId, serializeToMarkdown()))
  }

  fun emitRequestCaretRectResult(requestId: Int) {
    val rect = computeCaretRect()
    dispatch(OnRequestCaretRectResultEvent(surfaceId(), view.id, requestId, rect))
  }

  fun emitCaretRectChangeIfNeeded() {
    val rect = computeCaretRect()
    if (rect == prevCaretRect) return

    prevCaretRect = rect
    dispatch(OnCaretRectChangeEvent(surfaceId(), view.id, rect))
  }

  private fun computeCaretRect(): CaretRect {
    val textLayout = view.layout
    val cursorOffset = view.selectionStart

    if (textLayout == null || cursorOffset < 0) {
      return CaretRect(0f, 0f, 0f, 0f)
    }

    val line = textLayout.getLineForOffset(cursorOffset)
    val rawX = textLayout.getPrimaryHorizontal(cursorOffset) + view.paddingLeft
    val rawY = (textLayout.getLineTop(line) + view.paddingTop).toFloat()
    val rawBottom = (textLayout.getLineBottom(line) + view.paddingTop).toFloat()
    val density = view.resources.displayMetrics.density

    return CaretRect(
      x = rawX / density,
      y = rawY / density,
      width = 2f / density,
      height = (rawBottom - rawY) / density,
    )
  }

  fun emitContextMenuItemPress(
    itemText: String,
    selectedText: String,
    selectionStart: Int,
    selectionEnd: Int,
  ) {
    val store = view.formattingStore
    val isSelection = selectionStart < selectionEnd

    fun isActive(type: StyleType) =
      if (isSelection) {
        store.isStyleActiveInRange(type, selectionStart, selectionEnd)
      } else {
        isStyleEffectivelyActive(type, selectionStart)
      }

    val contextMenuListState = view.listStateAtCursor(BlockType.UNORDERED_LIST_ITEM)
    val contextMenuOrderedState = view.listStateAtCursor(BlockType.ORDERED_LIST_ITEM)
    val link = view.linkForSelection(selectionStart, selectionEnd)
    dispatch(
      OnContextMenuItemPressEvent(
        surfaceId(),
        view.id,
        itemText,
        selectedText,
        selectionStart,
        selectionEnd,
        isBold = isActive(StyleType.BOLD),
        isItalic = isActive(StyleType.ITALIC),
        isUnderline = isActive(StyleType.UNDERLINE),
        isStrikethrough = isActive(StyleType.STRIKETHROUGH),
        isSpoiler = isActive(StyleType.SPOILER),
        isLink = link != null,
        linkDestination = link?.url.orEmpty(),
        headingLevel = view.headingLevelAtCursor(),
        isUnorderedList = contextMenuListState.first,
        unorderedListDepth = contextMenuListState.second,
        isOrderedList = contextMenuOrderedState.first,
        orderedListDepth = contextMenuOrderedState.second,
      ),
    )
  }

  private fun isStyleEffectivelyActive(
    style: StyleType,
    pos: Int,
  ): Boolean {
    if (style == StyleType.LINK) {
      return view.linkForSelection(view.selectionStart, view.selectionEnd) != null
    }
    return view.pendingStyles.contains(style) ||
      (
        !view.pendingStyleRemovals.contains(style) &&
          view.formattingStore.isStyleActive(style, pos)
      )
  }

  private fun serializeToMarkdown(): String {
    val plainText = view.text?.toString() ?: ""
    // Each block resolves its markdown line prefix through its registered handler.
    // With no block handlers registered the provider returns "" for every block
    // and output equals the inline-only serialization.
    return MarkdownSerializer.serialize(
      plainText,
      view.allFormattingRangesForSerialization(),
      view.blockStore.allRanges,
    ) { blockRange ->
      view.formatter.handlerForBlock(blockRange.type)?.markdownLinePrefix(blockRange) ?: ""
    }
  }

  private fun surfaceId(): Int {
    val reactContext = view.context as? ReactContext ?: return -1
    return UIManagerHelper.getSurfaceId(reactContext)
  }

  /** Returns true when [event] was handed to the React event dispatcher */
  private fun dispatch(event: Event<*>): Boolean {
    if (view.editSession.shouldSuppressEvents) return false
    val reactContext = view.context as? ReactContext ?: return false
    val dispatcher =
      UIManagerHelper.getEventDispatcherForReactTag(reactContext, view.id) ?: return false
    dispatcher.dispatchEvent(event)
    return true
  }
}
