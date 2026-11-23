package com.swmansion.enriched.markdown.input.detection

object WordsUtils {
  /**
   * Returns the start index of the token (non-whitespace run) that ends at [position].
   * If [position] is directly after whitespace (or at the start of text), returns [position].
   */
  fun tokenStart(
    text: String,
    position: Int,
  ): Int {
    var start = position
    while (start > 0 && !text[start - 1].isWhitespace()) {
      start--
    }
    return start
  }

  fun getAffectedWords(
    text: String,
    editStart: Int,
    editLength: Int,
  ): List<WordResult> {
    val textLength = text.length
    if (textLength == 0) return emptyList()

    var left = editStart.coerceIn(0, textLength)
    if (left > 0) {
      left--
      while (left > 0 && !text[left].isWhitespace()) {
        left--
      }
      if (text[left].isWhitespace()) left++
    }

    var right = (editStart + editLength).coerceIn(0, textLength)
    if (right < textLength) {
      while (right < textLength && !text[right].isWhitespace()) {
        right++
      }
    }

    if (left >= right) return emptyList()

    val results = mutableListOf<WordResult>()
    var wordStart = left
    var i = left

    while (i < right) {
      if (text[i].isWhitespace()) {
        if (i > wordStart) {
          results.add(WordResult(text.substring(wordStart, i), wordStart, i))
        }
        wordStart = i + 1
      }
      i++
    }

    if (wordStart < right) {
      results.add(WordResult(text.substring(wordStart, right), wordStart, right))
    }

    return results
  }
}
