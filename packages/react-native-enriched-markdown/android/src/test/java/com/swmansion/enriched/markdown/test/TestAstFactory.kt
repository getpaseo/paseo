package com.swmansion.enriched.markdown.test

import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.parser.MarkdownASTNode.NodeType

object TestAstFactory {
  fun paragraph(vararg children: MarkdownASTNode): MarkdownASTNode = MarkdownASTNode(NodeType.Paragraph, children = children.toList())

  fun text(content: String): MarkdownASTNode = MarkdownASTNode(NodeType.Text, content = content)

  /** An ordered list; [start] is the first number, as md4c reports it. */
  fun orderedList(
    vararg items: MarkdownASTNode,
    start: Int? = null,
  ): MarkdownASTNode =
    MarkdownASTNode(
      type = NodeType.OrderedList,
      attributes = start?.let { mapOf("start" to it.toString()) }.orEmpty(),
      children = items.toList(),
    )

  fun unorderedList(vararg items: MarkdownASTNode): MarkdownASTNode = MarkdownASTNode(NodeType.UnorderedList, children = items.toList())

  fun listItem(vararg children: MarkdownASTNode): MarkdownASTNode = MarkdownASTNode(NodeType.ListItem, children = children.toList())

  /** A GFM task-list item, what md4c produces for `- [ ]` / `- [x]`. */
  fun taskListItem(
    checked: Boolean,
    vararg children: MarkdownASTNode,
  ): MarkdownASTNode =
    MarkdownASTNode(
      type = NodeType.ListItem,
      attributes = mapOf("isTask" to "true", "taskChecked" to checked.toString()),
      children = children.toList(),
    )
}
