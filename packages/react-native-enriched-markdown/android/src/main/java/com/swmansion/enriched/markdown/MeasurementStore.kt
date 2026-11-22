package com.swmansion.enriched.markdown

import android.content.Context
import android.graphics.Typeface
import android.os.Build
import android.text.Spannable
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextPaint
import android.text.TextUtils.TruncateAt
import android.util.Log
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.uimanager.PixelUtil
import com.facebook.yoga.YogaMeasureMode
import com.facebook.yoga.YogaMeasureOutput
import com.swmansion.enriched.markdown.parser.Md4cFlags
import com.swmansion.enriched.markdown.parser.Parser
import com.swmansion.enriched.markdown.renderer.Renderer
import com.swmansion.enriched.markdown.segments.BlockquoteContainerView
import com.swmansion.enriched.markdown.segments.CodeBlockContainerView
import com.swmansion.enriched.markdown.segments.MarkdownSegmentRenderer
import com.swmansion.enriched.markdown.segments.RenderedSegment
import com.swmansion.enriched.markdown.segments.TableContainerView
import com.swmansion.enriched.markdown.segments.splitASTIntoSegments
import com.swmansion.enriched.markdown.spans.MarginBottomSpan
import com.swmansion.enriched.markdown.spans.MathMeasureRequest
import com.swmansion.enriched.markdown.spans.MathMetrics
import com.swmansion.enriched.markdown.spans.MathRenderMode
import com.swmansion.enriched.markdown.styles.LinkPillContent
import com.swmansion.enriched.markdown.styles.StyleConfig
import com.swmansion.enriched.markdown.utils.common.BreakStrategyUtils
import com.swmansion.enriched.markdown.utils.common.CodeBlockStreamingMode
import com.swmansion.enriched.markdown.utils.common.EllipsizeUtils
import com.swmansion.enriched.markdown.utils.common.FeatureFlags
import com.swmansion.enriched.markdown.utils.common.LinkRegexConfig
import com.swmansion.enriched.markdown.utils.common.StreamingMarkdownFilter
import com.swmansion.enriched.markdown.utils.common.TableStreamingMode
import com.swmansion.enriched.markdown.utils.common.getArrayOrNull
import com.swmansion.enriched.markdown.utils.common.getBooleanOrDefault
import com.swmansion.enriched.markdown.utils.common.getIntOrDefault
import com.swmansion.enriched.markdown.utils.common.getMapOrNull
import com.swmansion.enriched.markdown.utils.common.getStringOrDefault
import com.swmansion.enriched.markdown.utils.common.parseImageRequestHeaders
import com.swmansion.enriched.markdown.utils.common.parseLinkPillContent
import com.swmansion.enriched.markdown.utils.common.parseLinkRecognition
import com.swmansion.enriched.markdown.utils.text.extensions.replaceMathSpansWithPlaceholders
import com.swmansion.enriched.markdown.utils.text.span.prepareWidthAwareSpans
import com.swmansion.enriched.markdown.utils.text.view.wrapForInsertionOrderedLayout
import java.util.concurrent.ConcurrentHashMap
import kotlin.math.ceil

/**
 * Manages text measurements for ShadowNode layout.
 * Parses and renders markdown to Spannable at measure time for accurate height calculation.
 */
object MeasurementStore {
  private const val TAG = "MeasurementStore"

  private data class PaintParams(
    val typeface: Typeface,
    val fontSize: Float,
  )

  private data class MeasurementParams(
    val cachedWidth: Float,
    val cachedSize: Long,
    val spannable: CharSequence?,
    val paintParams: PaintParams,
    val markdownHash: Int,
    val sizeKey: MeasurementSizeCache.Key? = null,
  )

  private val data = ConcurrentHashMap<Int, MeasurementParams>()
  private val sizes = MeasurementSizeCache()

  // Store font scaling settings per view ID
  private data class FontScalingSettings(
    val allowFontScaling: Boolean = true,
    val maxFontSizeMultiplier: Float = 0f,
  )

  private val fontScalingSettings = ConcurrentHashMap<Int, FontScalingSettings>()

  private val breakStrategies = ConcurrentHashMap<Int, String>()

  // The measure path and the display TextView resolve the same clamp. 0 means unlimited.
  private val numberOfLinesByViewId = ConcurrentHashMap<Int, Int>()

  private val ellipsizeModeByViewId = ConcurrentHashMap<Int, String>()

  private val streamingTableModes = ConcurrentHashMap<Int, TableStreamingMode>()

  private val streamingCodeBlockModes = ConcurrentHashMap<Int, CodeBlockStreamingMode>()

