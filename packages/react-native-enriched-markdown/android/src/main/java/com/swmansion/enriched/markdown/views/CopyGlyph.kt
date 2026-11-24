package com.swmansion.enriched.markdown.views

import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode

/**
 * Draws the copy glyph so Android matches the SF Symbol doc.on.doc rendered on
 * iOS: two portrait document pages with a folded (dog-eared) top-right corner,
 * a front page in the lower-left laid over a back page in the upper-right.
 *
 * The back page is punched out where the front page (plus a hairline of
 * clearance) covers it, so the front reads as sitting on top exactly as the SF
 * Symbol does, instead of both outlines crossing. The clear is done inside an
 * offscreen layer so the punched region reveals whatever background the drawable
 * sits on, without the glyph needing to know that color.
 *
 * One instance is held per drawable rather than shared: the paths and clear
 * paint are reused across draws to keep draw() allocation-free, and two drawables
 * of different sizes must not share those buffers. All coordinates use a 24-unit
 * grid scaled to the drawable width, matching the grid the iOS symbol is authored
 * on.
 */
internal class CopyGlyph {
  private val back = Path()
  private val front = Path()
  private val backFold = Path()
  private val frontFold = Path()

  // Color and colorFilter are irrelevant under PorterDuff.CLEAR; only the
  // widened stroke (set per draw) matters, so this is configured once.
  private val clearPaint =
    Paint(Paint.ANTI_ALIAS_FLAG).apply {
      style = Paint.Style.FILL_AND_STROKE
      strokeJoin = Paint.Join.ROUND
      strokeCap = Paint.Cap.ROUND
      xfermode = PorterDuffXfermode(PorterDuff.Mode.CLEAR)
    }

  fun draw(
    canvas: Canvas,
    width: Float,
    stroke: Paint,
  ) {
    val u = width / 24f
    val fold = 4f * u
    val corner = 2f * u

    buildPage(back, 9 * u, 1 * u, 20 * u, 17 * u, fold, corner)
    buildPage(front, 3 * u, 7 * u, 14 * u, 23 * u, fold, corner)
    buildFold(backFold, 20 * u, 1 * u, fold)
    buildFold(frontFold, 14 * u, 7 * u, fold)
    clearPaint.strokeWidth = stroke.strokeWidth * 3f

    val saved = canvas.saveLayer(0f, 0f, width, width, null)
    canvas.drawPath(back, stroke)
    canvas.drawPath(backFold, stroke)
    canvas.drawPath(front, clearPaint)
    canvas.drawPath(front, stroke)
    canvas.drawPath(frontFold, stroke)
    canvas.restoreToCount(saved)
  }

  // A page outline whose top-right corner is cut back by fold, with the other
  // three corners rounded by corner.
  private fun buildPage(
    path: Path,
    l: Float,
    t: Float,
    r: Float,
    b: Float,
    fold: Float,
    corner: Float,
  ) {
    path.rewind()
    path.moveTo(l, t + corner)
    path.quadTo(l, t, l + corner, t)
    path.lineTo(r - fold, t)
    path.lineTo(r, t + fold)
    path.lineTo(r, b - corner)
    path.quadTo(r, b, r - corner, b)
    path.lineTo(l + corner, b)
    path.quadTo(l, b, l, b - corner)
    path.close()
  }

  // The two inner edges of the folded-over corner, at the page's top-right.
  private fun buildFold(
    path: Path,
    r: Float,
    t: Float,
    fold: Float,
  ) {
    path.rewind()
    path.moveTo(r - fold, t)
    path.lineTo(r - fold, t + fold)
    path.lineTo(r, t + fold)
  }
}
