package com.swmansion.enriched.markdown.styles

import com.facebook.react.bridge.ReadableMap

/**
 * Resolved style for a single URL-pattern variant.
 * The `pattern` field is a regex tested against the full URL in normalized order.
 * Fields are pre-merged with the base link style by the JS normalizer — native code
 * uses them directly without any additional fallback logic.
 */
data class LinkVariantEntry(
  val pattern: String,
  val color: Int,
  val underline: Boolean,
  val backgroundColor: Int,
  val fontFamily: String = "",
  /** Pill presentation for links matching this variant; null renders an ordinary link. */
  val pill: LinkPillStyle? = null,
) {
  companion object {
    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): LinkVariantEntry =
      LinkVariantEntry(
        pattern = map.getString("pattern") ?: "",
        color = parser.parseColor(map, "color"),
        underline = parser.parseBoolean(map, "underline"),
        backgroundColor = parser.parseColor(map, "backgroundColor"),
        fontFamily = parser.parseString(map, "fontFamily"),
        pill = map.getMap("pill")?.let { LinkPillStyle.fromReadableMap(it, parser) },
      )
  }
}