  private fun resolveFontScalingSettings(
    viewId: Int?,
    props: ReadableMap?,
  ): FontScalingSettings {
    val stored = viewId?.let { fontScalingSettings[it] }
    return FontScalingSettings(
      allowFontScaling =
        props?.takeIf { it.hasKey("allowFontScaling") }?.getBoolean("allowFontScaling")
          ?: stored?.allowFontScaling
          ?: true,
      maxFontSizeMultiplier =
        props?.takeIf { it.hasKey("maxFontSizeMultiplier") }?.getDouble("maxFontSizeMultiplier")?.toFloat()
          ?: stored?.maxFontSizeMultiplier
          ?: 0f,
    )
  }

  private val measurePaint = TextPaint()
  private val measureRenderer = Renderer()

  @Volatile
  private var lastKnownFontScale: Float = 1.0f

  /** Updates measurement with rendered Spannable. Returns true if height changed. */
  fun store(
    id: Int,
    spannable: CharSequence?,
    paint: TextPaint,
    trailingMarginBottomPx: Float = 0f,
  ): Boolean {
    val cached = data[id]
    val width = cached?.cachedWidth ?: 0f
    val oldSize = cached?.cachedSize ?: 0L
    val existingHash = cached?.markdownHash ?: 0
    val paintParams = PaintParams(paint.typeface ?: Typeface.DEFAULT, paint.textSize)

    var newSize = measure(width, spannable, paint, id)
    if (trailingMarginBottomPx > 0f) {
      newSize =
        YogaMeasureOutput.make(
          YogaMeasureOutput.getWidth(newSize),
          YogaMeasureOutput.getHeight(newSize) + PixelUtil.toDIPFromPixel(trailingMarginBottomPx),
        )
    }
    if (oldSize != newSize) {
      cached?.sizeKey?.let { sizes.removeMatchingMarkdown(it.markdown) }
    }
    data[id] = MeasurementParams(width, newSize, spannable, paintParams, existingHash, cached?.sizeKey)
    return oldSize != newSize
  }

  fun release(id: Int) {
    data.remove(id)
    numberOfLinesByViewId.remove(id)
    ellipsizeModeByViewId.remove(id)
  }

  fun invalidate(id: Int) {
    data.remove(id)?.sizeKey?.let { sizes.removeMatchingMarkdown(it.markdown) }
  }

  // Content-box width (px) the measure pass last wrapped at; the display view insets to match (#805).
  fun contentBoxWidthPx(id: Int): Float? = data[id]?.cachedWidth

  /** Main entry point for ShadowNode measurement. */
  fun getMeasureById(
    context: Context,
    id: Int?,
    width: Float,
    widthMode: YogaMeasureMode?,
    height: Float,
    heightMode: YogaMeasureMode?,
    props: ReadableMap?,
    splitTableSegments: Boolean = false,
  ): Long {
    // Early exit for empty markdown. Honor widthMode here too: empty content has
    // zero intrinsic width, so only fill when the width is EXACTLY assigned -
    // otherwise an empty view would claim all available horizontal space.
    val markdown = props.getStringOrDefault("markdown", "")
    if (markdown.isEmpty()) {
      val emptyWidth = if (widthMode === YogaMeasureMode.EXACTLY) PixelUtil.toDIPFromPixel(width) else 0f
      return YogaMeasureOutput.make(emptyWidth, 0f)
    }

    // Resolve the line clamp from props here so the (background) measure pass and
    // the (main-thread) display TextView never race on the per-viewId cache. Only
    // overwrite when the key is present so we never clobber the view's value.
    if (id != null && props != null) {
      if (props.hasKey("numberOfLines")) {
        numberOfLinesByViewId[id] = props.getDouble("numberOfLines").toInt()
      }
      if (props.hasKey("ellipsizeMode")) {
        ellipsizeModeByViewId[id] = props.getString("ellipsizeMode") ?: EllipsizeUtils.DEFAULT_MODE
      }
    }

    val size = getMeasureByIdInternal(context, id, width, props, splitTableSegments)

    // Honor the Yoga width contract. When the parent assigns an exact width
    // (flex child, alignItems: stretch, explicit width / width: "100%"), fill it
    // instead of reporting the content's widest line, which would make the node
    // hug its content and wrap early. Mirrors RN's TextLayoutManager.calculateWidth;
    // iOS already does this via ENRMClampMeasuredSize.
    val resultWidth =
      if (widthMode === YogaMeasureMode.EXACTLY) {
        PixelUtil.toDIPFromPixel(width)
      } else {
        YogaMeasureOutput.getWidth(size)
      }

    var resultHeight = YogaMeasureOutput.getHeight(size)
    if (heightMode === YogaMeasureMode.AT_MOST) {
      resultHeight = resultHeight.coerceAtMost(PixelUtil.toDIPFromPixel(height))
    }

    return YogaMeasureOutput.make(resultWidth, resultHeight)
  }

  fun updateFontScalingSettings(
    viewId: Int,
    allowFontScaling: Boolean,
    maxFontSizeMultiplier: Float,
  ) {
    val previous = fontScalingSettings[viewId]
    fontScalingSettings[viewId] = FontScalingSettings(allowFontScaling, maxFontSizeMultiplier)
    if (previous != null && (previous.allowFontScaling != allowFontScaling || previous.maxFontSizeMultiplier != maxFontSizeMultiplier)) {
      invalidate(viewId)
    }
  }

