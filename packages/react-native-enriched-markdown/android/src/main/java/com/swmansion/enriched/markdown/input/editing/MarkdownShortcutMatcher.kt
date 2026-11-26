package com.swmansion.enriched.markdown.input.editing

import com.swmansion.enriched.markdown.input.model.BlockType

/**
 * Which shortcut families are enabled, normalized on the JS side so native
 * never sees the public `boolean | MarkdownShortcutsConfig` union.
 */
data class MarkdownShortcutsConfig(
  val heading: Boolean = false,
  val unorderedList: Boolean = false,
  val orderedList: Boolean = false,
) {
  val isEnabled: Boolean
    get() = heading || unorderedList || orderedList
}

/**
 * Recognizes the markdown block prefixes a user types at the start of a
 * paragraph — `#`…`######`, `-`/`*`/`+`, `1.`/`1)` — so the input can turn the
 * paragraph into the matching block and drop the prefix (Notion-style markdown
 * shortcuts). Pure text matching; the caller owns the mutation.
 */
internal object MarkdownShortcutMatcher {
  data class Match(
    val type: BlockType,
    val level: Int,
  )

  /** Anything longer is a number the user is writing, not a list marker. */
  private const val MAX_ORDERED_MARKER_DIGITS = 9

  /**
   * Matches [prefix] (the paragraph text before the space the user just typed,
   * with no leading whitespace) against the families [config] enables. Ordered
   * items match any number — the block store renumbers ordinals, so `3.` on a
   * fresh line still starts at 1.
   */
  fun match(
    prefix: CharSequence,
    config: MarkdownShortcutsConfig,
  ): Match? {
    if (prefix.isEmpty()) return null
    val first = prefix[0]

    if (first == '#') {
      if (!config.heading || prefix.length > 6 || !prefix.all { it == '#' }) return null
      val type = BlockType.forHeadingLevel(prefix.length) ?: return null
      return Match(type, prefix.length)
    }

    if (prefix.length == 1 && first in "-*+") {
      return if (config.unorderedList) Match(BlockType.UNORDERED_LIST_ITEM, 0) else null
    }

    val last = prefix.last()
    if ((last == '.' || last == ')') && prefix.length >= 2 && prefix.length - 1 <= MAX_ORDERED_MARKER_DIGITS) {
      if (prefix.subSequence(0, prefix.length - 1).all { it in '0'..'9' }) {
        return if (config.orderedList) Match(BlockType.ORDERED_LIST_ITEM, 0) else null
      }
    }
    return null
  }
}
