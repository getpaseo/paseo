package com.swmansion.enriched.markdown.input.model

/**
 * Mutable `[start, end)` character bounds shared by the stored range models so
 * [com.swmansion.enriched.markdown.input.formatting.RangeEditAdjustment] can
 * shift/clip any range kind after a text edit.
 */
interface MutableRangeBounds {
  var start: Int
  var end: Int
}
