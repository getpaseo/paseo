package com.swmansion.enriched.markdown.parser

import com.swmansion.enriched.markdown.utils.common.LinkRegexConfig

/** Host matchers the native parser calls back into; offsets are UTF-16 code units, as the core expects. */
internal object TextLinkMatching {
  /** Flat (run index, start, end) triples for every nonempty match, in order. */
  @JvmStatic
  fun matchText(
    runs: Array<String>,
    config: LinkRegexConfig,
  ): IntArray {
    val pattern = config.compiled ?: return IntArray(0)
    val result = ArrayList<Int>()
    runs.forEachIndexed { index, run ->
      val matcher = pattern.matcher(run)
      while (matcher.find()) {
        if (matcher.end() == matcher.start()) continue
        result.add(index)
        result.add(matcher.start())
        result.add(matcher.end())
      }
    }
    return result.toIntArray()
  }

  @JvmStatic
  fun matchWholeCode(
    spans: Array<String>,
    config: LinkRegexConfig,
  ): BooleanArray {
    val pattern = config.compiledWholeSpan ?: return BooleanArray(spans.size)
    return BooleanArray(spans.size) { index -> pattern.matcher(spans[index]).find() }
  }
}
