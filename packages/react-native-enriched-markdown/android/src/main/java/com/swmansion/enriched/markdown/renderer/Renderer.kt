package com.swmansion.enriched.markdown.renderer

import android.content.Context
import android.text.SpannableStringBuilder
import com.swmansion.enriched.markdown.math.LatexErrorReporter
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.spans.ImageSpan
import com.swmansion.enriched.markdown.spans.MarginBottomSpan
import com.swmansion.enriched.markdown.styles.StyleConfig

class Renderer {
  private var cachedFactory: RendererFactory? = null
  private var cachedStyle: StyleConfig? = null
  private var cachedContext: Context? = null
  private var cachedOnLatexError: LatexErrorReporter? = null

  private val collectedImageSpans = mutableListOf<ImageSpan>()
  private var lastElementMarginBottom: Float = 0f

  fun configure(
    style: StyleConfig,
    context: Context,
    onLatexError: LatexErrorReporter? = null,
  ) {
    if (cachedStyle === style && cachedContext === context && cachedOnLatexError === onLatexError) return

    cachedStyle = style
    cachedContext = context
    cachedOnLatexError = onLatexError
    cachedFactory =
      RendererFactory(
        RendererConfig(style, onLatexError),
        context,
      ) { span -> reportImageSpan(span) }
  }

  fun renderDocument(
    document: MarkdownASTNode,
    onLinkPress: ((String, String) -> Unit)? = null,
    onLinkLongPress: ((String) -> Unit)? = null,
  ): SpannableStringBuilder = renderContent(document.children, onLinkPress, onLinkLongPress)

  /**
   * Renders a flat list of sibling nodes into a fresh buffer and hands over
   * ownership of it. This is the generic envelope shared by the document and
   * block-segment paths: reset the factory, build the spannable, trim the trailing
   * margin, and flush deferred spans (e.g. BaselineShiftSpan) after all block-level
   * spans are set - see BaselineShiftRenderer for the proper long-term fix.
   *
   * An optional [block] decorates the pass - it enters a block style before the
   * nodes render and post-processes the finished builder - letting a caller render
   * content as e.g. blockquote text without this class knowing anything
   * block-specific. See [BlockquoteTextRenderer].
   *
   * The builder is returned as-is rather than frozen into a `SpannableString`:
   * the markdown text view adopts it verbatim (see `NoCopySpannableFactory`),
   * and converting it would cost a quadratic span copy for no benefit. Each call
   * builds its own buffer, so callers must not mutate one they have passed on.
   */
  fun renderContent(
    nodes: List<MarkdownASTNode>,
    onLinkPress: ((String, String) -> Unit)? = null,
    onLinkLongPress: ((String) -> Unit)? = null,
    block: BlockquoteTextRenderer? = null,
  ): SpannableStringBuilder {
    val factory =
      requireNotNull(cachedFactory) {
        "Renderer must be configured with a style before rendering."
      }

    factory.resetForNewRender()
    collectedImageSpans.clear()
    lastElementMarginBottom = 0f

    val builder = SpannableStringBuilder()

    block?.push(factory.blockStyleContext)
    try {
      factory.renderNodes(nodes, builder, onLinkPress, onLinkLongPress)
    } finally {
      block?.pop(factory.blockStyleContext)
    }

    removeTrailingMargin(builder)
    block?.postProcess(builder)
    factory.flushDeferredSpans(builder)

    return builder
  }

  /** Removes trailing newlines and captures the margin of the final element. */
  private fun removeTrailingMargin(builder: SpannableStringBuilder) {
    if (builder.isEmpty()) return

    // Identify the last margin span and store its value
    val lastSpan =
      builder
        .getSpans(0, builder.length, MarginBottomSpan::class.java)
        .maxByOrNull { builder.getSpanEnd(it) }

    lastElementMarginBottom = lastSpan?.marginBottom ?: 0f

    // Trim trailing newlines
    while (builder.endsWith('\n')) {
      builder.delete(builder.length - 1, builder.length)
    }

    // Clean up the span if it no longer covers any text
    if (lastSpan != null && builder.getSpanEnd(lastSpan) >= builder.length) {
      builder.removeSpan(lastSpan)
    }
  }

  /**
   * Returns the marginBottom value of the last element in the document.
   * This is dynamically determined from the actual last element (paragraph, image, heading, etc.)
   * and can be used in MeasurementStore to adjust the measured height.
   */
  fun getLastElementMarginBottom(): Float = lastElementMarginBottom

  /**
   * Internal helper used by the Factory's lambda to collect spans.
   */
  private fun reportImageSpan(span: ImageSpan) {
    collectedImageSpans.add(span)
  }

  /**
   * Provides the EnrichedMarkdownText with the exact list of spans that need registration.
   */
  fun getCollectedImageSpans(): List<ImageSpan> = collectedImageSpans
}
