package com.swmansion.enriched.markdown.segments

import android.content.Context
import android.text.Spannable
import com.swmansion.enriched.markdown.math.LatexErrorReporter
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.renderer.BlockquoteTextRenderer
import com.swmansion.enriched.markdown.renderer.Renderer
import com.swmansion.enriched.markdown.spans.ImageSpan
import com.swmansion.enriched.markdown.styles.BlockquoteStyle
import com.swmansion.enriched.markdown.styles.StyleConfig

sealed interface RenderedSegment {
  val signature: Long

  data class Text(
    /**
     * The renderer's own buffer, which the segment's text view adopts uncopied.
     * Once displayed it *is* the view's live text, so the view mutates it: `TextView`
     * attaches its `ChangeWatcher`, the `Editor` its `SpanController`, and selection
     * adds and moves the selection marks — all as spans on this very instance.
     *
     * A segment is therefore only a faithful record of what the renderer produced
     * until the view takes it. Anything that caches, diffs, counts or hashes the spans
     * here must read them before the segment is applied, or filter the view's spans
     * out; reading afterwards yields the view's bookkeeping mixed in with the markdown
     * spans, and a result that changes as the user merely selects text.
     */
    val styledText: Spannable,
    val imageSpans: List<ImageSpan>,
    val needsJustify: Boolean,
    val lastElementMarginBottom: Float,
    override val signature: Long,
  ) : RenderedSegment

  data class Table(
    val node: MarkdownASTNode,
    override val signature: Long,
  ) : RenderedSegment

  data class Math(
    val latex: String,
    override val signature: Long,
  ) : RenderedSegment

  data class CodeBlock(
    val node: MarkdownASTNode,
    override val signature: Long,
  ) : RenderedSegment

  data class Blockquote(
    val node: MarkdownASTNode,
    override val signature: Long,
  ) : RenderedSegment

  data class Video(
    val node: MarkdownASTNode,
    override val signature: Long,
  ) : RenderedSegment
}

object MarkdownSegmentRenderer {
  fun render(
    segments: List<MarkdownSegment>,
    style: StyleConfig,
    context: Context,
    onLinkPress: ((String, String) -> Unit)?,
    onLinkLongPress: ((String) -> Unit)?,
    blockquoteStyle: BlockquoteStyle? = null,
    onLatexError: LatexErrorReporter? = null,
  ): List<RenderedSegment> =
    segments.map { segment ->
      when (segment) {
        is MarkdownSegment.Text -> {
          renderTextSegment(segment.nodes, style, context, onLinkPress, onLinkLongPress, blockquoteStyle, onLatexError)
        }

        is MarkdownSegment.Table -> {
          val signature = SegmentSignature.signatureForNode(segment.node) xor SegmentSignature.TABLE_KIND_SALT
          RenderedSegment.Table(segment.node, signature)
        }

        is MarkdownSegment.Math -> {
          var signature = SegmentSignature.signatureForNode(null) xor SegmentSignature.MATH_KIND_SALT
          signature = SegmentSignature.fnvMixString(signature, segment.latex)
          RenderedSegment.Math(segment.latex, signature)
        }

        is MarkdownSegment.CodeBlock -> {
          val signature = SegmentSignature.signatureForNode(segment.node) xor SegmentSignature.CODE_BLOCK_KIND_SALT
          RenderedSegment.CodeBlock(segment.node, signature)
        }

        is MarkdownSegment.Blockquote -> {
          val signature = SegmentSignature.signatureForNode(segment.node) xor SegmentSignature.BLOCKQUOTE_KIND_SALT
          RenderedSegment.Blockquote(segment.node, signature)
        }

        is MarkdownSegment.Video -> {
          val signature = SegmentSignature.signatureForNode(segment.node) xor SegmentSignature.VIDEO_KIND_SALT
          RenderedSegment.Video(segment.node, signature)
        }
      }
    }

  private fun renderTextSegment(
    nodes: List<MarkdownASTNode>,
    style: StyleConfig,
    context: Context,
    onLinkPress: ((String, String) -> Unit)?,
    onLinkLongPress: ((String) -> Unit)?,
    blockquoteStyle: BlockquoteStyle?,
    onLatexError: LatexErrorReporter?,
  ): RenderedSegment.Text {
    val renderer = Renderer().apply { configure(style, context, onLatexError) }
    val signature = SegmentSignature.signatureForNodes(nodes) xor SegmentSignature.TEXT_KIND_SALT

    val styledText =
      if (blockquoteStyle != null) {
        BlockquoteTextRenderer(blockquoteStyle).render(renderer, nodes, onLinkPress, onLinkLongPress)
      } else {
        renderer.renderContent(nodes, onLinkPress, onLinkLongPress)
      }

    return RenderedSegment.Text(
      styledText = styledText,
      imageSpans = renderer.getCollectedImageSpans().toList(),
      needsJustify = style.needsJustify,
      lastElementMarginBottom = renderer.getLastElementMarginBottom(),
      signature = signature,
    )
  }
}
