package com.swmansion.enriched.markdown.renderer

import android.content.res.AssetManager
import android.graphics.Typeface
import com.facebook.react.common.ReactConstants
import com.facebook.react.views.text.ReactTypefaceUtils.applyStyles
import com.swmansion.enriched.markdown.styles.LinkVariantEntry
import com.swmansion.enriched.markdown.styles.StyleConfig

/** Shared style cache for spans to avoid redundant calculations. */
class SpanStyleCache(
  style: StyleConfig,
) {
  private val assetManager: AssetManager = style.assetManager

  // Colors to preserve when applying inline styles (links, code, strong, emphasis)
  val colorsToPreserve: IntArray = buildColorsToPreserve(style)

  val strongFontFamily: String = style.strongStyle.fontFamily
  val strongFontWeight: String = style.strongStyle.fontWeight
  val strongColor: Int? = style.strongStyle.color
  val emphasisFontFamily: String = style.emphasisStyle.fontFamily
  val emphasisFontStyle: String = style.emphasisStyle.fontStyle
  val emphasisColor: Int? = style.emphasisStyle.color
  val strikethroughColor: Int = style.strikethroughStyle.color
  val linkFontFamily: String = style.linkStyle.fontFamily
  val linkColor: Int = style.linkStyle.color
  val linkUnderline: Boolean = style.linkStyle.underline
  val linkBackgroundColor: Int = style.linkStyle.backgroundColor
  val linkVariants: List<LinkVariantEntry> = style.linkVariants

  private val compiledVariantPatterns: List<Pair<Regex, LinkVariantEntry>> =
    linkVariants.mapNotNull { entry ->
      try {
        Regex(entry.pattern) to entry
      } catch (_: Exception) {
        null
      }
    }

  val codeFontFamily: String = style.codeStyle.fontFamily
  val codeFontSize: Float = style.codeStyle.fontSize
  val codeFontScale: Float = style.codeStyle.fontScale
  val codeColor: Int = style.codeStyle.color
  val spoilerColor: Int = style.spoilerStyle.color
  val spoilerParticleDensity: Float = style.spoilerStyle.particleDensity
  val spoilerParticleSpeed: Float = style.spoilerStyle.particleSpeed
  val spoilerSolidBorderRadius: Float = style.spoilerStyle.solidBorderRadius
  val superscriptFontScale: Float = style.superscriptStyle.fontScale
  val superscriptBaselineOffsetScale: Float = style.superscriptStyle.baselineOffsetScale
  val subscriptFontScale: Float = style.subscriptStyle.fontScale
  val subscriptBaselineOffsetScale: Float = style.subscriptStyle.baselineOffsetScale
  val highlightColor: Int = style.highlightStyle.color
  val highlightBackgroundColor: Int = style.highlightStyle.backgroundColor
  private val paragraphColor: Int = style.paragraphStyle.color

  private fun buildColorsToPreserve(style: StyleConfig): IntArray {
    val paragraphColor = style.paragraphStyle.color
    return buildList {
      style.strongStyle.color
        ?.takeIf { it != 0 && it != paragraphColor }
        ?.let { add(it) }
      style.emphasisStyle.color
        ?.takeIf { it != 0 && it != paragraphColor }
        ?.let { add(it) }
      style.linkStyle.color
        .takeIf { it != 0 && it != paragraphColor }
        ?.let { add(it) }
      style.linkVariants.forEach { variant ->
        variant.color
          .takeIf { it != 0 && it != paragraphColor }
          ?.let { add(it) }
      }
      style
        .codeStyle
        .color
        .takeIf { it != 0 && it != paragraphColor }
        ?.let { add(it) }
      style.taskListStyle.checkedTextColor
        .takeIf { it != 0 && it != paragraphColor }
        ?.let { add(it) }
    }.toIntArray()
  }

  fun getStrongColorFor(blockColor: Int): Int = strongColor ?: blockColor

  fun getHighlightColorFor(blockColor: Int): Int = if (highlightColor == paragraphColor) blockColor else highlightColor

  fun getEmphasisColorFor(
    blockColor: Int,
    currentColor: Int,
  ): Int =
    if (currentColor == blockColor) {
      emphasisColor ?: blockColor
    } else {
      currentColor
    }

  fun resolvedVariantForUrl(url: String): LinkVariantEntry? {
    if (compiledVariantPatterns.isEmpty()) return null
    return compiledVariantPatterns.firstOrNull { (regex, _) -> regex.containsMatchIn(url) }?.second
  }

  /**
   * Cached typeface for font family + style (BOLD, ITALIC, BOLD_ITALIC).
   *
   * Loads the base custom font at its NORMAL weight (via applyStyles/ReactFontManager)
   * so the bundled assets/fonts file resolves, then synthesizes bold/italic on that real
   * typeface. Requesting bold/italic directly makes ReactFontManager look for `_bold`/
   * `_italic` asset variants that single-file custom fonts don't have — and it then falls
   * back to a default system face, dropping the custom font entirely.
   */
  fun getTypeface(
    fontFamily: String,
    style: Int,
  ): Typeface =
    typefaceCache.getOrPut("family|$fontFamily|$style") {
      val base =
        applyStyles(
          null,
          ReactConstants.UNSET,
          ReactConstants.UNSET,
          fontFamily.takeIf { it.isNotEmpty() },
          assetManager,
        )
      if (style == Typeface.NORMAL) base else Typeface.create(base, style)
    }

  companion object {
    private val typefaceCache = mutableMapOf<String, Typeface>()

    /** Cached monospace typeface preserving bold/italic */
    fun getMonospaceTypeface(currentStyle: Int): Typeface =
      typefaceCache.getOrPut("monospace|$currentStyle") {
        Typeface.create(Typeface.MONOSPACE, currentStyle)
      }
  }
}
