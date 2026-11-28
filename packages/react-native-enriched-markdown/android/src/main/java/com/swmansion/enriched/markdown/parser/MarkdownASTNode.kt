package com.swmansion.enriched.markdown.parser

data class MarkdownASTNode(
  val type: NodeType,
  val content: String = "",
  val attributes: Map<String, String> = emptyMap(),
  val children: List<MarkdownASTNode> = emptyList(),
) {
  enum class NodeType {
    Document,
    Paragraph,
    Text,
    Link,
    Heading,
    LineBreak,
    Strong,
    Emphasis,
    Strikethrough,
    Underline,
    Code,
    Image,
    Blockquote,
    UnorderedList,
    OrderedList,
    ListItem,
    CodeBlock,
    ThematicBreak,
    Table,
    TableHead,
    TableBody,
    TableRow,
    TableHeaderCell,
    TableCell,
    LatexMathInline,
    LatexMathDisplay,
    Spoiler,
    Superscript,
    Subscript,
    Highlight,
    SoftBreak,
    BlankLine,
    Admonition,
    Video,
  }

  fun getAttribute(key: String): String? = attributes[key]
}

// A node type that md4c emits as a standalone block stacked vertically, as opposed to an inline span.
internal fun MarkdownASTNode.NodeType.isTopLevelBlock(): Boolean =
  when (this) {
    MarkdownASTNode.NodeType.Paragraph,
    MarkdownASTNode.NodeType.Heading,
    MarkdownASTNode.NodeType.Blockquote,
    MarkdownASTNode.NodeType.Admonition,
    MarkdownASTNode.NodeType.UnorderedList,
    MarkdownASTNode.NodeType.OrderedList,
    MarkdownASTNode.NodeType.CodeBlock,
    MarkdownASTNode.NodeType.ThematicBreak,
    MarkdownASTNode.NodeType.BlankLine,
    MarkdownASTNode.NodeType.Table,
    MarkdownASTNode.NodeType.LatexMathDisplay,
    MarkdownASTNode.NodeType.Video,
    -> true

    else -> false
  }
