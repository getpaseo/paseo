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
import com.facebook.react.viewmanagers.EnrichedMarkdownTextManagerDelegate
import com.facebook.react.viewmanagers.EnrichedMarkdownTextManagerInterface
import com.facebook.yoga.YogaMeasureMode
import com.swmansion.enriched.markdown.spoiler.SpoilerOverlay
import com.swmansion.enriched.markdown.utils.common.applyReactBorderProps
import com.swmansion.enriched.markdown.utils.common.emitContextMenuItemPress
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
import com.swmansion.enriched.markdown.utils.text.interaction.TaskListTapUtils
import com.swmansion.enriched.markdown.utils.text.interaction.TaskListToggleUtils

@ReactModule(name = EnrichedMarkdownTextManager.NAME)
class EnrichedMarkdownTextManager :
  SimpleViewManager<EnrichedMarkdownText>(),
  EnrichedMarkdownTextManagerInterface<EnrichedMarkdownText> {
  private val mDelegate: ViewManagerDelegate<EnrichedMarkdownText> = EnrichedMarkdownTextManagerDelegate(this)

  override fun getDelegate(): ViewManagerDelegate<EnrichedMarkdownText>? = mDelegate

  override fun getName(): String = NAME

  override fun createViewInstance(reactContext: ThemedReactContext): EnrichedMarkdownText {
    val view = EnrichedMarkdownText(reactContext)
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

      val styleConfig = view.markdownStyle
      val optimizedSuccess =
        styleConfig != null && TaskListTapUtils.updateTaskListItemCheckedState(view, taskIndex, newChecked, styleConfig)

      if (optimizedSuccess) {
        emitTaskListItemPress(view, taskIndex, newChecked, itemText)
        return@setOnTaskListItemPressCallback
      }

      val currentMarkdown = view.currentMarkdown
      val updatedMarkdown = TaskListToggleUtils.toggleAtIndex(currentMarkdown, taskIndex, newChecked)
      view.setMarkdownContent(updatedMarkdown)

      emitTaskListItemPress(view, taskIndex, newChecked, itemText)
    }

    view.setOnLatexErrorCallback { source, message, displayMode ->
      emitLatexError(view, source, message, displayMode)
    }
    return view
  }

  override fun onAfterUpdateTransaction(view: EnrichedMarkdownText) {
    super.onAfterUpdateTransaction(view)
    view.commitProps()
  }

  // Replay containerStyle border props the delegate drops (see applyReactBorderProps).
  override fun updateProperties(
    view: EnrichedMarkdownText,
    props: ReactStylesDiffMap,
  ) {
    super.updateProperties(view, props)
    applyReactBorderProps(view, props)
  }

  override fun updateState(
    view: EnrichedMarkdownText,
    props: ReactStylesDiffMap?,
    stateWrapper: StateWrapper?,
  ): Any? {
    view.stateWrapper = stateWrapper
    return super.updateState(view, props, stateWrapper)
  }

  override fun onDropViewInstance(view: EnrichedMarkdownText) {
    super.onDropViewInstance(view)
    view.cleanup()
    MeasurementStore.clearFontScalingSettings(view.id)
    MeasurementStore.clearBreakStrategy(view.id)
    view.layoutManager.releaseMeasurementStore()
  }

  override fun getExportedCustomDirectEventTypeConstants(): MutableMap<String, Any> = markdownEventTypeConstants()

  @ReactProp(name = "markdown")
  override fun setMarkdown(
    view: EnrichedMarkdownText?,
    markdown: String?,
  ) {
    view?.setMarkdownContent(markdown ?: "")
  }

  @ReactProp(name = "markdownStyle")
  override fun setMarkdownStyle(
    view: EnrichedMarkdownText?,
    style: ReadableMap?,
  ) {
    view?.setMarkdownStyle(style)
  }

  @ReactProp(name = "selectable", defaultBoolean = true)
  override fun setSelectable(
    view: EnrichedMarkdownText?,
    selectable: Boolean,
  ) {
    view?.setIsSelectable(selectable)
  }

  override fun setSelectionColor(
    view: EnrichedMarkdownText?,
    value: Int?,
  ) {
    view?.setSelectionColor(value)
  }

  override fun setSelectionHandleColor(
    view: EnrichedMarkdownText?,
    value: Int?,
  ) {
    view?.setSelectionHandleColor(value)
  }

  @ReactProp(name = "linkRecognition")
  override fun setLinkRecognition(
    view: EnrichedMarkdownText?,
    value: ReadableMap?,
  ) {
    val recognition = parseLinkRecognition(value)
    view?.setLinkRegex(recognition.text)
    view?.setInlineCodeLinkRegex(recognition.inlineCode)
  }

  @ReactProp(name = "md4cFlags")
  override fun setMd4cFlags(
    view: EnrichedMarkdownText?,
    flags: ReadableMap?,
  ) {
    view?.setMd4cFlags(parseMd4cFlags(flags))
  }

  @ReactProp(name = "isGFM", defaultBoolean = false)
  override fun setIsGFM(
    view: EnrichedMarkdownText?,
    isGFM: Boolean,
  ) {
    view?.setIsGFM(isGFM)
  }

  @ReactProp(name = "allowFontScaling", defaultBoolean = true)
  override fun setAllowFontScaling(
    view: EnrichedMarkdownText?,
    allowFontScaling: Boolean,
  ) {
    view?.setAllowFontScaling(allowFontScaling)
  }

  @ReactProp(name = "maxFontSizeMultiplier", defaultFloat = 0f)
  override fun setMaxFontSizeMultiplier(
    view: EnrichedMarkdownText?,
    maxFontSizeMultiplier: Float,
  ) {
    view?.setMaxFontSizeMultiplier(maxFontSizeMultiplier)
  }

  @ReactProp(name = "allowTrailingMargin", defaultBoolean = false)
  override fun setAllowTrailingMargin(
    view: EnrichedMarkdownText?,
    allowTrailingMargin: Boolean,
  ) {
    view?.setAllowTrailingMargin(allowTrailingMargin)
  }

  @ReactProp(name = "enableLinkPreview", defaultBoolean = true)
  override fun setEnableLinkPreview(
    view: EnrichedMarkdownText?,
    enableLinkPreview: Boolean,
  ) {
    // No-op on Android — only used on iOS
  }

  @ReactProp(name = "enableTaskListItemToggle", defaultBoolean = true)
  override fun setEnableTaskListItemToggle(
    view: EnrichedMarkdownText?,
    enableTaskListItemToggle: Boolean,
  ) {
    view?.setEnableTaskListItemToggle(enableTaskListItemToggle)
  }

  @ReactProp(name = "enableImagePress", defaultBoolean = false)
  override fun setEnableImagePress(
    view: EnrichedMarkdownText?,
    enableImagePress: Boolean,
  ) {
    view?.setEnableImagePress(enableImagePress)
  }

  @ReactProp(name = "enableBlockContextMenu", defaultBoolean = true)
  override fun setEnableBlockContextMenu(
    view: EnrichedMarkdownText?,
    enableBlockContextMenu: Boolean,
  ) {
    // No-op: block context menus are rendered by the container component.
  }

  @ReactProp(name = "enableCodeBlockPress", defaultBoolean = false)
  override fun setEnableCodeBlockPress(
    view: EnrichedMarkdownText?,
    enableCodeBlockPress: Boolean,
  ) {
    view?.setEnableCodeBlockPress(enableCodeBlockPress)
  }

  @ReactProp(name = "lineBreakStrategyIOS")
  override fun setLineBreakStrategyIOS(
    view: EnrichedMarkdownText?,
    strategy: String?,
  ) {
    // No-op on Android — only used on iOS
  }

  @ReactProp(name = "writingDirection")
  override fun setWritingDirection(
    view: EnrichedMarkdownText?,
    value: String?,
  ) {
    // No-op on Android — first-strong per-paragraph resolution is the platform default
  }

  @ReactProp(name = "streamingAnimation", defaultBoolean = false)
  override fun setStreamingAnimation(
    view: EnrichedMarkdownText?,
    streamingAnimation: Boolean,
  ) {
    view?.setStreamingAnimation(streamingAnimation)
  }

  @ReactProp(name = "streamingConfig")
  override fun setStreamingConfig(
    view: EnrichedMarkdownText?,
    config: ReadableMap?,
  ) {
    // No-op — CommonMark mode uses a single text view; table streaming is GFM-only.
  }

  @ReactProp(name = "spoilerOverlay")
  override fun setSpoilerOverlay(
    view: EnrichedMarkdownText?,
    mode: String?,
  ) {
    view?.spoilerOverlay = SpoilerOverlay.fromString(mode)
  }

  @ReactProp(name = "textBreakStrategy")
  override fun setTextBreakStrategy(
    view: EnrichedMarkdownText?,
    strategy: String?,
  ) {
    view?.setTextBreakStrategy(strategy ?: "highQuality")
  }

  @ReactProp(name = "numberOfLines", defaultInt = 0)
  override fun setNumberOfLines(
    view: EnrichedMarkdownText?,
    value: Int,
  ) {
    view?.setMarkdownNumberOfLines(value)
  }

  @ReactProp(name = "ellipsizeMode")
  override fun setEllipsizeMode(
    view: EnrichedMarkdownText?,
    value: String?,
  ) {
    view?.setMarkdownEllipsizeMode(value ?: "tail")
  }

  @ReactProp(name = "linkContextMenuItems")
  override fun setLinkContextMenuItems(
    view: EnrichedMarkdownText?,
    value: ReadableArray?,
  ) {
    // Link menus are iOS-only for now; onLinkLongPress is the Android hook.
  }

  @ReactProp(name = "contextMenuItems")
  override fun setContextMenuItems(
    view: EnrichedMarkdownText?,
    value: ReadableArray?,
  ) {
    if (view == null) return
    view.setContextMenuItems(parseContextMenuItems(value))
  }

  @ReactProp(name = "imageRequestHeaders")
  override fun setImageRequestHeaders(
    view: EnrichedMarkdownText?,
    value: ReadableArray?,
  ) {
    if (view == null) return
    view.setImageRequestHeaders(parseImageRequestHeaders(value))
  }

  @ReactProp(name = "linkPillContent")
  override fun setLinkPillContent(
    view: EnrichedMarkdownText?,
    value: ReadableArray?,
  ) {
    if (view == null) return
    view.setLinkPillContent(parseLinkPillContent(value))
  }

  @ReactProp(name = "selectionMenuConfig")
  override fun setSelectionMenuConfig(
    view: EnrichedMarkdownText?,
    value: ReadableMap?,
  ) {
    if (view == null) return
    view.setSelectionMenuConfig(parseSelectionMenuConfig(value))
  }

  @ReactProp(name = "accessibilityLabels")
  override fun setAccessibilityLabels(
    view: EnrichedMarkdownText?,
    value: ReadableMap?,
  ) {
    if (view == null) return
    view.setAccessibilityLabels(parseAccessibilityLabels(value))
  }

  override fun setPadding(
    view: EnrichedMarkdownText,
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
    return MeasurementStore.getMeasureById(context, id, width, widthMode, height, heightMode, props)
  }

  companion object {
    const val NAME = "EnrichedMarkdownText"
  }
}
