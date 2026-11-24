package com.swmansion.enriched.markdown.utils.common

import android.text.Spannable
import android.text.style.ForegroundColorSpan
import android.util.Log
import com.swmansion.enriched.markdown.styles.CodeBlockStyle
import com.swmansion.enriched.markdown.utils.text.span.SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE

/**
 * Mirror of HighlightTokenType in cpp/highlight/CodeBlockHighlighter.hpp.
 * Values cross the JNI boundary as ordinals, the same way
 * MarkdownASTNode.NodeType does; keep the declaration order in sync.
 */
enum class HighlightTokenType {
  Keyword,
  Operator,
  Punctuation,
  String,
  Number,
  Constant,
  Comment,
  Function,
  Type,
  Variable,
  Property,
  Tag,
  Attribute,
  Embedded,
}

/**
 * Platform adapter over the shared C++ syntax highlighting seam
 * (core/cpp/highlight/CodeBlockHighlighter.hpp).
 *
 * The native call returns semantic tokens as (start, end, type) int triplets
 * with UTF-16 offsets into the code string, or null when highlighting is
 * unavailable (module compiled out, unknown language, parse failure). The
 * adapter applies token colors in place as ForegroundColorSpans onto the
 * plain styled code, so highlighting can never change text metrics and the
 * measured block height stays valid. When highlighting is unavailable the
 * spannable is left untouched and renders as plain text.
 */
object CodeBlockHighlighter {
  init {
    try {
      System.loadLibrary("react_codegen_EnrichedMarkdownTextSpec")
    } catch (e: UnsatisfiedLinkError) {
      Log.e("CodeBlockHighlighter", "Failed to load native library", e)
    }
  }

  private external fun nativeHighlightCode(
    code: String,
    language: String,
  ): IntArray?

  /**
   * Applies token colors onto [target]. Token offsets are relative to [code];
   * [offset] is where that code begins in [target] (0 for the github container
   * view which highlights the code string itself, contentStart for the
   * commonmark flavor which renders code inline). A no-op when highlighting is
   * unavailable, so the plain rendering is preserved.
   */
  fun highlight(
    target: Spannable,
    code: String,
    language: String?,
    style: CodeBlockStyle,
    offset: Int = 0,
  ) {
    val tokens =
      try {
        nativeHighlightCode(code, language.orEmpty())
      } catch (e: UnsatisfiedLinkError) {
        null
      } ?: return

    val colors = style.syntaxColors
    var i = 0
    while (i + 2 < tokens.size) {
      val start = offset + tokens[i]
      val end = offset + tokens[i + 1]
      val type = HighlightTokenType.entries.getOrNull(tokens[i + 2])
      if (type != null && type.ordinal < colors.size && tokens[i] >= 0 && end > start && end <= target.length) {
        target.setSpan(ForegroundColorSpan(colors[type.ordinal]), start, end, SPAN_FLAGS_EXCLUSIVE_EXCLUSIVE)
      }
      i += 3
    }
  }
}
