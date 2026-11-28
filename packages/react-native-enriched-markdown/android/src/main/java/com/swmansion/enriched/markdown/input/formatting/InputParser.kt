package com.swmansion.enriched.markdown.input.formatting

import com.swmansion.enriched.markdown.input.model.BlockRange
import com.swmansion.enriched.markdown.input.model.BlockType
import com.swmansion.enriched.markdown.input.model.FormattingRange
import com.swmansion.enriched.markdown.input.model.MAX_LIST_DEPTH
import com.swmansion.enriched.markdown.input.model.StyleType
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.parser.MarkdownASTNode.NodeType
import com.swmansion.enriched.markdown.parser.Md4cFlags
import com.swmansion.enriched.markdown.parser.Parser
import com.swmansion.enriched.markdown.parser.isTopLevelBlock

data class ParseResult(
  val plainText: String,
  val formattingRanges: List<FormattingRange>,
  val blockRanges: List<BlockRange> = emptyList(),
)

object InputParser {
  // A source paragraph break: a newline followed by one or more blank lines.
  private val PARAGRAPH_BREAK_RE = Regex("\\n[ \\t]*(?:\\n[ \\t]*)+")

  fun parseToPlainTextAndRanges(rawMarkdown: String): ParseResult {
    // U+200B is the editor's reserved empty-list anchor and is stripped from every
    // output path; strip it from incoming markdown too (web paste, JS-supplied
    // values) so a foreign copy can't seed a stray anchor into the buffer. Done
    // before parsing so plain-text offsets and ranges stay consistent.
    val markdown = MarkdownSerializer.stripZwsp(rawMarkdown)
    if (markdown.isEmpty()) {
      return ParseResult("", emptyList(), emptyList())
    }

    val completed = InputRemend.complete(markdown)
    val flags = Md4cFlags(underline = true, permissiveAutolinks = false)
    val ast = Parser.shared.parseMarkdown(completed, flags) ?: return ParseResult(markdown, emptyList(), emptyList())

    val plainText = StringBuilder()
    val ranges = mutableListOf<FormattingRange>()
    val blockRanges = mutableListOf<BlockRange>()

    // md4c collapses any blank-line run into a single break, unlike iOS which keeps them.
    // Re-read the real runs so each break replays its original number of newlines.
    val blankRuns =
      ArrayDeque(
        PARAGRAPH_BREAK_RE
          .findAll(completed.trim())
          .map { match -> match.value.count { it == '\n' } }
          .toList(),
      )

    walkNode(ast, plainText, ranges, blockRanges, ArrayDeque(), blankRuns, 0, false)

    return ParseResult(plainText.toString(), ranges, blockRanges)
  }

