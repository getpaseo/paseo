package com.swmansion.enriched.markdown.input.formatting

object InputRemend {
  private data class DelimiterPair(
    val open: String,
    val close: String,
    val symmetric: Boolean,
    // Emphasis-family delimiters (*, _, ~~) only open when left-flanking; code spans
    // and spoilers open regardless of surrounding whitespace, so they skip the check.
    val flanking: Boolean = false,
  )

  private val DELIMITER_PAIRS =
    arrayOf(
      DelimiterPair("***", "***", true, flanking = true),
      DelimiterPair("**", "**", true, flanking = true),
      DelimiterPair("*", "*", true, flanking = true),
      DelimiterPair("_", "_", true, flanking = true),
      DelimiterPair("~~", "~~", true, flanking = true),
      DelimiterPair("||", "||", true),
      DelimiterPair("`", "`", true),
      DelimiterPair("[", "]", false),
    )

  fun complete(markdown: String): String {
    if (markdown.isEmpty()) return markdown

    val stack = mutableListOf<String>()
    var inLinkParen = false
    val length = markdown.length
    var i = 0

    while (i < length) {
      val c = markdown[i]

      if (c == '\\' && i + 1 < length) {
        i += 2
        continue
      }

      if (c == ']' && !inLinkParen && i + 1 < length && markdown[i + 1] == '(') {
        val bracketIndex = stack.lastIndexOf("[")
        if (bracketIndex != -1) {
          stack.subList(bracketIndex, stack.size).clear()
        }
        inLinkParen = true
        i += 2
        continue
      }

      if (inLinkParen && c == ')') {
        inLinkParen = false
        i++
        continue
      }

      if (inLinkParen) {
        i++
        continue
      }

      var matched = false
      for (pair in DELIMITER_PAIRS) {
        val openLen = pair.open.length

        if (i + openLen > length) continue

        val substring = markdown.substring(i, i + openLen)

        if (pair.symmetric) {
          if (substring == pair.open) {
            if (stack.isNotEmpty() && stack.last() == pair.open) {
              stack.removeAt(stack.lastIndex)
            } else if (!pair.flanking || isEmphasisOpener(markdown, i, pair.open)) {
              stack.add(pair.open)
            }
            i += openLen
            matched = true
            break
          }
        } else {
          if (substring == pair.open) {
            stack.add(pair.open)
            i += openLen
            matched = true
            break
          }
          val closeLen = pair.close.length
          if (i + closeLen <= length) {
            val closeSub = markdown.substring(i, i + closeLen)
            if (closeSub == pair.close) {
              if (stack.isNotEmpty() && stack.last() == pair.open) {
                stack.removeAt(stack.lastIndex)
              }
              i += closeLen
              matched = true
              break
            }
          }
        }
      }

      if (!matched) {
        i++
      }
    }

    val suffix = StringBuilder()

    if (inLinkParen) {
      suffix.append(")")
    }

    for (entry in stack.reversed()) {
      suffix.append(closingFor(entry))
    }

    if (suffix.isEmpty()) return markdown

    return markdown + suffix.toString()
  }

  private fun closingFor(entry: String): String = DELIMITER_PAIRS.firstOrNull { it.open == entry }?.close ?: entry

  /**
   * Mirrors md4c's emphasis opener test so completion only closes a delimiter md4c
   * would actually treat as an opener: the run is a potential opener when its right
   * side is "stronger" than its left (rightLevel > 0 and rightLevel >= leftLevel),
   * where each side is scored 0 = whitespace/boundary, 1 = punctuation, 2 = other.
   * Intraword underscore (both sides "other") never opens. This rejects lone or
   * whitespace/punctuation-flanked delimiters (`control*`, `2 * 3`, `a*.`, `a_b`)
   * that would otherwise fabricate a marker. Intraword `*` (`a*b`) is a genuine md4c
   * opener, so it is not (and cannot be) rejected here.
   */
  private fun isEmphasisOpener(
    markdown: String,
    start: Int,
    open: String,
  ): Boolean {
    val leftLevel = flankingLevelAt(markdown, start - 1)
    val rightLevel = flankingLevelAt(markdown, start + open.length)
    if (open == "_" && leftLevel == 2 && rightLevel == 2) return false
    return rightLevel > 0 && rightLevel >= leftLevel
  }

  /** 0 = whitespace or out-of-bounds boundary, 1 = punctuation, 2 = letter/digit. */
  private fun flankingLevelAt(
    markdown: String,
    index: Int,
  ): Int {
    if (index !in markdown.indices) return 0
    val c = markdown[index]
    return when {
      c.isWhitespace() -> 0
      c.isLetterOrDigit() -> 2
      else -> 1
    }
  }
}
