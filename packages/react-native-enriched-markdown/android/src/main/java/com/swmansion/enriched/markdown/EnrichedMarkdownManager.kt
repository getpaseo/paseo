package com.swmansion.enriched.markdown

import android.content.Context
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.module.annotations.ReactModule
import com.facebook.react.uimanager.ReactStylesDiffMap
import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.StateWrapper
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManagerDelegate
import com.facebook.react.uimanager.annotations.ReactProp
import com.facebook.react.viewmanagers.EnrichedMarkdownManagerDelegate
import com.facebook.react.viewmanagers.EnrichedMarkdownManagerInterface
import com.facebook.yoga.YogaMeasureMode
import com.swmansion.enriched.markdown.spoiler.SpoilerOverlay
import com.swmansion.enriched.markdown.utils.common.CodeBlockStreamingMode
import com.swmansion.enriched.markdown.utils.common.TableStreamingMode
import com.swmansion.enriched.markdown.utils.common.applyReactBorderProps
import com.swmansion.enriched.markdown.utils.common.emitCodeBlockPress
import com.swmansion.enriched.markdown.utils.common.emitContextMenuItemPress
import com.swmansion.enriched.markdown.utils.common.emitCopyPress
import com.swmansion.enriched.markdown.utils.common.emitLatexError
import com.swmansion.enriched.markdown.utils.common.emitLinkLongPress
import com.swmansion.enriched.markdown.utils.common.emitLinkPress
import com.swmansion.enriched.markdown.utils.common.emitTaskListItemPress
import com.swmansion.enriched.markdown.utils.common.markdownEventTypeConstants
import com.swmansion.enriched.markdown.utils.common.parseAccessibilityLabels
import com.swmansion.enriched.markdown.utils.common.parseContextMenuItems
import com.swmansion.enriched.markdown.utils.common.parseImageRequestHeaders
import com.swmansion.enriched.markdown.utils.common.parseLinkPillContent
import com.swmansion.enriched.markdown.utils.common.parseLinkRecognition
import com.swmansion.enriched.markdown.utils.common.parseMd4cFlags
import com.swmansion.enriched.markdown.utils.common.parseSelectionMenuConfig
import com.swmansion.enriched.markdown.utils.text.interaction.TaskListToggleUtils