  fun clearFontScalingSettings(viewId: Int) {
    fontScalingSettings.remove(viewId)
  }

  fun updateBreakStrategy(
    viewId: Int,
    strategy: String,
  ) {
    breakStrategies[viewId] = strategy
  }

  fun clearBreakStrategy(viewId: Int) {
    breakStrategies.remove(viewId)
  }

  private fun resolveBreakStrategy(viewId: Int?): Int = BreakStrategyUtils.resolveBreakStrategy(viewId?.let { breakStrategies[it] })

  fun updateNumberOfLines(
    viewId: Int,
    numberOfLines: Int,
  ) {
    numberOfLinesByViewId[viewId] = numberOfLines
  }

  fun updateEllipsizeMode(
    viewId: Int,
    mode: String,
  ) {
    ellipsizeModeByViewId[viewId] = mode
  }

  private fun resolveMaxLines(viewId: Int?): Int = viewId?.let { numberOfLinesByViewId[it] } ?: 0

  private fun resolveEllipsize(viewId: Int?): TruncateAt? =
    EllipsizeUtils.resolveTruncateAt(viewId?.let { ellipsizeModeByViewId[it] } ?: EllipsizeUtils.DEFAULT_MODE)

  fun updateStreamingTableMode(
    viewId: Int,
    mode: TableStreamingMode,
  ) {
    streamingTableModes[viewId] = mode
  }

  fun clearStreamingTableMode(viewId: Int) {
    streamingTableModes.remove(viewId)
  }

  fun updateStreamingCodeBlockMode(
    viewId: Int,
    mode: CodeBlockStreamingMode,
  ) {
    streamingCodeBlockModes[viewId] = mode
  }

  fun clearStreamingCodeBlockMode(viewId: Int) {
    streamingCodeBlockModes.remove(viewId)
  }

  private fun getMeasureByIdInternal(
    context: Context,
    id: Int?,
    width: Float,
    props: ReadableMap?,
    splitTableSegments: Boolean,
  ): Long {
    val (allowFontScaling, maxFontSizeMultiplier) = resolveFontScalingSettings(id, props)

    val fontScale = checkAndUpdateFontScale(context, allowFontScaling, maxFontSizeMultiplier)

    // Use resolved layout settings, including values supplied by native setters.
    var layoutHash = computePropsHash(props, allowFontScaling, fontScale, maxFontSizeMultiplier)
    layoutHash = 31 * layoutHash + resolveBreakStrategy(id)
    layoutHash = 31 * layoutHash + resolveMaxLines(id)
    layoutHash = 31 * layoutHash + (resolveEllipsize(id)?.hashCode() ?: 0)
    layoutHash = 31 * layoutHash + props.getBooleanOrDefault("streamingAnimation", false).hashCode()
    layoutHash = 31 * layoutHash + (id?.let { streamingTableModes[it] } ?: TableStreamingMode.PROGRESSIVE).hashCode()
    layoutHash = 31 * layoutHash + (id?.let { streamingCodeBlockModes[it] } ?: CodeBlockStreamingMode.PROGRESSIVE).hashCode()
    layoutHash = 31 * layoutHash + context.resources.displayMetrics.density.toBits()
    val key = MeasurementSizeCache.Key(props.getStringOrDefault("markdown", ""), layoutHash, width, splitTableSegments)
    val cached = id?.let { data[it] }
    if (cached?.sizeKey == key) return cached.cachedSize
    sizes.get(key)?.let { size ->
      if (id != null) {
        data[id] = MeasurementParams(width, size, null, PaintParams(Typeface.DEFAULT, 0f), 0, key)
      }
      return size
    }

    val size = measureUncached(context, id, width, props, splitTableSegments, allowFontScaling, fontScale, maxFontSizeMultiplier)
    sizes.put(key, size)
    if (id != null) {
      data.computeIfPresent(id) { _, measured -> measured.copy(sizeKey = key) }
    }
    return size
  }

  private fun measureUncached(
    context: Context,
    id: Int?,
    width: Float,
    props: ReadableMap?,
    splitTableSegments: Boolean,
    allowFontScaling: Boolean,
    fontScale: Float,
    maxFontSizeMultiplier: Float,
  ): Long {
    if (splitTableSegments) {
      return measureAndCacheSplit(context, id, width, props, allowFontScaling, fontScale, maxFontSizeMultiplier)
    }

    val safeId = id ?: return measureAndCache(context, null, width, props, allowFontScaling, fontScale, maxFontSizeMultiplier)
    val cached = data[safeId] ?: return measureAndCache(context, safeId, width, props, allowFontScaling, fontScale, maxFontSizeMultiplier)

    val currentHash = computePropsHash(props, allowFontScaling, fontScale, maxFontSizeMultiplier)

    if (cached.markdownHash != currentHash || cached.spannable == null) {
      return measureAndCache(context, safeId, width, props, allowFontScaling, fontScale, maxFontSizeMultiplier)
    }

    // Width changed - re-measure with cached spannable
    if (cached.cachedWidth != width) {
      val newSize = measure(width, cached.spannable, cached.paintParams, safeId)
      data[safeId] = cached.copy(cachedWidth = width, cachedSize = newSize)
      return newSize
    }

    return cached.cachedSize
  }

