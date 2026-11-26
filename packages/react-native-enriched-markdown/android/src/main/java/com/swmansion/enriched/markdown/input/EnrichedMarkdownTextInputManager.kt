package com.swmansion.enriched.markdown.input

import android.content.Context
import android.graphics.Color
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.ReactStylesDiffMap
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.StateWrapper
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.viewmanagers.EnrichedMarkdownTextInputManagerDelegate
import com.facebook.react.viewmanagers.EnrichedMarkdownTextInputManagerInterface
import com.facebook.yoga.YogaMeasureMode
import com.swmansion.enriched.markdown.input.editing.MarkdownShortcutsConfig
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
import com.swmansion.enriched.markdown.input.layout.InputMeasurementStore
import com.swmansion.enriched.markdown.input.model.StyleType
import com.swmansion.enriched.markdown.input.toolbar.FormatMenuConfig
import com.swmansion.enriched.markdown.input.toolbar.InputSelectionMenuConfig
import com.swmansion.enriched.markdown.utils.common.LinkRegexConfig
import com.swmansion.enriched.markdown.utils.input.BorderPropsApplicator
import com.swmansion.enriched.markdown.utils.input.MarkdownStyleParser

@ReactModule(name = EnrichedMarkdownTextInputManager.NAME)
class EnrichedMarkdownTextInputManager :
  SimpleViewManager<EnrichedMarkdownTextInputView>(),
  EnrichedMarkdownTextInputManagerInterface<EnrichedMarkdownTextInputView> {
  private val delegate: ViewManagerDelegate<EnrichedMarkdownTextInputView> =
    EnrichedMarkdownTextInputManagerDelegate(this)

  override fun getDelegate(): ViewManagerDelegate<EnrichedMarkdownTextInputView> = delegate

  override fun getName(): String = NAME

  override fun createViewInstance(reactContext: ThemedReactContext): EnrichedMarkdownTextInputView =
    EnrichedMarkdownTextInputView(reactContext)

  override fun updateState(
    view: EnrichedMarkdownTextInputView,
    props: ReactStylesDiffMap?,
    stateWrapper: StateWrapper?,
  ): Any? {
    view.stateWrapper = stateWrapper
    return super.updateState(view, props, stateWrapper)
  }

  override fun onAfterUpdateTransaction(view: EnrichedMarkdownTextInputView) {
    super.onAfterUpdateTransaction(view)
    view.afterUpdateTransaction()
  }

  override fun onDropViewInstance(view: EnrichedMarkdownTextInputView) {
    view.dismissActiveMention()
    super.onDropViewInstance(view)
    view.layoutManager.release()
  }

  override fun measure(
    context: Context,
    localData: ReadableMap?,
    props: ReadableMap?,
    state: ReadableMap?,
    width: Float,
    widthMode: YogaMeasureMode?,
    height: Float,
    heightMode: YogaMeasureMode?,
    attachmentsPositions: FloatArray?,
  ): Long {
    val id = localData?.getInt("viewTag")
    return InputMeasurementStore.getMeasureById(context, id, width, height, heightMode, props)
  }

  override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> =
    listOf(
      OnChangeTextEvent.EVENT_NAME,
      OnChangeMarkdownEvent.EVENT_NAME,
      OnChangeSelectionEvent.EVENT_NAME,
      OnChangeStateEvent.EVENT_NAME,
      OnInputKeyPressEvent.EVENT_NAME,
      OnRequestMarkdownResultEvent.EVENT_NAME,
      OnRequestCaretRectResultEvent.EVENT_NAME,
      OnCaretRectChangeEvent.EVENT_NAME,
      OnInputFocusEvent.EVENT_NAME,
      OnInputBlurEvent.EVENT_NAME,
      OnContextMenuItemPressEvent.EVENT_NAME,
      OnLinkDetectedEvent.EVENT_NAME,
      OnStartMentionEvent.EVENT_NAME,
      OnChangeMentionEvent.EVENT_NAME,
      OnEndMentionEvent.EVENT_NAME,
    ).associateWithTo(mutableMapOf()) { name -> mapOf("registrationName" to name) }

  // Props

  @ReactProp(name = "defaultValue")
  override fun setDefaultValue(
    view: EnrichedMarkdownTextInputView?,
    value: String?,
  ) {
    if (value != null && view?.text?.isEmpty() == true) {
      view.setValueFromJS(value)
    }
  }

  @ReactProp(name = "placeholder")
  override fun setPlaceholder(
    view: EnrichedMarkdownTextInputView?,
    value: String?,
  ) {
    view?.setUserHint(value)
  }

  @ReactProp(name = "placeholderTextColor", customType = "Color")
  override fun setPlaceholderTextColor(
    view: EnrichedMarkdownTextInputView?,
    value: Int?,
  ) {
    view?.setHintTextColor(value ?: Color.GRAY)
  }

  @ReactProp(name = "editable", defaultBoolean = true)
  override fun setEditable(
    view: EnrichedMarkdownTextInputView?,
    value: Boolean,
  ) {
    view?.isEnabled = value
  }

  @ReactProp(name = "autoFocus", defaultBoolean = false)
  override fun setAutoFocus(
    view: EnrichedMarkdownTextInputView?,
    value: Boolean,
  ) {
    view?.autoFocusRequested = value
  }

  @ReactProp(name = "scrollEnabled", defaultBoolean = true)
  override fun setScrollEnabled(
    view: EnrichedMarkdownTextInputView?,
    value: Boolean,
  ) {
    view?.scrollEnabled = value
    view?.isVerticalScrollBarEnabled = value
  }

  @ReactProp(name = "markdownShortcuts")
  override fun setMarkdownShortcuts(
    view: EnrichedMarkdownTextInputView?,
    value: ReadableMap?,
  ) {
    if (view == null) return
    view.markdownShortcuts =
      if (value == null) {
        MarkdownShortcutsConfig()
      } else {
        MarkdownShortcutsConfig(
          heading = value.getBoolean("heading"),
          unorderedList = value.getBoolean("unorderedList"),
          orderedList = value.getBoolean("orderedList"),
        )
      }
  }

  @ReactProp(name = "autoCapitalize")
  override fun setAutoCapitalize(
    view: EnrichedMarkdownTextInputView?,
    value: String?,
  ) {
    view?.setAutoCapitalize(value)
  }

  @ReactProp(name = "multiline", defaultBoolean = true)
  override fun setMultiline(
    view: EnrichedMarkdownTextInputView?,
    value: Boolean,
  ) {
    view?.isSingleLine = !value
  }

  @ReactProp(name = "cursorColor", customType = "Color")
  override fun setCursorColor(
    view: EnrichedMarkdownTextInputView?,
    value: Int?,
  ) {
    view?.setCursorColorFromProps(value)
  }

  @ReactProp(name = "selectionColor", customType = "Color")
  override fun setSelectionColor(
    view: EnrichedMarkdownTextInputView?,
    value: Int?,
  ) {
    if (value != null) {
      view?.highlightColor = value
    }
  }

  @ReactProp(name = "markdownStyle")
  override fun setMarkdownStyle(
    view: EnrichedMarkdownTextInputView?,
    value: ReadableMap?,
  ) {
    if (view == null || value == null) return

    view.setMarkdownStyleFromProps(MarkdownStyleParser.parse(value))
    // This call takes care of setting formattingDirty if needed, so we don't
    // need to explicitly apply formatting or set it here separately
  }

  @ReactProp(name = "color", customType = "Color")
  override fun setColor(
    view: EnrichedMarkdownTextInputView?,
    value: Int?,
  ) {
    view?.setColorFromProps(value)
  }

  @ReactProp(name = "fontSize", defaultFloat = 16f)
  override fun setFontSize(
    view: EnrichedMarkdownTextInputView?,
    value: Float,
  ) {
    view?.setFontSizeFromProps(value)
  }

  @ReactProp(name = "lineHeight", defaultFloat = 0f)
  override fun setLineHeight(
    view: EnrichedMarkdownTextInputView?,
    value: Float,
  ) {
    view?.setLineHeightFromProps(value)
  }

  @ReactProp(name = "fontFamily")
  override fun setFontFamily(
    view: EnrichedMarkdownTextInputView?,
    value: String?,
  ) {
    view?.setFontFamily(value)
  }

  @ReactProp(name = "fontWeight")
  override fun setFontWeight(
    view: EnrichedMarkdownTextInputView?,
    value: String?,
  ) {
    view?.setFontWeight(value)
  }

  @ReactProp(name = "isOnChangeMarkdownSet", defaultBoolean = false)
  override fun setIsOnChangeMarkdownSet(
    view: EnrichedMarkdownTextInputView?,
    value: Boolean,
  ) {
    view?.emitMarkdown = value
  }

  @ReactProp(name = "contextMenuItems")
  override fun setContextMenuItems(
    view: EnrichedMarkdownTextInputView?,
    value: ReadableArray?,
  ) {
    if (view == null) return
    val items = (0 until (value?.size() ?: 0)).mapNotNull { value?.getMap(it)?.getString("text") }
    view.setContextMenuItems(items)
  }

  @ReactProp(name = "selectionMenuConfig")
  override fun setSelectionMenuConfig(
    view: EnrichedMarkdownTextInputView?,
    value: ReadableMap?,
  ) {
    if (view == null) return
    view.contextMenu.selectionMenuConfig =
      if (value == null) {
        InputSelectionMenuConfig()
      } else {
        InputSelectionMenuConfig(
          format = value.getBoolean("format"),
          formatLabel = value.getString("formatLabel") ?: "",
          copyAsMarkdown = value.getBoolean("copyAsMarkdown"),
          copyAsMarkdownLabel = value.getString("copyAsMarkdownLabel") ?: "",
        )
      }
  }

  @ReactProp(name = "formatMenuConfig")
  override fun setFormatMenuConfig(
    view: EnrichedMarkdownTextInputView?,
    value: ReadableMap?,
  ) {
    if (view == null) return
    view.contextMenu.formatMenuConfig =
      if (value == null) {
        FormatMenuConfig()
      } else {
        FormatMenuConfig(
          bold = value.getBoolean("bold"),
          boldLabel = value.getString("boldLabel") ?: "",
          italic = value.getBoolean("italic"),
          italicLabel = value.getString("italicLabel") ?: "",
          underline = value.getBoolean("underline"),
          underlineLabel = value.getString("underlineLabel") ?: "",
          strikethrough = value.getBoolean("strikethrough"),
          strikethroughLabel = value.getString("strikethroughLabel") ?: "",
          spoiler = value.getBoolean("spoiler"),
          spoilerLabel = value.getString("spoilerLabel") ?: "",
          link = value.getBoolean("link"),
          linkLabel = value.getString("linkLabel") ?: "",
        )
      }
  }

  @ReactProp(name = "linkRegex")
  override fun setLinkRegex(
    view: EnrichedMarkdownTextInputView?,
    value: ReadableMap?,
  ) {
    if (view == null) return
    val config =
      if (value != null) {
        LinkRegexConfig(
          pattern = value.getString("pattern") ?: "",
          caseInsensitive = value.getBoolean("caseInsensitive"),
          dotAll = value.getBoolean("dotAll"),
          isDisabled = value.getBoolean("isDisabled"),
          isDefault = value.getBoolean("isDefault"),
        )
      } else {
        LinkRegexConfig("", caseInsensitive = false, dotAll = false, isDisabled = false, isDefault = true)
      }
    view.setLinkRegex(config)
  }

  @ReactProp(name = "mentionIndicators")
  override fun setMentionIndicators(
    view: EnrichedMarkdownTextInputView?,
    value: ReadableArray?,
  ) {
    val indicators =
      (0 until (value?.size() ?: 0))
        .mapNotNull { value?.getString(it) }
        .filter { it.isNotEmpty() }
    view?.setMentionIndicators(indicators)
  }

  @ReactProp(name = "writingDirection")
  override fun setWritingDirection(
    view: EnrichedMarkdownTextInputView?,
    value: String?,
  ) {
    // No-op on Android — EditText resolves direction per paragraph via
    // TEXT_DIRECTION_FIRST_STRONG (the platform default).
  }

  override fun updateProperties(
    view: EnrichedMarkdownTextInputView,
    props: ReactStylesDiffMap,
  ) {
    BorderPropsApplicator.apply(view, props)
    super.updateProperties(view, props)
  }

  override fun setPadding(
    view: EnrichedMarkdownTextInputView?,
    left: Int,
    top: Int,
    right: Int,
    bottom: Int,
  ) {
    super.setPadding(view, left, top, right, bottom)
    view?.setPadding(left, top, right, bottom)
  }

  // Commands

  override fun focus(view: EnrichedMarkdownTextInputView?) {
    view?.requestFocusProgrammatically()
  }

  override fun blur(view: EnrichedMarkdownTextInputView?) {
    view?.clearFocus()
  }

  override fun setValue(
    view: EnrichedMarkdownTextInputView?,
    markdown: String?,
  ) {
    if (markdown != null) {
      view?.setValueFromJS(markdown)
    }
  }

  override fun setSelection(
    view: EnrichedMarkdownTextInputView?,
    start: Int,
    end: Int,
  ) {
    val length = view?.text?.length ?: 0
    val clampedStart = start.coerceIn(0, length)
    val clampedEnd = end.coerceIn(0, length)
    view?.setSelection(clampedStart, clampedEnd)
  }

  override fun toggleBold(view: EnrichedMarkdownTextInputView?) {
    view?.toggleInlineStyle(StyleType.BOLD)
  }

  override fun toggleItalic(view: EnrichedMarkdownTextInputView?) {
    view?.toggleInlineStyle(StyleType.ITALIC)
  }

  override fun toggleUnderline(view: EnrichedMarkdownTextInputView?) {
    view?.toggleInlineStyle(StyleType.UNDERLINE)
  }

  override fun toggleStrikethrough(view: EnrichedMarkdownTextInputView?) {
    view?.toggleInlineStyle(StyleType.STRIKETHROUGH)
  }

  override fun toggleSpoiler(view: EnrichedMarkdownTextInputView?) {
    view?.toggleInlineStyle(StyleType.SPOILER)
  }

  override fun toggleHeading(
    view: EnrichedMarkdownTextInputView?,
    level: Int,
  ) {
    view?.toggleHeading(level)
  }

  override fun toggleUnorderedList(view: EnrichedMarkdownTextInputView?) {
    view?.toggleUnorderedList()
  }

  override fun toggleOrderedList(view: EnrichedMarkdownTextInputView?) {
    view?.toggleOrderedList()
  }

  override fun indentList(view: EnrichedMarkdownTextInputView?) {
    view?.indentList()
  }

  override fun outdentList(view: EnrichedMarkdownTextInputView?) {
    view?.outdentList()
  }

  override fun setLink(
    view: EnrichedMarkdownTextInputView?,
    url: String?,
  ) {
    if (url != null) {
      view?.setLinkForSelection(url)
    }
  }

  override fun insertLink(
    view: EnrichedMarkdownTextInputView?,
    text: String?,
    url: String?,
  ) {
    if (url != null) {
      view?.insertLinkAtCursor(text ?: url, url)
    }
  }

  override fun insertText(
    view: EnrichedMarkdownTextInputView?,
    text: String?,
  ) {
    if (text != null) {
      view?.insertTextAtCursor(text)
    }
  }

  override fun insertMention(
    view: EnrichedMarkdownTextInputView?,
    displayText: String?,
    url: String?,
  ) {
    if (displayText != null && url != null) {
      view?.insertMention(displayText, url)
    }
  }

  override fun startMention(
    view: EnrichedMarkdownTextInputView?,
    indicator: String?,
  ) {
    if (indicator != null) {
      view?.startMention(indicator)
    }
  }

  override fun removeLink(view: EnrichedMarkdownTextInputView?) {
    view?.removeLinkAtCursor()
  }

  override fun copyToClipboard(view: EnrichedMarkdownTextInputView?) {
    view?.copyToClipboard()
  }

  override fun requestMarkdown(
    view: EnrichedMarkdownTextInputView?,
    requestId: Int,
  ) {
    view?.eventEmitter?.emitRequestMarkdownResult(requestId)
  }

  override fun requestCaretRect(
    view: EnrichedMarkdownTextInputView?,
    requestId: Int,
  ) {
    view?.eventEmitter?.emitRequestCaretRectResult(requestId)
  }

  companion object {
    const val NAME = "EnrichedMarkdownTextInput"
  }
}
