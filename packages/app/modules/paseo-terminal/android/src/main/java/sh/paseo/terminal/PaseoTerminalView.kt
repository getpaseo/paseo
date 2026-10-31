package sh.paseo.terminal

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Rect
import android.os.Bundle
import android.view.MotionEvent
import android.widget.TextView
import androidx.core.view.ViewCompat
import androidx.core.view.accessibility.AccessibilityNodeInfoCompat
import androidx.customview.widget.ExploreByTouchHelper
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.viewevent.EventDispatcher
import expo.modules.kotlin.views.ExpoView

private const val MIN_CACHED_ROWS = 256
private const val CURSOR_ALPHA = 0.45f

/**
 * Paints terminal frames on the cell grid. Row shaping is cached by row content, so cursor and
 * selection changes repaint without reshaping, and unchanged rows replay their display lists.
 */
@SuppressLint("ViewConstructor")
class PaseoTerminalView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  private val onCellMetrics by EventDispatcher<Map<String, Float>>()

  private var fontFamily = "monospace"
  private var fontSize = 12.0
  private var font: TerminalFont? = null
  private var customGlyphs = TerminalCustomGlyphs.EMPTY
  private var frame: TerminalFrameRecord? = null
  private var frameChanged = false

  private var rows: List<TerminalRowLayout> = emptyList()
  private var columns = 0
  private var cursor: TerminalCursorRecord? = null
  private var selection: TerminalSelection? = null
  private var backgroundColor = Color.BLACK
  private var cursorColor = Color.WHITE
  private val paints = TerminalPaints()
  private val rowCache = object : LinkedHashMap<String, TerminalRowLayout>(64, 0.75f, true) {
    override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, TerminalRowLayout>): Boolean {
      if (size <= maxOf(MIN_CACHED_ROWS, rows.size * 2)) return false
      eldest.value.release()
      return true
    }
  }
  private val accessibility = RowAccessibility()

  init {
    setWillNotDraw(false)
    ViewCompat.setAccessibilityDelegate(this, accessibility)
  }

  fun setFrame(value: TerminalFrameRecord) {
    frame = value
    frameChanged = true
  }

  fun setTheme(value: TerminalThemeRecord) {
    backgroundColor = argb(value.background)
    cursorColor = argb(value.cursor)
    paints.selectionBackground = argb(value.selectionBackground)
    paints.selectionForeground = argb(value.selectionForeground)
    invalidate()
  }

  fun setFontFamily(value: String) {
    fontFamily = value
  }

  fun setFontSize(value: Double) {
    fontSize = value
  }

  fun setCustomGlyphs(value: List<TerminalCustomGlyphRecord>) {
    customGlyphs = TerminalCustomGlyphs(value)
    clearRowCache()
    frameChanged = true
  }

  /** Applies a batch of prop updates: font first, then the frame laid out with it. */
  fun commit() {
    val density = resources.displayMetrics.density
    val sizePx = (fontSize * density).toFloat()
    val current = font
    if (current == null || !current.sameAs(fontFamily, sizePx, density)) {
      val next = TerminalFont(fontFamily, sizePx, density)
      font = next
      clearRowCache()
      frameChanged = true
      onCellMetrics(
        mapOf(
          "cellWidth" to next.cellWidthPx / density,
          "cellHeight" to next.cellHeightPx / density,
        ),
      )
    }
    if (frameChanged) {
      frameChanged = false
      layoutFrame()
    }
    invalidate()
  }

  private fun layoutFrame() {
    val currentFont = font ?: return
    val record = frame ?: return
    columns = record.columns
    cursor = record.cursor
    selection = record.selection?.let(::TerminalSelection)
    rows = record.rows.map { encoded ->
      rowCache.getOrPut(encoded) {
        TerminalRowLayout(TerminalRowSource.decode(encoded), currentFont, customGlyphs)
      }
    }
    accessibility.invalidateRoot()
  }

  private fun clearRowCache() {
    for (layout in rowCache.values) layout.release()
    rowCache.clear()
    rows = emptyList()
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    canvas.drawColor(backgroundColor)
    val currentFont = font ?: return
    val cellWidth = currentFont.cellWidthPx
    val cellHeight = currentFont.cellHeightPx
    val gridWidth = columns * cellWidth
    canvas.save()
    canvas.clipRect(0, 0, minOf(width, gridWidth), height)
    val activeSelection = selection
    for ((index, row) in rows.withIndex()) {
      canvas.save()
      canvas.translate(0f, (index * cellHeight).toFloat())
      if (activeSelection != null && activeSelection.intersectsRow(index)) {
        row.drawSelected(canvas, index, activeSelection, paints)
      } else {
        row.draw(canvas, gridWidth, paints)
      }
      canvas.restore()
    }
    cursor?.let { position ->
      paints.fill.color = withAlpha(cursorColor, CURSOR_ALPHA)
      val left = (position.col * cellWidth).toFloat()
      val top = (position.row * cellHeight).toFloat()
      canvas.drawRect(left, top, left + cellWidth, top + cellHeight, paints.fill)
    }
    canvas.restore()
  }

  override fun dispatchHoverEvent(event: MotionEvent): Boolean =
    accessibility.dispatchHoverEvent(event) || super.dispatchHoverEvent(event)

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    for (layout in rowCache.values) layout.release()
  }

  private fun withAlpha(color: Int, alpha: Float): Int =
    Color.argb((Color.alpha(color) * alpha).toInt(), Color.red(color), Color.green(color), Color.blue(color))

  /** Exposes each non-blank row as a virtual text node, `terminal-row-<index>`. */
  private inner class RowAccessibility : ExploreByTouchHelper(this@PaseoTerminalView) {
    override fun getVirtualViewAt(x: Float, y: Float): Int {
      val cellHeight = font?.cellHeightPx ?: return INVALID_ID
      val row = (y / cellHeight).toInt()
      return if (row in rows.indices && rows[row].describe().isNotEmpty()) row else INVALID_ID
    }

    override fun getVisibleVirtualViews(virtualViewIds: MutableList<Int>) {
      for ((index, row) in rows.withIndex()) {
        if (row.describe().isNotEmpty()) virtualViewIds.add(index)
      }
    }

    @Suppress("DEPRECATION")
    override fun onPopulateNodeForVirtualView(virtualViewId: Int, node: AccessibilityNodeInfoCompat) {
      val cellHeight = font?.cellHeightPx ?: 1
      val label = rows.getOrNull(virtualViewId)?.describe().orEmpty()
      node.className = TextView::class.java.name
      node.text = label
      node.contentDescription = label
      node.viewIdResourceName = "terminal-row-$virtualViewId"
      val top = virtualViewId * cellHeight
      node.setBoundsInParent(Rect(0, top, minOf(width, columns * (font?.cellWidthPx ?: 1)), top + cellHeight))
    }

    override fun onPerformActionForVirtualView(virtualViewId: Int, action: Int, arguments: Bundle?): Boolean = false
  }
}
