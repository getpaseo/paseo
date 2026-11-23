package com.swmansion.enriched.markdown.utils.common

import android.util.Log
import com.swmansion.enriched.markdown.parser.MarkdownASTNode

/**
 * Shared code block node semantics, used by both markdown flavors so the
 * meaning of a CodeBlock AST node (its text, language, fence) is defined in
 * one place. Language display names come from the shared C++ core
 * (cpp/highlight/CodeBlockLanguages.hpp) so all platforms label fences
 * identically; when the native library is unavailable the raw fence string
 * is shown instead.
 */
object CodeBlockNode {
  init {
    try {
      System.loadLibrary("react_codegen_EnrichedMarkdownTextSpec")
    } catch (e: UnsatisfiedLinkError) {
      Log.e("CodeBlockNode", "Failed to load native library", e)
    }
  }

  private external fun nativeDisplayLanguageName(language: String): String?

  fun extractCode(node: MarkdownASTNode): String {
    val builder = StringBuilder()

    fun append(current: MarkdownASTNode) {
      builder.append(current.content)
      current.children.forEach { append(it) }
    }
    append(node)
    return builder.toString().trimEnd('\n')
  }

  fun language(node: MarkdownASTNode): String? = node.getAttribute("language")?.takeIf { it.isNotEmpty() }

  fun fenceChar(node: MarkdownASTNode): String = node.getAttribute("fenceChar")?.takeIf { it.isNotEmpty() } ?: "`"

  fun fencedMarkdown(
    code: String,
    language: String?,
    fenceChar: String,
  ): String {
    val fence = fenceChar.repeat(3)
    return "$fence${language.orEmpty()}\n$code\n$fence"
  }

  fun displayLanguageName(language: String?): String {
    if (language.isNullOrEmpty()) return ""
    return try {
      nativeDisplayLanguageName(language)
    } catch (e: UnsatisfiedLinkError) {
      null
    } ?: language
  }
}
