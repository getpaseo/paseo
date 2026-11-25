package com.swmansion.enriched.markdown.segments

import android.content.Context
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.drawable.Drawable
import android.widget.ImageView
import androidx.appcompat.widget.AppCompatImageButton
import com.swmansion.enriched.markdown.styles.CodeBlockStyle
import com.swmansion.enriched.markdown.views.CopyGlyph
import kotlin.math.ceil
import kotlin.math.roundToInt

/**
 * The copy control at the trailing edge of a block's header band. Code blocks
 * and quotes share it, so the band height, hit box, glyph and placement stay
 * the same on both. The band is the code block header: one label line above
 * the content inset.
 */
internal class HeaderCopyButton(
  context: Context,
  style: CodeBlockStyle,
  private val label: () -> CharSequence,
) : AppCompatImageButton(context) {
  /** Height of the band, and the side of the button's square hit box. */
  val bandHeight: Int = CodeBlockContainerView.headerHeight(style)

  private val inset: Int = CodeBlockContainerView.contentInset(style)

  /** Vertical center of the band's content; the divider sits halfway into the inset below it. */
  val bandCenterY: Float = (bandHeight + inset / 2f) / 2f

  init {
    background = null
    scaleType = ImageView.ScaleType.CENTER
    setImageDrawable(
      CopyIconDrawable(
        CodeBlockContainerView.secondaryColor(style.color),
        ceil(style.fontSize * ICON_SCALE).toInt(),
      ),
    )
  }

  // Read live so a runtime label change reaches TalkBack without a push.
  override fun getContentDescription(): CharSequence = label()

  fun measureInBand() {
    val spec = MeasureSpec.makeMeasureSpec(bandHeight, MeasureSpec.EXACTLY)
    measure(spec, spec)
  }

  /** Puts the glyph's trailing edge on the container's content inset. */
  fun layoutInBand(containerWidth: Int) {
    val iconWidth = drawable?.intrinsicWidth ?: bandHeight
    val iconSlack = ((bandHeight - iconWidth) / 2).coerceAtLeast(0)
    val left = (containerWidth - inset - bandHeight + iconSlack).coerceAtLeast(0)
    val top = (bandCenterY - bandHeight / 2f).roundToInt().coerceAtLeast(0)
    layout(left, top, left + bandHeight, top + bandHeight)
  }

  private class CopyIconDrawable(
    color: Int,
    private val size: Int,
  ) : Drawable() {
    private val paint =
      Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.STROKE
        strokeJoin = Paint.Join.ROUND
        strokeCap = Paint.Cap.ROUND
        this.color = color
      }

    private val glyph = CopyGlyph()

    override fun draw(canvas: Canvas) {
      glyph.draw(canvas, bounds.width().toFloat(), paint)
    }

    override fun getIntrinsicWidth() = size

    override fun getIntrinsicHeight() = size

    override fun setAlpha(alpha: Int) {
      paint.alpha = alpha
    }

    override fun setColorFilter(colorFilter: ColorFilter?) {
      paint.colorFilter = colorFilter
    }

    @Deprecated("Deprecated in Java")
    override fun getOpacity() = PixelFormat.TRANSLUCENT
  }

  private companion object {
    // Glyph box as a multiple of the code font size; iOS uses the same scale.
    const val ICON_SCALE = 1.08f
  }
}
