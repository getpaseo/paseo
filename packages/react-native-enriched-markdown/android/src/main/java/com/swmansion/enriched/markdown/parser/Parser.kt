package com.swmansion.enriched.markdown.parser

import android.util.Log
import com.swmansion.enriched.markdown.utils.common.FeatureFlags
import com.swmansion.enriched.markdown.utils.common.LinkRegexConfig

data class Md4cFlags(
  val underline: Boolean = false,
  val latexMath: Boolean = FeatureFlags.IS_MATH_ENABLED,
  val superscript: Boolean = false,
  val subscript: Boolean = false,
  val highlight: Boolean = false,
  val permissiveAutolinks: Boolean = true,
  val hardSoftBreaks: Boolean = false,
  val preserveBlankLines: Boolean = false,
  val admonitions: Boolean = true,
) {
  companion object {
    val DEFAULT = Md4cFlags()
  }
}

class Parser {
  companion object {
    init {
      try {
        // Library name must follow react_codegen_<ComponentName> convention
        // required by React Native Fabric's CMake build system.
        // md4c parser is bundled in the same shared library to avoid
        // multiple library loading and complex linking dependencies.
        System.loadLibrary("react_codegen_EnrichedMarkdownTextSpec")
      } catch (e: UnsatisfiedLinkError) {
        Log.e("MarkdownParser", "Failed to load native library", e)
      }
    }

    @JvmStatic
    private external fun nativeParseMarkdown(
      markdown: String,
      flags: Md4cFlags,
      isGFM: Boolean,
      textLinkRegex: LinkRegexConfig?,
      inlineCodeLinkRegex: LinkRegexConfig?,
    ): MarkdownASTNode?

    /**
     * Shared parser instance. Parser is stateless and thread-safe, so it can be reused
     * across all EnrichedMarkdownText instances to avoid unnecessary allocations.
     */
    val shared: Parser = Parser()
  }

  fun parseMarkdown(
    markdown: String,
    flags: Md4cFlags = Md4cFlags.DEFAULT,
    isGFM: Boolean = true,
    linkRegex: LinkRegexConfig? = null,
    inlineCodeLinkRegex: LinkRegexConfig? = null,
  ): MarkdownASTNode? {
    if (markdown.isBlank()) {
      return null
    }

    try {
      // Only active patterns cross JNI.
      val ast =
        nativeParseMarkdown(
          markdown,
          flags,
          isGFM,
          linkRegex?.takeIf { it.compiled != null },
          inlineCodeLinkRegex?.takeIf { it.compiledWholeSpan != null },
        )

      if (ast != null) {
        return ast
      } else {
        Log.w("MarkdownParser", "Native parser returned null")
        return null
      }
    } catch (e: Exception) {
      Log.e("MarkdownParser", "MD4C parsing failed: ${e.message}", e)
      return null
    }
  }
}
