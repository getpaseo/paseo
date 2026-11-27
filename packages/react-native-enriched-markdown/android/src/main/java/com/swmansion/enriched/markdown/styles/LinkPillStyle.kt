package com.swmansion.enriched.markdown.styles

import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import com.facebook.react.bridge.ReadableMap

/** Geometry and default content of a variant's pill. Dimensions are in pixels. */
data class LinkPillStyle(
  val content: LinkPillContent = LinkPillContent(),
  val borderRadius: Float = 8f,
  val paddingHorizontal: Float = 6f,
  val paddingVertical: Float = 2f,
  /** Minimum line height of a block that holds the pill; 0 when unset. */
  val lineHeight: Float = 0f,
  val borderWidth: Float = 0f,
  val borderColor: Int = Color.TRANSPARENT,
  val maxWidth: Float = 0f,
) {
  /** Replaces the icon's colors and keeps its alpha; shared by every pill of the variant. */
  val iconTint: ColorFilter? = content.iconTintColor?.let { PorterDuffColorFilter(it, PorterDuff.Mode.SRC_IN) }

  companion object {
    /** Returns null when the variant does not enable pill presentation. */
    fun fromReadableMap(
      map: ReadableMap,
      parser: StyleParser,
    ): LinkPillStyle? {
      if (!parser.parseBoolean(map, "enabled")) return null
      return LinkPillStyle(
        content =
          LinkPillContent.fromReadableMap(map).copy(iconTintColor = parser.parseOptionalColor(map, "iconTintColor")),
        borderRadius = parser.toPixelFromDIP(parser.parseOptionalDouble(map, "borderRadius", 8.0).toFloat()),
        paddingHorizontal = parser.toPixelFromDIP(parser.parseOptionalDouble(map, "paddingHorizontal", 6.0).toFloat()),
        paddingVertical = parser.toPixelFromDIP(parser.parseOptionalDouble(map, "paddingVertical", 2.0).toFloat()),
        lineHeight = parser.toPixelFromSP(parser.parseOptionalDouble(map, "lineHeight").toFloat()),
        borderWidth = parser.toPixelFromDIP(parser.parseOptionalDouble(map, "borderWidth").toFloat()),
        borderColor = parser.parseOptionalColor(map, "borderColor") ?: Color.TRANSPARENT,
        maxWidth = parser.toPixelFromDIP(parser.parseOptionalDouble(map, "maxWidth").toFloat()),
      )
    }
  }
}