  private fun computePropsHash(
    props: ReadableMap?,
    allowFontScaling: Boolean,
    fontScale: Float,
    maxFontSizeMultiplier: Float,
  ): Int {
    val markdown = props.getStringOrDefault("markdown", "")
    return computePropsHashForMarkdown(markdown, props, allowFontScaling, fontScale, maxFontSizeMultiplier)
  }

  private fun computePropsHashForMarkdown(
    markdown: String,
    props: ReadableMap?,
    allowFontScaling: Boolean,
    fontScale: Float,
    maxFontSizeMultiplier: Float,
  ): Int {
    val styleMap = props.getMapOrNull("markdownStyle")
    val md4cFlagsMap = props.getMapOrNull("md4cFlags")
    val allowTrailingMargin = props.getBooleanOrDefault("allowTrailingMargin", false)
    val imageRequestHeaders = parseImageRequestHeaders(props.getArrayOrNull("imageRequestHeaders"))
    val linkPillContent = parseLinkPillContent(props.getArrayOrNull("linkPillContent"))
    var result = markdown.hashCode()
    // ReadableNativeArray hashes its backing array identity, not its values.
    result = 31 * result + (styleMap?.toHashMap()?.hashCode() ?: 0)
    result = 31 * result + (md4cFlagsMap?.toHashMap()?.hashCode() ?: 0)
    result = 31 * result + props.getBooleanOrDefault("isGFM", false).hashCode()
    result = 31 * result + props.getStringOrDefault("textBreakStrategy", BreakStrategyUtils.DEFAULT_STRATEGY).hashCode()
    result = 31 * result + parseLinkRecognition(props.getMapOrNull("linkRecognition")).hashCode()
    result = 31 * result + fontScale.toBits()
    result = 31 * result + allowFontScaling.hashCode()
    result = 31 * result + maxFontSizeMultiplier.toBits()
    result = 31 * result + allowTrailingMargin.hashCode()
    result = 31 * result + imageRequestHeaders.hashCode()
    result = 31 * result + linkPillContent.hashCode()
    result = 31 * result + props.getIntOrDefault("numberOfLines", 0)
    result = 31 * result + props.getStringOrDefault("ellipsizeMode", EllipsizeUtils.DEFAULT_MODE).hashCode()
    return result
  }

  private fun checkAndUpdateFontScale(
    context: Context,
    allowFontScaling: Boolean,
    maxFontSizeMultiplier: Float,
  ): Float {
    if (!allowFontScaling) {
      // Clear cache if we switched from scaling to non-scaling
      if (lastKnownFontScale != 1.0f) {
        lastKnownFontScale = 1.0f
        data.clear()
        sizes.clear()
      }
      return 1.0f
    }

    var currentFontScale = context.resources.configuration.fontScale

    if (maxFontSizeMultiplier >= 1.0f && currentFontScale > maxFontSizeMultiplier) {
      currentFontScale = maxFontSizeMultiplier
    }
    if (currentFontScale != lastKnownFontScale) {
      lastKnownFontScale = currentFontScale
      data.clear()
      sizes.clear()
    }
    return currentFontScale
  }

