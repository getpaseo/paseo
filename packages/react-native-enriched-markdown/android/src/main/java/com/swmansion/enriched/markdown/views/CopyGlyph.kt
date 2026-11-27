package com.swmansion.enriched.markdown.views

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF

/**
 * Lucide's Copy icon, the glyph the app's own copy controls use. The outline is
 * authored on Lucide's 24-unit grid with its 2-unit stroke and scaled to the
 * drawable width. Copyright Lucide Icons and Contributors (ISC); see COPY-ICON-LICENSE.
 */
internal class CopyGlyph {
  private val outline =
    Path().apply {
      addRoundRect(RectF(8f, 8f, 22f, 22f), 2f, 2f, Path.Direction.CW)
      moveTo(4f, 16f)
      cubicTo(2.9f, 16f, 2f, 15.1f, 2f, 14f)
      lineTo(2f, 4f)
      cubicTo(2f, 2.9f, 2.9f, 2f, 4f, 2f)
      lineTo(14f, 2f)
      cubicTo(15.1f, 2f, 16f, 2.9f, 16f, 4f)
    }

  fun draw(
    canvas: Canvas,
    width: Float,
    stroke: Paint,
  ) {
    val saved = canvas.save()
    canvas.scale(width / 24f, width / 24f)
    val callerStrokeWidth = stroke.strokeWidth
    stroke.strokeWidth = 2f
    canvas.drawPath(outline, stroke)
    stroke.strokeWidth = callerStrokeWidth
    canvas.restoreToCount(saved)
  }
}