@ReactModule(name = EnrichedMarkdownManager.NAME)
class EnrichedMarkdownManager :
  SimpleViewManager<EnrichedMarkdown>(),
  EnrichedMarkdownManagerInterface<EnrichedMarkdown> {
  private val mDelegate: ViewManagerDelegate<EnrichedMarkdown> = EnrichedMarkdownManagerDelegate(this)

  override fun getDelegate(): ViewManagerDelegate<EnrichedMarkdown>? = mDelegate

  override fun getName(): String = NAME

  override fun createViewInstance(reactContext: ThemedReactContext): EnrichedMarkdown {
    val view = EnrichedMarkdown(reactContext)
    view.onContextMenuItemPressCallback = { itemText, selectedText, selectionStart, selectionEnd ->
      emitContextMenuItemPress(view, itemText, selectedText, selectionStart, selectionEnd)
    }

    view.setOnLinkPressCallback { url, sourceType ->
      emitLinkPress(view, url, sourceType)
    }

    view.setOnLinkLongPressCallback { url ->
      emitLinkLongPress(view, url)
    }

    view.setOnTaskListItemPressCallback { taskIndex, checked, itemText ->
      val newChecked = !checked
      val updatedMarkdown = TaskListToggleUtils.toggleAtIndex(view.currentMarkdown, taskIndex, newChecked)
      view.setMarkdownContent(updatedMarkdown)
      view.commitProps()
      emitTaskListItemPress(view, taskIndex, newChecked, itemText)
    }

    view.setOnCopyPressCallback { code, language ->
      emitCopyPress(view, code, language)
    }

    view.setOnLatexErrorCallback { source, message, displayMode ->
      emitLatexError(view, source, message, displayMode)
    }

    view.setOnCodeBlockPressCallback { code, language ->
      emitCodeBlockPress(view, code, language)
    }

    return view
  }

  override fun onAfterUpdateTransaction(view: EnrichedMarkdown) {
    super.onAfterUpdateTransaction(view)
    view.commitProps()
  }

  // Replay containerStyle border props the delegate drops (see applyReactBorderProps).
  override fun updateProperties(
    view: EnrichedMarkdown,
    props: ReactStylesDiffMap,
  ) {
    super.updateProperties(view, props)
    applyReactBorderProps(view, props)
  }

  override fun updateState(
    view: EnrichedMarkdown,
    props: ReactStylesDiffMap?,
    stateWrapper: StateWrapper?,
  ): Any? {
    view.stateWrapper = stateWrapper
    return super.updateState(view, props, stateWrapper)
  }

  override fun onDropViewInstance(view: EnrichedMarkdown) {
    super.onDropViewInstance(view)
    view.cleanup()
    MeasurementStore.release(view.id)
    MeasurementStore.clearStreamingTableMode(view.id)
    MeasurementStore.clearStreamingCodeBlockMode(view.id)
    MeasurementStore.clearBreakStrategy(view.id)
    MeasurementStore.clearFontScalingSettings(view.id)
  }

  override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> = markdownEventTypeConstants()

  @ReactProp(name = "markdown")
  override fun setMarkdown(
    view: EnrichedMarkdown?,
    markdown: String?,
  ) {
    view?.setMarkdownContent(markdown ?: "")
  }

  @ReactProp(name = "markdownStyle")
  override fun setMarkdownStyle(
    view: EnrichedMarkdown?,
    style: ReadableMap?,
  ) {
    view?.setMarkdownStyle(style)
  }

  @ReactProp(name = "selectable", defaultBoolean = true)
  override fun setSelectable(
    view: EnrichedMarkdown?,
    selectable: Boolean,
  ) {
    view?.setIsSelectable(selectable)
  }

  override fun setSelectionColor(
    view: EnrichedMarkdown?,
    value: Int?,
  ) {
    view?.setSelectionColor(value)
  }

  override fun setSelectionHandleColor(
    view: EnrichedMarkdown?,
    value: Int?,
  ) {
    view?.setSelectionHandleColor(value)
  }

  @ReactProp(name = "linkRecognition")
  override fun setLinkRecognition(
    view: EnrichedMarkdown?,
    value: ReadableMap?,
  ) {
    val recognition = parseLinkRecognition(value)
    view?.setLinkRegex(recognition.text)
    view?.setInlineCodeLinkRegex(recognition.inlineCode)
  }

  @ReactProp(name = "md4cFlags")
  override fun setMd4cFlags(
    view: EnrichedMarkdown?,
    flags: ReadableMap?,
  ) {
    view?.setMd4cFlags(parseMd4cFlags(flags))
  }

  @ReactProp(name = "isGFM", defaultBoolean = true)
  override fun setIsGFM(
    view: EnrichedMarkdown?,
    isGFM: Boolean,
  ) {
    view?.setIsGFM(isGFM)
  }

  @ReactProp(name = "allowFontScaling", defaultBoolean = true)
  override fun setAllowFontScaling(
    view: EnrichedMarkdown?,
    allowFontScaling: Boolean,
  ) {
    view?.setAllowFontScaling(allowFontScaling)
  }

  @ReactProp(name = "maxFontSizeMultiplier", defaultFloat = 0f)
  override fun setMaxFontSizeMultiplier(
    view: EnrichedMarkdown?,
    maxFontSizeMultiplier: Float,
  ) {
    view?.setMaxFontSizeMultiplier(maxFontSizeMultiplier)
  }

  @ReactProp(name = "allowTrailingMargin", defaultBoolean = false)
  override fun setAllowTrailingMargin(
    view: EnrichedMarkdown?,
    allowTrailingMargin: Boolean,
  ) {
    view?.setAllowTrailingMargin(allowTrailingMargin)
  }

  @ReactProp(name = "enableLinkPreview", defaultBoolean = true)
  override fun setEnableLinkPreview(
    view: EnrichedMarkdown?,
    enableLinkPreview: Boolean,
  ) {
    // No-op on Android — only used on iOS
  }

  @ReactProp(name = "enableTaskListItemToggle", defaultBoolean = true)
  override fun setEnableTaskListItemToggle(
    view: EnrichedMarkdown?,
    enableTaskListItemToggle: Boolean,
  ) {
    view?.enableTaskListItemToggle = enableTaskListItemToggle
  }

  @ReactProp(name = "enableImagePress", defaultBoolean = false)
  override fun setEnableImagePress(
    view: EnrichedMarkdown?,
    enableImagePress: Boolean,
  ) {
    view?.setEnableImagePress(enableImagePress)
  }

  @ReactProp(name = "enableBlockContextMenu", defaultBoolean = true)
  override fun setEnableBlockContextMenu(
    view: EnrichedMarkdown?,
    enableBlockContextMenu: Boolean,
  ) {
    view?.enableBlockContextMenu = enableBlockContextMenu
  }

  @ReactProp(name = "enableCodeBlockPress", defaultBoolean = false)
  override fun setEnableCodeBlockPress(
    view: EnrichedMarkdown?,
    enableCodeBlockPress: Boolean,
  ) {
    view?.enableCodeBlockPress = enableCodeBlockPress
  }

  @ReactProp(name = "lineBreakStrategyIOS")
  override fun setLineBreakStrategyIOS(
    view: EnrichedMarkdown?,
    strategy: String?,
  ) {
    // No-op on Android — only used on iOS
  }

  @ReactProp(name = "writingDirection")
  override fun setWritingDirection(
    view: EnrichedMarkdown?,
    value: String?,
  ) {
    // No-op on Android — first-strong per-paragraph resolution is the platform default
  }

  @ReactProp(name = "streamingAnimation", defaultBoolean = false)
  override fun setStreamingAnimation(
    view: EnrichedMarkdown?,
    streamingAnimation: Boolean,
  ) {
    view?.streamingAnimation = streamingAnimation
  }

  @ReactProp(name = "streamingConfig")
  override fun setStreamingConfig(
    view: EnrichedMarkdown?,
    config: ReadableMap?,
  ) {
    if (view == null) return
    val tableMode =
      when (config?.getString("tableMode")) {
        "hidden" -> TableStreamingMode.HIDDEN
        else -> TableStreamingMode.PROGRESSIVE
      }
    view.tableStreamingMode = tableMode
    view.codeBlockStreamingMode =
      when (config?.getString("codeBlockMode")) {
        "hidden" -> CodeBlockStreamingMode.HIDDEN
        else -> CodeBlockStreamingMode.PROGRESSIVE
      }
  }

  @ReactProp(name = "spoilerOverlay")
  override fun setSpoilerOverlay(
    view: EnrichedMarkdown?,
    mode: String?,
  ) {
    view?.spoilerOverlay = SpoilerOverlay.fromString(mode)
  }

  @ReactProp(name = "textBreakStrategy")
  override fun setTextBreakStrategy(
    view: EnrichedMarkdown?,
    strategy: String?,
  ) {
    view?.setTextBreakStrategy(strategy ?: "highQuality")
  }

  @ReactProp(name = "numberOfLines", defaultInt = 0)
  override fun setNumberOfLines(
    view: EnrichedMarkdown?,
    value: Int,
  ) {
    // No-op for GFM — block segments cannot honor a document-wide line cap. See the GFM tracking issue.
  }

  @ReactProp(name = "ellipsizeMode")
  override fun setEllipsizeMode(
    view: EnrichedMarkdown?,
    value: String?,
  ) {
    // No-op for GFM — see setNumberOfLines.
  }

  @ReactProp(name = "linkContextMenuItems")
  override fun setLinkContextMenuItems(
    view: EnrichedMarkdown?,
    value: ReadableArray?,
  ) {
    // Link menus are iOS-only for now; onLinkLongPress is the Android hook.
  }

  @ReactProp(name = "contextMenuItems")
  override fun setContextMenuItems(
    view: EnrichedMarkdown?,
    value: ReadableArray?,
  ) {
    if (view == null) return
    view.setContextMenuItems(parseContextMenuItems(value))
  }

  @ReactProp(name = "imageRequestHeaders")
  override fun setImageRequestHeaders(
    view: EnrichedMarkdown?,
    value: ReadableArray?,
  ) {
    if (view == null) return
    view.setImageRequestHeaders(parseImageRequestHeaders(value))
  }

  @ReactProp(name = "linkPillContent")
  override fun setLinkPillContent(
    view: EnrichedMarkdown?,
    value: ReadableArray?,
  ) {
    if (view == null) return
    view.setLinkPillContent(parseLinkPillContent(value))
  }

  @ReactProp(name = "selectionMenuConfig")
  override fun setSelectionMenuConfig(
    view: EnrichedMarkdown?,
    value: ReadableMap?,
  ) {
    if (view == null) return
    view.setSelectionMenuConfig(parseSelectionMenuConfig(value))
  }

  @ReactProp(name = "accessibilityLabels")
  override fun setAccessibilityLabels(
    view: EnrichedMarkdown?,
    value: ReadableMap?,
  ) {
    if (view == null) return
    view.setAccessibilityLabels(parseAccessibilityLabels(value))
  }

  override fun setPadding(
    view: EnrichedMarkdown,
    left: Int,
    top: Int,
    right: Int,
    bottom: Int,
  ) {
    super.setPadding(view, left, top, right, bottom)
    view.setPadding(left, top, right, bottom)
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
    return MeasurementStore.getMeasureById(context, id, width, widthMode, height, heightMode, props, splitTableSegments = true)
  }

  companion object {
    const val NAME = "EnrichedMarkdown"
  }
}