  private fun measureAndCache(
    context: Context,
    id: Int?,
    width: Float,
    props: ReadableMap?,
    allowFontScaling: Boolean,
    fontScale: Float,
    maxFontSizeMultiplier: Float,
  ): Long {
    // 1. Extract Props & Setup
    val markdown = props.getStringOrDefault("markdown", "")
    val styleMap = props.getMapOrNull("markdownStyle")
    val md4cFlags =
      Md4cFlags(
        underline = props.getMapOrNull("md4cFlags").getBooleanOrDefault("underline", false),
        latexMath = FeatureFlags.IS_MATH_ENABLED && props.getMapOrNull("md4cFlags").getBooleanOrDefault("latexMath", true),
        superscript = props.getMapOrNull("md4cFlags").getBooleanOrDefault("superscript", false),
        subscript = props.getMapOrNull("md4cFlags").getBooleanOrDefault("subscript", false),
        highlight = props.getMapOrNull("md4cFlags").getBooleanOrDefault("highlight", false),
        hardSoftBreaks = props.getMapOrNull("md4cFlags").getBooleanOrDefault("hardSoftBreaks", false),
        preserveBlankLines = props.getMapOrNull("md4cFlags").getBooleanOrDefault("preserveBlankLines", false),
        admonitions = props.getMapOrNull("md4cFlags").getBooleanOrDefault("admonitions", true),
      )
    val isGFM = props.getBooleanOrDefault("isGFM", false)

    val fontSize = getInitialFontSize(styleMap, context, allowFontScaling, fontScale, maxFontSizeMultiplier)
    val propsHash = computePropsHash(props, allowFontScaling, fontScale, maxFontSizeMultiplier)

    // 2. Render & Measure
    measurePaint.textSize = fontSize
    val imageRequestHeaders = parseImageRequestHeaders(props.getArrayOrNull("imageRequestHeaders"))
    val linkRecognition = parseLinkRecognition(props.getMapOrNull("linkRecognition"))
    val spannable =
      tryRenderMarkdown(
        markdown,
        styleMap,
        context,
        md4cFlags,
        isGFM,
        allowFontScaling,
        maxFontSizeMultiplier,
        imageRequestHeaders,
        parseLinkPillContent(props.getArrayOrNull("linkPillContent")),
        linkRecognition.text,
        linkRecognition.inlineCode,
      )
    spannable?.replaceMathSpansWithPlaceholders(context)
    val textToMeasure = spannable ?: markdown
    val (size, _) = measureWithLayout(width, textToMeasure, measurePaint, id)

    // 3. Calculate Margin
    val allowTrailingMargin = props.getBooleanOrDefault("allowTrailingMargin", false)
    val marginBottom =
      if (allowTrailingMargin && spannable != null) {
        PixelUtil.toDIPFromPixel(measureRenderer.getLastElementMarginBottom())
      } else {
        0f
      }

    // 4. Finalize Height
    val currentWidth = YogaMeasureOutput.getWidth(size)
    val currentHeight = YogaMeasureOutput.getHeight(size)
    val adjustedSize = YogaMeasureOutput.make(currentWidth, currentHeight + marginBottom)

    if (id != null) {
      data[id] = MeasurementParams(width, adjustedSize, textToMeasure, PaintParams(Typeface.DEFAULT, fontSize), propsHash)
    }

    return adjustedSize
  }

