package com.swmansion.enriched.markdown.utils.common.serialization

import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.parser.MarkdownASTNode.NodeType
import com.swmansion.enriched.markdown.parser.isTopLevelBlock
import com.swmansion.enriched.markdown.utils.common.CodeBlockNode

object MarkdownASTSerializer {
  fun serializeNode(node: MarkdownASTNode): String {
    val buffer = StringBuilder()
    appendNode(node, buffer)
    return buffer.toString()
  }

  fun serializeChildren(node: MarkdownASTNode): String {
    val buffer = StringBuilder()
    for (child in node.children) {
      appendNode(child, buffer)
    }
    return buffer.toString()
  }

  /**
   * Serializes a Blockquote or Admonition node back to markdown, including
   * the `> ` prefix on every line and `> [!TYPE]` header for admonitions.
   */
  fun serializeBlockquote(node: MarkdownASTNode): String {
    val sb = StringBuilder()
    val isAdmonition = node.type == NodeType.Admonition
    if (isAdmonition) {
      val type = node.getAttribute("admonitionType")?.takeIf { it.isNotEmpty() } ?: "note"
      sb.append("> [!${type.uppercase(java.util.Locale.ROOT)}]\n")
    }
    val body = serializeBlockChildren(node)
    for (line in body.trimEnd('\n').split("\n")) {
      sb.append("> ")
      sb.append(line)
      sb.append("\n")
    }
    return sb.toString()
  }

  /**
   * Extracts the plain text content of an AST node recursively.
   * Inserts newlines between block-level children and handles soft/hard breaks.
   */
  fun plainText(node: MarkdownASTNode): String {
    val buffer = StringBuilder()
    appendPlainText(node, buffer)
    return buffer.toString().trim()
  }

  private fun appendPlainText(
    node: MarkdownASTNode,
    buffer: StringBuilder,
  ) {
    when (node.type) {
      NodeType.SoftBreak -> {
        buffer.append("\n")
      }

      NodeType.LineBreak -> {
        buffer.append("\n")
      }

      NodeType.BlankLine -> {
        val count = node.getAttribute("count")?.toIntOrNull() ?: 0
        repeat(count) { buffer.append("\n") }
      }

      NodeType.Paragraph -> {
        for (child in node.children) {
          appendPlainText(child, buffer)
        }
        buffer.append("\n")
      }

      NodeType.Heading -> {
        for (child in node.children) {
          appendPlainText(child, buffer)
        }
        buffer.append("\n")
      }

      else -> {
        buffer.append(node.content)
        for (child in node.children) {
          appendPlainText(child, buffer)
        }
      }
    }
  }

  // -- Block-level serialization --------------------------------------------------

  private fun serializeBlockChildren(node: MarkdownASTNode): String {
    val buffer = StringBuilder()
    val children = node.children
    for ((index, child) in children.withIndex()) {
      appendBlockNode(child, buffer)
      if (index < children.size - 1 && child.type.isTopLevelBlock()) {
        buffer.append("\n")
      }
    }
    return buffer.toString()
  }

  private fun appendBlockNode(
    node: MarkdownASTNode,
    buffer: StringBuilder,
  ) {
    when (node.type) {
      NodeType.Paragraph -> {
        appendChildren(node, buffer)
        buffer.append("\n")
      }

      NodeType.Heading -> {
        val level = (node.getAttribute("level") ?: "1").toIntOrNull() ?: 1
        buffer.append("#".repeat(level))
        buffer.append(" ")
        appendChildren(node, buffer)
        buffer.append("\n")
      }

      NodeType.CodeBlock -> {
        val code = CodeBlockNode.extractCode(node)
        val language = CodeBlockNode.language(node)
        val fenceChar = CodeBlockNode.fenceChar(node)
        buffer.append(CodeBlockNode.fencedMarkdown(code, language, fenceChar))
        buffer.append("\n")
      }

      NodeType.Blockquote, NodeType.Admonition -> {
        buffer.append(serializeBlockquote(node))
      }

      NodeType.ThematicBreak -> {
        buffer.append("---\n")
      }

      NodeType.BlankLine -> {
        val count = node.getAttribute("count")?.toIntOrNull() ?: 0
        repeat(count) { buffer.append("\n") }
      }

      NodeType.Table -> {
        appendTableMarkdown(node, buffer)
      }

      NodeType.UnorderedList -> {
        appendListMarkdown(node, buffer, ordered = false)
      }

      NodeType.OrderedList -> {
        appendListMarkdown(node, buffer, ordered = true)
      }

      NodeType.LatexMathDisplay -> {
        buffer.append("$$\n")
        appendChildren(node, buffer)
        buffer.append("\n$$\n")
      }

      else -> {
        appendChildren(node, buffer)
      }
    }
  }

