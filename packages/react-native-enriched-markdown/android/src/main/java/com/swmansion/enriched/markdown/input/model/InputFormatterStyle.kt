package com.swmansion.enriched.markdown.input.model

data class InputFormatterStyle(
  val boldColor: Int?,
  val italicColor: Int?,
  val linkColor: Int,
  val linkUnderline: Boolean,
  val linkBackgroundColor: Int,
  val linkVariants: List<InputLinkVariantStyle>,
  val spoilerColor: Int,
  val spoilerBackgroundColor: Int,
  /** Per-level heading styling, indexed 0..5 for H1..H6. Always length 6. */
  val headings: List<InputHeadingStyle>,
  /**
   * Extra vertical spacing (dp) above each list item, from `markdownStyle.list.itemSpacing`.
   * Kept in dp (not px) so this stays a pure style value; the list block handlers convert
   * to px with the display density they hold.
   */
  val listItemSpacing: Float = 0f,
) {
  /**
   * Resolves the heading style for an H-level (1-6), clamping out-of-range levels
   * to the nearest valid level so a malformed parse can never crash the formatter.
   */
  fun headingStyle(level: Int): InputHeadingStyle = headings[(level - 1).coerceIn(0, headings.size - 1)]
}

/**
 * Resolved per-level heading style for the input editor.
 *
 * @property fontSizePx font size in pixels (already converted from the SP prop),
 *   or null to leave the base text size unchanged.
 * @property fontWeight parsed font weight (e.g. [android.graphics.Typeface.BOLD]),
 *   or [com.facebook.react.common.ReactConstants.UNSET] when unspecified.
 * @property color text color, or null to keep the editor's default color.
 */
data class InputHeadingStyle(
  val fontSizePx: Float?,
  val fontWeight: Int,
  val color: Int?,
)

data class InputLinkVariantStyle(
  val pattern: String,
  val color: Int,
  val underline: Boolean,
  val backgroundColor: Int,
) {
  val compiledRegex: Regex? =
    try {
      Regex(pattern)
    } catch (_: Exception) {
      null
    }
}