  private fun measureAndCacheSplit(
    context: Context,
    id: Int?,
    width: Float,
    props: ReadableMap?,
    allowFontScaling: Boolean,
    fontScale: Float,
    maxFontSizeMultiplier: Float,
  ): Long {
    val isStreaming = props.getBooleanOrDefault("streamingAnimation", false)

    val rawMarkdown = props.getStringOrDefault("markdown", "")
    val tableMode =
      if (isStreaming) {
        id?.let {
          streamingTableModes[it]
        } ?: TableStreamingMode.PROGRESSIVE
      } else {
        TableStreamingMode.PROGRESSIVE
      }
    val codeBlockMode =
      if (isStreaming) {
        id?.let {
          streamingCodeBlockModes[it]
        } ?: CodeBlockStreamingMode.PROGRESSIVE
      } else {
        CodeBlockStreamingMode.PROGRESSIVE
      }
    val markdown =
      if (isStreaming) {
        StreamingMarkdownFilter.renderableMarkdownForStreaming(rawMarkdown, tableMode, codeBlockMode).markdown
      } else {
        rawMarkdown
      }
    val propsHash = computePropsHashForMarkdown(markdown, props, allowFontScaling, fontScale, maxFontSizeMultiplier)

    // Streaming shortcut: reuse cached size when the filtered content and
    // width are unchanged. When the filter output changes (e.g. a table
    // becomes complete), the hash differs and we fall through to full measure.
    if (isStreaming && id != null) {
      val cached = data[id]
      if (cached != null && cached.cachedWidth == width && cached.markdownHash == propsHash) {
        return cached.cachedSize
      }
    }
    val styleMap =
      props.getMapOrNull("markdownStyle")
        ?: return YogaMeasureOutput.make(PixelUtil.toDIPFromPixel(width), 0f)

    val md4cFlags =
      Md4cFlags(
        underline = props.getMapOrNull("md4cFlags").getBooleanOrDefault("underline", false),
        latexMath = FeatureFlags.IS_MATH_ENABLED && props.getMapOrNull("md4cFlags").getBooleanOrDefault("latexMath", true),
        superscript = props.getMapOrNull("md4cFlags").getBooleanOrDefault("superscript", false),
        subscript = props.getMapOrNull("md4cFlags").getBooleanOrDefault("subscript", false),
        highlight = props.getMapOrNull("md4cFlags").getBooleanOrDefault("highlight", false),
        hardSoftBreaks = props.getMapOrNull("md4cFlags").getBooleanOrDefault("hardSoftBreaks", false),
        preserveBlankLines = props.getMapOrNull("md4cFlags").getBooleanOrDefault("preserveBlankLines", false),
        admonitions = props.getMapOrNull("md4cFlags").getBooleanOrDefault("admonitions", true),
      )
    val isGFM = props.getBooleanOrDefault("isGFM", true)
    val allowTrailingMargin = props.getBooleanOrDefault("allowTrailingMargin", false)
    val fontSize = getInitialFontSize(styleMap, context, allowFontScaling, fontScale, maxFontSizeMultiplier)

    val linkRecognition = parseLinkRecognition(props.getMapOrNull("linkRecognition"))

    return try {
      val ast =
        Parser.shared.parseMarkdown(
          markdown,
          md4cFlags,
          isGFM,
          linkRecognition.text,
          linkRecognition.inlineCode,
        )
          ?: return YogaMeasureOutput.make(PixelUtil.toDIPFromPixel(width), 0f)

      val style = StyleConfig(styleMap, context, allowFontScaling, maxFontSizeMultiplier)
      style.imageRequestHeaders = parseImageRequestHeaders(props.getArrayOrNull("imageRequestHeaders"))
      style.linkPillContent = parseLinkPillContent(props.getArrayOrNull("linkPillContent"))
      val segments = splitASTIntoSegments(ast)
      val renderedSegments = MarkdownSegmentRenderer.render(segments, style, context, null, null)

      val mathHeightByIndex = HashMap<Int, Float>()
      val mathSegmentIndices = mutableListOf<Int>()
      val mathRequests = mutableListOf<MathMeasureRequest>()
      for ((i, segment) in renderedSegments.withIndex()) {
        if (segment is RenderedSegment.Math) {
          mathSegmentIndices.add(i)
          mathRequests.add(
            MathMeasureRequest(
              fontSize = style.mathStyle.fontSize,
              latex = segment.latex,
              mode = MathRenderMode.Display,
            ),
          )
        }
      }
      if (mathRequests.isNotEmpty()) {
        val mathResults = measureMathOnMainThread(context, mathRequests)
        for (i in mathSegmentIndices.indices) {
          val metrics = mathResults[i]
          mathHeightByIndex[mathSegmentIndices[i]] =
            ceil(metrics.ascent + metrics.descent).toInt() + (style.mathStyle.padding * 2)
        }
      }

      val widthPx = ceil(width).toInt().coerceAtLeast(1)
      val lastIndex = renderedSegments.lastIndex
      var totalHeightPx = 0f
      var maxContentWidthPx = 0f

      for ((index, segment) in renderedSegments.withIndex()) {
        val isLastSegment = index == lastIndex
        val includeBottomMargin = if (isLastSegment) allowTrailingMargin else true

        when (segment) {
          is RenderedSegment.Text -> {
            segment.styledText.replaceMathSpansWithPlaceholders(context)

            val layout = createStaticLayout(segment.styledText, fontSize, widthPx, id)
            totalHeightPx += layout.height

            val segmentMaxLineWidth = (0 until layout.lineCount).maxOfOrNull { layout.getLineWidth(it) } ?: 0f
            maxContentWidthPx = maxOf(maxContentWidthPx, ceil(segmentMaxLineWidth))

            if (includeBottomMargin) {
              totalHeightPx += segment.lastElementMarginBottom
            }
          }

          is RenderedSegment.Table -> {
            totalHeightPx += style.tableStyle.marginTop
            totalHeightPx += TableContainerView.measureTableNodeHeight(segment.node, style, context)
            maxContentWidthPx = width
            if (includeBottomMargin) {
              totalHeightPx += style.tableStyle.marginBottom
            }
          }

          is RenderedSegment.Math -> {
            totalHeightPx += style.mathStyle.marginTop
            totalHeightPx += mathHeightByIndex[index] ?: 0f
            maxContentWidthPx = width
            if (includeBottomMargin) {
              totalHeightPx += style.mathStyle.marginBottom
            }
          }

          is RenderedSegment.CodeBlock -> {
            totalHeightPx += style.codeBlockStyle.marginTop
            totalHeightPx += CodeBlockContainerView.measureCodeBlockNodeHeight(segment.node, style, context, width)
            maxContentWidthPx = width
            if (includeBottomMargin) {
              totalHeightPx += style.codeBlockStyle.marginBottom
            }
          }

          is RenderedSegment.Blockquote -> {
            totalHeightPx += style.blockquoteStyle.marginTop
            totalHeightPx += BlockquoteContainerView.measureBlockquoteNodeHeight(segment.node, style, context, width)
            maxContentWidthPx = width
            if (includeBottomMargin) {
              totalHeightPx += style.blockquoteStyle.marginBottom
            }
          }

          is RenderedSegment.Video -> {
            totalHeightPx += style.videoStyle.marginTop
            totalHeightPx += width / style.videoStyle.resolvedAspectRatio
            maxContentWidthPx = width
            if (includeBottomMargin) {
              totalHeightPx += style.videoStyle.marginBottom
            }
          }
        }
      }

      val totalHeightDip = PixelUtil.toDIPFromPixel(totalHeightPx)
      val measuredWidthDip = PixelUtil.toDIPFromPixel(maxContentWidthPx).coerceAtMost(PixelUtil.toDIPFromPixel(width))
      val result = YogaMeasureOutput.make(measuredWidthDip, totalHeightDip)

      if (id != null) {
        data[id] = MeasurementParams(width, result, null, PaintParams(Typeface.DEFAULT, fontSize), propsHash)
      }
      result
    } catch (e: Exception) {
      Log.w(TAG, "Split measurement failed, falling back", e)
      measureAndCache(context, id, width, props, allowFontScaling, fontScale, maxFontSizeMultiplier)
    }
  }