  private fun walkNode(
    node: MarkdownASTNode,
    plainText: StringBuilder,
    ranges: MutableList<FormattingRange>,
    blockRanges: MutableList<BlockRange>,
    activeStyles: ArrayDeque<ActiveStyle>,
    blankRuns: ArrayDeque<Int>,
    listDepth: Int,
    orderedContainer: Boolean,
  ) {
    val styleType = nodeTypeToStyleType(node.type)

    if (styleType != null) {
      val url = if (styleType == StyleType.LINK) node.getAttribute("url") else null
      activeStyles.addLast(ActiveStyle(styleType, plainText.length, url))
    }

    // A list node increments the nesting depth of its items, so a list item's depth
    // is (enclosing list nodes − 1) — matching the iOS depth derivation. Depth comes
    // from this AST nesting, never from counting leading spaces.
    val isListContainer = node.type == NodeType.UnorderedList || node.type == NodeType.OrderedList
    val childListDepth = if (isListContainer) listDepth + 1 else listDepth
    val childOrdered = if (isListContainer) node.type == NodeType.OrderedList else orderedContainer

    // Each list item starts on its own line; md4c emits no separator between sibling
    // items or before a nested sublist, so insert the line break ourselves.
    if (node.type == NodeType.ListItem && plainText.isNotEmpty() && !plainText.endsWith("\n")) {
      plainText.append("\n")
    }
    val itemStart = if (node.type == NodeType.ListItem) plainText.length else -1

    // Block-level node: record where its text content begins so we can build a
    // BlockRange on the way back out. PARAGRAPH is the implicit default and is
    // dropped below, so it produces no stored block range.
    val blockLevel = node.getAttribute("level")?.toIntOrNull() ?: 0
    val blockType = nodeTypeToBlockType(node.type, blockLevel)
    val blockStartPosition = plainText.length

    if (node.type == NodeType.Text) {
      plainText.append(node.content)
    } else if (node.type == NodeType.LineBreak || node.type == NodeType.SoftBreak) {
      plainText.append("\n")
    }

    for ((index, child) in node.children.withIndex()) {
      // Keep the source's blank lines between genuinely top-level blocks (md4c drops
      // them, iOS keeps them). Inside a list, items are separated by a single newline
      // (inserted above), not blank lines.
      if (index > 0 && listDepth == 0 && child.type.isTopLevelBlock() && plainText.isNotEmpty()) {
        plainText.append("\n".repeat(blankRuns.removeFirstOrNull() ?: 2))
      }
      walkNode(child, plainText, ranges, blockRanges, activeStyles, blankRuns, childListDepth, childOrdered)
    }

    // A list item owns its own first line; a nested sublist lives on later lines, so
    // the item's range ends at the first newline after its start.
    if (itemStart >= 0) {
      var lineEnd = plainText.indexOf('\n', itemStart)
      if (lineEnd < 0) lineEnd = plainText.length
      if (lineEnd > itemStart) {
        // The item sees listDepth already incremented by its enclosing list node, so
        // its 0-based depth is listDepth − 1 (enclosing list nodes − 1, per iOS).
        val depth = (listDepth - 1).coerceIn(0, MAX_LIST_DEPTH)
        val itemType = if (orderedContainer) BlockType.ORDERED_LIST_ITEM else BlockType.UNORDERED_LIST_ITEM
        blockRanges.add(BlockRange(itemType, itemStart, lineEnd, depth))
      }
    }

    if (styleType != null) {
      val activeStyle = activeStyles.removeLast()
      val end = plainText.length
      if (end > activeStyle.startPosition) {
        ranges.add(FormattingRange(styleType, activeStyle.startPosition, end, activeStyle.url))
      }
    }

    // Emit the block range for handler-claimed block types only; PARAGRAPH (the
    // implicit default) yields nothing. List items are emitted above with their own
    // line bounds, so they are excluded here.
    if (blockType != null && blockType != BlockType.PARAGRAPH && blockType !in BlockType.LIST_ITEMS) {
      val end = plainText.length
      if (end > blockStartPosition) {
        blockRanges.add(BlockRange(blockType, blockStartPosition, end, blockLevel))
      }
    }
  }

  private fun nodeTypeToStyleType(nodeType: NodeType): StyleType? =
    when (nodeType) {
      NodeType.Strong -> StyleType.BOLD
      NodeType.Emphasis -> StyleType.ITALIC
      NodeType.Underline -> StyleType.UNDERLINE
      NodeType.Strikethrough -> StyleType.STRIKETHROUGH
      NodeType.Link -> StyleType.LINK
      NodeType.Spoiler -> StyleType.SPOILER
      else -> null
    }

  /**
   * Maps a parser block node to a [BlockType], mirroring [nodeTypeToStyleType]
   * for inline spans. A heading maps to its per-level `HEADING_n` (from the node's
   * `level` attribute); an out-of-range level falls back to PARAGRAPH so a
   * malformed parse degrades gracefully rather than dropping the line.
   */
  private fun nodeTypeToBlockType(
    nodeType: NodeType,
    level: Int,
  ): BlockType? =
    when (nodeType) {
      NodeType.Paragraph -> BlockType.PARAGRAPH

      NodeType.Heading -> BlockType.forHeadingLevel(level) ?: BlockType.PARAGRAPH

      // List items are recognized here but emitted with their own per-line bounds and
      // AST-derived nesting depth in the walk above, not via the generic emission.
      NodeType.ListItem -> BlockType.UNORDERED_LIST_ITEM

      else -> null
    }

  private data class ActiveStyle(
    val type: StyleType,
    val startPosition: Int,
    val url: String?,
  )
}
