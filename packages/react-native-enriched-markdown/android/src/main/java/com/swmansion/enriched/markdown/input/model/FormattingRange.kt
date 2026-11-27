package com.swmansion.enriched.markdown.input.model

/**
 * Deliberately NOT a data class: [start]/[end] mutate as edits shift ranges, so
 * value-based equals/hashCode would silently break set/map lookups. Identity
 * semantics are the safe default for a mutable model.
 */
class FormattingRange(
  val type: StyleType,
  override var start: Int,
  override var end: Int,
  var url: String? = null,
) : MutableRangeBounds {
  val length: Int get() = end - start
}