  // Table markdown reconstruction from raw AST nodes. This parallels
  // TableContainerView.buildMarkdownFromRows() which works from processed
  // TableCellData; both must produce the same pipe-table format.
  private fun appendTableMarkdown(
    node: MarkdownASTNode,
    buffer: StringBuilder,
  ) {
    var headerDone = false
    for (section in node.children) {
      for (row in section.children) {
        if (row.type != NodeType.TableRow) continue
        val cells = row.children.map { serializeChildren(it) }
        buffer.append("| ")
        buffer.append(cells.joinToString(" | "))
        buffer.append(" |\n")
        if (!headerDone && row.children.any { it.type == NodeType.TableHeaderCell }) {
          val sep =
            row.children.map { cell ->
              when (cell.getAttribute("align")) {
                "center" -> ":---:"
                "right" -> "---:"
                else -> "---"
              }
            }
          buffer.append("| ")
          buffer.append(sep.joinToString(" | "))
          buffer.append(" |\n")
          headerDone = true
        }
      }
    }
  }

  private fun appendListMarkdown(
    node: MarkdownASTNode,
    buffer: StringBuilder,
    ordered: Boolean,
  ) {
    var number =
      if (ordered) {
        node.getAttribute("start")?.toIntOrNull()?.coerceAtLeast(0) ?: 1
      } else {
        1
      }
    for (item in node.children) {
      if (item.type != NodeType.ListItem) continue
      val prefix = if (ordered) "$number. " else "- "
      val content = serializeBlockChildren(item).trimEnd('\n')
      val lines = content.split("\n")
      lines.forEachIndexed { lineIdx, line ->
        if (lineIdx == 0) {
          buffer.append(prefix)
        } else {
          buffer.append(" ".repeat(prefix.length))
        }
        buffer.append(line)
        buffer.append("\n")
      }
      if (ordered) number++
    }
  }

  // -- Inline serialization -------------------------------------------------------

  private fun appendNode(
    node: MarkdownASTNode,
    buffer: StringBuilder,
  ) {
    when (node.type) {
      NodeType.Text -> {
        buffer.append(node.content)
      }

      NodeType.LineBreak -> {
        buffer.append("\\\n")
      }

      NodeType.SoftBreak -> {
        buffer.append("\n")
      }

      NodeType.Strong -> {
        buffer.append("**")
        appendChildren(node, buffer)
        buffer.append("**")
      }

      NodeType.Emphasis -> {
        buffer.append("*")
        appendChildren(node, buffer)
        buffer.append("*")
      }

      NodeType.Strikethrough -> {
        buffer.append("~~")
        appendChildren(node, buffer)
        buffer.append("~~")
      }

      NodeType.Underline -> {
        buffer.append("__")
        appendChildren(node, buffer)
        buffer.append("__")
      }

      NodeType.Superscript -> {
        buffer.append("^")
        appendChildren(node, buffer)
        buffer.append("^")
      }

      NodeType.Subscript -> {
        buffer.append("~")
        appendChildren(node, buffer)
        buffer.append("~")
      }

      NodeType.Highlight -> {
        buffer.append("==")
        appendChildren(node, buffer)
        buffer.append("==")
      }

      NodeType.Code -> {
        buffer.append("`")
        appendChildren(node, buffer)
        buffer.append("`")
      }

      NodeType.Link -> {
        if (node.getAttribute("recognizedLink") == "true") {
          appendChildren(node, buffer)
          return
        }
        val url = node.getAttribute("url") ?: ""
        buffer.append("[")
        appendChildren(node, buffer)
        buffer.append("](")
        buffer.append(url)
        buffer.append(")")
      }

      NodeType.Image -> {
        val alt = node.getAttribute("alt") ?: ""
        val url = node.getAttribute("url") ?: ""
        buffer.append("![")
        buffer.append(alt)
        buffer.append("](")
        buffer.append(url)
        buffer.append(")")
      }

      NodeType.Video -> {
        val url = node.getAttribute("url") ?: ""
        if (url.contains('"')) {
          buffer.append("<video src='")
          buffer.append(url)
          buffer.append("' />")
        } else {
          buffer.append("<video src=\"")
          buffer.append(url)
          buffer.append("\" />")
        }
      }

      else -> {
        appendChildren(node, buffer)
      }
    }
  }

  private fun appendChildren(
    node: MarkdownASTNode,
    buffer: StringBuilder,
  ) {
    for (child in node.children) {
      appendNode(child, buffer)
    }
  }
}
