package com.swmansion.enriched.markdown.utils.input

import com.facebook.react.bridge.ReadableMap
import com.facebook.react.common.ReactConstants
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.views.text.ReactTypefaceUtils
import com.swmansion.enriched.markdown.input.model.InputFormatterStyle
import com.swmansion.enriched.markdown.input.model.InputHeadingStyle
import com.swmansion.enriched.markdown.input.model.InputLinkVariantStyle

object MarkdownStyleParser {
  fun parse(map: ReadableMap): InputFormatterStyle {
    val strongMap = map.getMap("strong")
    val emMap = map.getMap("em")
    val linkMap = map.getMap("link")
    val spoilerMap = map.getMap("spoiler")
    val listMap = map.getMap("list")

    return InputFormatterStyle(
      boldColor = if (strongMap?.hasKey("color") == true) strongMap.getInt("color") else null,
      italicColor = if (emMap?.hasKey("color") == true) emMap.getInt("color") else null,
      linkColor = linkMap!!.getInt("color"),
      linkUnderline = linkMap.getBoolean("underline"),
      linkBackgroundColor = linkMap.getInt("backgroundColor"),
      linkVariants = parseLinkVariants(map),
      spoilerColor = spoilerMap!!.getInt("color"),
      spoilerBackgroundColor = spoilerMap.getInt("backgroundColor"),
      headings = parseHeadings(map),
      listItemSpacing =
        if (listMap?.hasKey("itemSpacing") == true) listMap.getDouble("itemSpacing").toFloat() else 0f,
    )
  }

  // Mirrors the readonly renderer's h1..h6 markdownStyle. fontSize arrives in SP
  // (matching the JS prop) and is converted to px so the input span can size text
  // identically to the read view.
  private fun parseHeadings(map: ReadableMap): List<InputHeadingStyle> =
    (1..6).map { level ->
      val headingMap = map.getMap("h$level")
      InputHeadingStyle(
        fontSizePx =
          if (headingMap?.hasKey("fontSize") == true) {
            PixelUtil.toPixelFromSP(headingMap.getDouble("fontSize"))
          } else {
            null
          },
        fontWeight =
          if (headingMap?.hasKey("fontWeight") == true) {
            ReactTypefaceUtils.parseFontWeight(headingMap.getString("fontWeight"))
          } else {
            ReactConstants.UNSET
          },
        color = if (headingMap?.hasKey("color") == true) headingMap.getInt("color") else null,
      )
    }

  private fun parseLinkVariants(map: ReadableMap): List<InputLinkVariantStyle> {
    if (!map.hasKey("linkVariants")) return emptyList()
    val variants = map.getArray("linkVariants") ?: return emptyList()
    return (0 until variants.size()).mapNotNull { index ->
      val variant = variants.getMap(index) ?: return@mapNotNull null
      InputLinkVariantStyle(
        pattern = variant.getString("pattern") ?: return@mapNotNull null,
        color = variant.getInt("color"),
        underline = variant.getBoolean("underline"),
        backgroundColor = variant.getInt("backgroundColor"),
      )
    }
  }
}