  internal fun createStaticLayout(
    text: CharSequence,
    fontSize: Float,
    widthPx: Int,
    viewId: Int?,
  ): StaticLayout {
    measurePaint.textSize = fontSize
    prepareWidthAwareSpans(text, widthPx)
    val measuredText = wrapForInsertionOrderedLayout(text)
    return StaticLayout.Builder
      .obtain(measuredText, 0, measuredText.length, measurePaint, widthPx)
      .setIncludePad(false)
      .setLineSpacing(0f, 1f)
      .apply {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
          @Suppress("WrongConstant")
          setBreakStrategy(resolveBreakStrategy(viewId))
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
          setUseLineSpacingFromFallbacks(true)
        }
      }.build()
  }

  private fun tryRenderMarkdown(
    markdown: String,
    styleMap: ReadableMap?,
    context: Context,
    md4cFlags: Md4cFlags,
    isGFM: Boolean,
    allowFontScaling: Boolean,
    maxFontSizeMultiplier: Float,
    imageRequestHeaders: Map<String, String> = emptyMap(),
    linkPillContent: Map<String, LinkPillContent> = emptyMap(),
    linkRegex: LinkRegexConfig? = null,
    inlineCodeLinkRegex: LinkRegexConfig? = null,
  ): Spannable? {
    if (styleMap == null) return null

    return try {
      val ast = Parser.shared.parseMarkdown(markdown, md4cFlags, isGFM, linkRegex, inlineCodeLinkRegex) ?: return null
      val style = StyleConfig(styleMap, context, allowFontScaling, maxFontSizeMultiplier)
      style.imageRequestHeaders = imageRequestHeaders
      style.linkPillContent = linkPillContent
      measureRenderer.configure(style, context)
      measureRenderer.renderDocument(ast, null)
    } catch (e: Exception) {
      Log.w(TAG, "Failed to render markdown for measurement, falling back to raw text", e)
      null
    }
  }

  private fun getInitialFontSize(
    styleMap: ReadableMap?,
    context: Context,
    allowFontScaling: Boolean,
    fontScale: Float,
    maxFontSizeMultiplier: Float,
  ): Float {
    val fontSizeSp = styleMap?.getMap("paragraph")?.getDouble("fontSize")?.toFloat() ?: 16f
    val density = context.resources.displayMetrics.density

    if (!allowFontScaling) {
      return ceil(fontSizeSp * density)
    }

    val cappedFontScale =
      if (maxFontSizeMultiplier >= 1.0f && fontScale > maxFontSizeMultiplier) {
        maxFontSizeMultiplier
      } else {
        fontScale
      }
    return ceil(fontSizeSp * cappedFontScale * density)
  }

  private fun measure(
    maxWidth: Float,
    text: CharSequence?,
    paintParams: PaintParams,
    viewId: Int?,
  ): Long {
    measurePaint.reset()
    measurePaint.typeface = paintParams.typeface
    measurePaint.textSize = paintParams.fontSize
    return measure(maxWidth, text, measurePaint, viewId)
  }

  private fun measure(
    maxWidth: Float,
    text: CharSequence?,
    paint: TextPaint,
    viewId: Int?,
  ): Long {
    val content = text ?: ""
    val safeWidth = ceil(maxWidth).toInt().coerceAtLeast(1)
    prepareWidthAwareSpans(content, safeWidth)
    val measuredText = wrapForInsertionOrderedLayout(content)

    val builder =
      StaticLayout.Builder
        .obtain(measuredText, 0, measuredText.length, paint, safeWidth)
        .setIncludePad(false)
        .setLineSpacing(0f, 1f)

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
      @Suppress("WrongConstant")
      builder.setBreakStrategy(resolveBreakStrategy(viewId))
    }

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      builder.setUseLineSpacingFromFallbacks(true)
    }

    applyLineLimit(builder, viewId)

    val layout = builder.build()
    val visibleLineCount = visibleLineCount(layout, viewId)
    val measuredHeight = truncatedHeight(layout, visibleLineCount, content)

    // Calculate actual content width (widest visible line)
    val measuredWidth = (0 until visibleLineCount).maxOfOrNull { layout.getLineWidth(it) } ?: 0f

    return YogaMeasureOutput.make(
      PixelUtil.toDIPFromPixel(ceil(measuredWidth)),
      PixelUtil.toDIPFromPixel(measuredHeight),
    )
  }

  // Applies the per-view numberOfLines / ellipsizeMode clamp to a builder, matching
  // RN's TextLayoutManager.buildLayout: only when a line limit is set.
  private fun applyLineLimit(
    builder: StaticLayout.Builder,
    viewId: Int?,
  ) {
    val maxLines = resolveMaxLines(viewId)
    if (maxLines > 0) {
      builder.setMaxLines(maxLines).setEllipsize(resolveEllipsize(viewId))
    }
  }

  private fun visibleLineCount(
    layout: StaticLayout,
    viewId: Int?,
  ): Int {
    val maxLines = resolveMaxLines(viewId)
    return if (maxLines > 0) minOf(maxLines, layout.lineCount) else layout.lineCount
  }

  private fun truncatedHeight(
    layout: StaticLayout,
    visibleLineCount: Int,
    text: CharSequence,
  ): Float {
    if (visibleLineCount <= 0) return 0f
    val lastLine = visibleLineCount - 1
    val bottom = layout.getLineBottom(lastLine).toFloat()
    return (bottom - measureLeakedTrailingMargin(layout, lastLine, text)).coerceAtLeast(0f)
  }

  // When we clamp the text mid-paragraph, drop the trailing block margin that Android
  // bakes into the truncated last line (only when content follows, like MarginBottomSpan).
  private fun measureLeakedTrailingMargin(
    layout: StaticLayout,
    lastLine: Int,
    text: CharSequence,
  ): Float {
    val spanned = text as? Spanned ?: return 0f
    val lineStart = layout.getLineStart(lastLine)
    val lineEnd = layout.getLineEnd(lastLine)
    if (lineEnd <= lineStart || lineEnd < 1 || text[lineEnd - 1] != '\n') return 0f
    if (!hasContentAfter(text, lineEnd)) return 0f
    val trailing =
      spanned
        .getSpans(lineStart, lineEnd, MarginBottomSpan::class.java)
        .firstOrNull { spanned.getSpanEnd(it) == lineEnd } ?: return 0f
    return trailing.marginBottom.toInt().toFloat()
  }

  private fun hasContentAfter(
    text: CharSequence,
    pos: Int,
  ): Boolean {
    if (pos >= text.length) return false
    if (text[pos] == '\n') {
      val nextPos = pos + 1
      if (nextPos >= text.length) return false
      return text[nextPos] != '\n'
    }
    return true
  }

  /**
   * Measures text and returns both the size and the layout for calculating last line descent.
   */
  private fun measureWithLayout(
    maxWidth: Float,
    text: CharSequence?,
    paint: TextPaint,
    viewId: Int?,
  ): Pair<Long, StaticLayout> {
    val content = text ?: ""
    val widthPx = ceil(maxWidth).toInt().coerceAtLeast(1)
    prepareWidthAwareSpans(content, widthPx)
    val measuredText = wrapForInsertionOrderedLayout(content)

    val layout =
      StaticLayout.Builder
        .obtain(measuredText, 0, measuredText.length, paint, widthPx)
        .setIncludePad(false)
        .setLineSpacing(0f, 1f)
        .apply {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            @Suppress("WrongConstant")
            setBreakStrategy(resolveBreakStrategy(viewId))
          }
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            setUseLineSpacingFromFallbacks(true)
          }
          applyLineLimit(this, viewId)
        }.build()

    val visibleLineCount = visibleLineCount(layout, viewId)

    // Find the widest visible line to get the actual content width
    val maxLineWidth =
      (0 until visibleLineCount)
        .maxOfOrNull { layout.getLineWidth(it) } ?: 0f

    val size =
      YogaMeasureOutput.make(
        PixelUtil.toDIPFromPixel(ceil(maxLineWidth)),
        PixelUtil.toDIPFromPixel(truncatedHeight(layout, visibleLineCount, content)),
      )

    return size to layout
  }

  private fun measureMathOnMainThread(
    context: Context,
    requests: List<MathMeasureRequest>,
  ): List<MathMetrics> {
    if (!FeatureFlags.IS_MATH_ENABLED || requests.isEmpty()) {
      return requests.map { estimateMathFallback(it) }
    }
    return try {
      val mathMeasureHelperClass = Class.forName("com.swmansion.enriched.markdown.spans.MathMeasureHelper")
      val method = mathMeasureHelperClass.getMethod("measure", Context::class.java, List::class.java)
      @Suppress("UNCHECKED_CAST")
      method.invoke(null, context, requests) as List<MathMetrics>
    } catch (_: Exception) {
      requests.map { estimateMathFallback(it) }
    }
  }

  private fun estimateMathFallback(request: MathMeasureRequest): MathMetrics {
    val estimatedHeight = request.fontSize * 1.4f
    return MathMetrics(
      width =
        (request.fontSize * request.latex.length * 0.5f)
          .coerceIn(request.fontSize, request.fontSize * 20f)
          .toInt(),
      ascent = estimatedHeight * 0.7f,
      descent = estimatedHeight * 0.3f,
    )
  }
}
