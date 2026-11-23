package com.swmansion.enriched.markdown.styles

import android.text.Layout

enum class TextAlignment(
  val layoutAlignment: Layout.Alignment,
  val needsJustify: Boolean,
) {
  LEFT(Layout.Alignment.ALIGN_NORMAL, false),
  CENTER(Layout.Alignment.ALIGN_CENTER, false),
  RIGHT(Layout.Alignment.ALIGN_OPPOSITE, false),
  JUSTIFY(Layout.Alignment.ALIGN_NORMAL, true),
  AUTO(Layout.Alignment.ALIGN_NORMAL, false),
  ;

  /**
   * Whether an AlignmentSpan is needed.
   * Only CENTER and RIGHT need explicit spans; LEFT/AUTO use default, JUSTIFY is handled at TextView level.
   */
  val needsAlignmentSpan: Boolean get() = this == CENTER || this == RIGHT

  companion object {
    fun fromString(value: String): TextAlignment =
      when (value.lowercase()) {
        "center" -> CENTER
        "right" -> RIGHT
        "justify" -> JUSTIFY
        "auto" -> AUTO
        else -> LEFT
      }
  }
}
