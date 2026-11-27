package com.swmansion.enriched.markdown.spans

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffColorFilter
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import android.os.Looper
import android.text.Spannable
import android.text.Spanned
import android.text.TextPaint
import android.text.TextUtils
import android.text.style.LeadingMarginSpan
import android.text.style.ReplacementSpan
import android.view.View
import android.widget.TextView
import com.swmansion.enriched.markdown.EnrichedMarkdownText
import com.swmansion.enriched.markdown.spoiler.isConcealedBySpoiler
import com.swmansion.enriched.markdown.styles.LinkPillContent
import com.swmansion.enriched.markdown.styles.LinkPillStyle
import com.swmansion.enriched.markdown.styles.LinkVariantEntry
import com.swmansion.enriched.markdown.utils.common.findEnrichedMarkdownAncestor
import java.lang.ref.WeakReference
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * Draws an atomic visual over the original link text, without changing stored characters.
 *
 * Presentation comes from the [variant]; [content] is what this particular link shows
 * and wins over the variant's label and icon, which win over the link text.
 */
class LinkPillSpan(
  private val variant: LinkVariantEntry,
  private val typeface: Typeface,
  private val fontSize: Float,
  originalLinkText: String,
  context: Context,
  content: LinkPillContent? = null,
  requestHeaders: Map<String, String> = emptyMap(),
  // False when the link style names a font family, which then wins over the run's font.
  private val followsRunTypeface: Boolean = false,
) : ReplacementSpan() {
  private val pill = variant.pill ?: LinkPillStyle()
  private val resolved = (content ?: LinkPillContent()).orElse(pill.content)
  private val label =
    resolved.label
      .ifEmpty { originalLinkText }
      .replace('\n', ' ')
      .replace('\r', ' ')

  /** Width limit given to a layout, and the box that layout reserved for the pill. */
  private class LayoutState {
    var availableWidth = Float.MAX_VALUE
    var reservedWidth = 0
  }

  // The view's text is also re-measured by Yoga off the main thread, at widths that may
  // never be committed. Each side keeps its own state so that pass cannot change what
  // the visible layout reserved and draws.
  private val uiState = LayoutState()
  private val backgroundState = LayoutState()
  private val state: LayoutState
    get() = if (Looper.myLooper() == Looper.getMainLooper()) uiState else backgroundState

  // Indentation of the enclosing blocks; -1 until resolved.
  @Volatile
  private var leadingMargin = -1

  @Volatile
  private var icon: Bitmap? = null

  // A remote icon keeps its slot while it loads, so its arrival needs a redraw, never a
  // relayout. A failed load gives the slot up, which reflows the text and re-measures.
  @Volatile
  private var reservesIconSlot: Boolean
  private val views = ArrayList<WeakReference<View>>()

  // A self-measuring host (a table cell) re-measures itself instead of the component.
  private var onSlotReleased: (() -> Unit)? = null

  private var ellipsizedLabel = label
  private var ellipsizedForWidth = -1f

  val accessibilityText = if (label == originalLinkText) originalLinkText else "$label, $originalLinkText"

  /** The minimum line height the pill asks of the block that holds it; 0 for none. */
  val lineHeight: Float = pill.lineHeight

  // A tint set for the link wins. The variant's tint is for the variant's own icon, not
  // for an icon supplied per link (an avatar would become a silhouette).
  private val iconTint: ColorFilter? =
    content?.iconTintColor?.let { PorterDuffColorFilter(it, PorterDuff.Mode.SRC_IN) }
      ?: pill.iconTint.takeIf { content?.iconUri.isNullOrEmpty() }

  init {
    val iconUri = resolved.iconUri
    if (LinkPillIconCache.isRemote(iconUri)) {
      // A source that failed a moment ago gets no slot and no request until it may be retried.
      reservesIconSlot = !LinkPillIconCache.hasFailedRecently(iconUri, requestHeaders)
      if (reservesIconSlot) {
        LinkPillIconCache
          .loadRemote(context, iconUri, requestHeaders) { loaded ->
            if (loaded == null) {
              releaseIconSlot()
            } else {
              icon = loaded
              invalidateViews()
            }
          }?.let { icon = it }
      }
    } else {
      icon = LinkPillIconCache.load(context, iconUri)
      reservesIconSlot = icon != null
    }
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) contentDescription = accessibilityText
  }

  /**
   * Records how much the enclosing blocks (lists, quotes) indent this pill's line. Done
   * once when the text is complete; looking it up on every layout would scan all spans.
   */
  fun resolveLeadingMargin(
    text: Spanned,
    start: Int,
    end: Int,
  ) {
    leadingMargin =
      text
        .getSpans(start, end, LeadingMarginSpan::class.java)
        .sumOf { max(it.getLeadingMargin(true), it.getLeadingMargin(false)) }
  }

  fun prepareForMeasurement(width: Int): Boolean {
    val next = width.coerceAtLeast(1).toFloat()
    val current = state
    if (current.availableWidth == next) return false
    current.availableWidth = next
    return true
  }

  // A link's text can hold several styled runs (bold next to regular, inline code), and
  // a layout measures and draws a replacement once per run. The pill belongs to the
  // first run; the others take no room and draw nothing.
  private fun startsPill(
    text: CharSequence,
    start: Int,
  ): Boolean {
    val spanStart = (text as? Spanned)?.getSpanStart(this) ?: -1
    return spanStart < 0 || start <= spanStart
  }

  /** Lets an icon that arrives after layout redraw [view], and a failed one reflow it. */
  fun registerView(
    view: View,
    onSlotReleased: (() -> Unit)? = null,
  ) {
    if (!reservesIconSlot || icon != null) return
    this.onSlotReleased = onSlotReleased
    synchronized(views) {
      views.removeAll { it.get() == null }
      if (views.none { it.get() === view }) views.add(WeakReference(view))
    }
  }

  private fun releaseIconSlot() {
    reservesIconSlot = false
    withHosts { hosts ->
      val host = hosts.filter { reflowIn(it) }.firstOrNull() ?: return@withHosts
      onSlotReleased?.let {
        it()
        return@withHosts
      }
      if (host is EnrichedMarkdownText) {
        host.layoutManager.invalidateLayout()
      } else {
        host.findEnrichedMarkdownAncestor()?.onImageLayoutChanged()
      }
    }
  }

  private fun invalidateViews() {
    withHosts { hosts -> hosts.forEach { reflowIn(it) } }
  }

  /** Hands the registered views, once, to [action] on the main thread. */
  private fun withHosts(action: (List<View>) -> Unit) {
    val hosts = synchronized(views) { views.mapNotNull { it.get() }.also { views.clear() } }
    if (hosts.isEmpty()) return
    if (Looper.myLooper() == Looper.getMainLooper()) action(hosts) else hosts.first().post { action(hosts) }
  }

  /**
   * A span change makes a TextView lay the pill out again and re-record the display list
   * a selectable one draws from, which invalidating alone does not. False when [view] no
   * longer shows this span.
   */
  private fun reflowIn(view: View): Boolean {
    val text = (view as? TextView)?.text as? Spannable
    val start = text?.getSpanStart(this) ?: -1
    if (text != null && start >= 0) {
      text.setSpan(this, start, text.getSpanEnd(this), text.getSpanFlags(this))
      return true
    }
    view.invalidate()
    return false
  }

  private fun TextPaint.applyLabelStyle(source: Paint): TextPaint {
    set(source)
    // The other spans on this run (strong, emphasis, inline code) have already styled the
    // paint. Use that font, as ordinary link text would; an explicit link font family keeps
    // its face and only takes the run's weight and slant.
    val base = this@LinkPillSpan.typeface
    val run = source.typeface
    typeface =
      if (followsRunTypeface && run != null) {
        run
      } else {
        val style = base.style or ((run?.style ?: Typeface.NORMAL) and Typeface.BOLD_ITALIC)
        if (style == base.style) base else Typeface.create(base, style)
      }
    textSize = fontSize
    color = variant.color
    bgColor = 0
    isUnderlineText = variant.underline
    isStrikeThruText = false
    return this
  }

  private fun width(paint: Paint): Float {
    val iconWidth = if (reservesIconSlot) fontSize * ICON_SLOT_RATIO else 0f
    val natural = paint.measureText(label) + iconWidth + 2 * (pill.paddingHorizontal + pill.borderWidth)
    val availableWidth = state.availableWidth
    val limit = if (pill.maxWidth > 0) min(availableWidth, pill.maxWidth) else availableWidth
    return min(ceil(natural), limit).coerceAtLeast(1f)
  }

  override fun getSize(
    paint: Paint,
    text: CharSequence,
    start: Int,
    end: Int,
    fm: Paint.FontMetricsInt?,
  ): Int {
    if (!startsPill(text, start)) return 0
    // Measurement can run off the main thread, so it keeps its own paint.
    val labelPaint = TextPaint().applyLabelStyle(paint)
    val metrics = labelPaint.fontMetricsInt
    val inset = ceil(pill.paddingVertical + pill.borderWidth).toInt()
    fm?.let {
      it.ascent = min(it.ascent, metrics.ascent - inset)
      it.descent = max(it.descent, metrics.descent + inset)
      it.top = min(it.top, it.ascent)
      it.bottom = max(it.bottom, it.descent)
    }
    return ceil(width(labelPaint)).toInt().also { state.reservedWidth = it }
  }

  override fun draw(
    canvas: Canvas,
    text: CharSequence,
    start: Int,
    end: Int,
    x: Float,
    top: Int,
    y: Int,
    bottom: Int,
    paint: Paint,
  ) {
    // The spoiler overlay only covers the text's glyph box, so a pill drawn under it
    // would outline the hidden link with its padding and border.
    if (text is Spanned && text.isConcealedBySpoiler(start, end)) return
    if (!startsPill(text, start)) return

    val labelPaint = drawLabelPaint.applyLabelStyle(paint)
    val metrics = drawMetrics.also { labelPaint.getFontMetrics(it) }
    val inset = pill.paddingVertical + pill.borderWidth
    val reservedWidth = uiState.reservedWidth
    val pillWidth = if (reservedWidth > 0) reservedWidth.toFloat() else width(labelPaint)
    rect.set(x, y + metrics.ascent - inset, x + pillWidth, y + metrics.descent + inset)
    shapePaint.style = Paint.Style.FILL
    shapePaint.color = variant.backgroundColor
    canvas.drawRoundRect(rect, pill.borderRadius, pill.borderRadius, shapePaint)
    if (pill.borderWidth > 0) {
      shapePaint.color = pill.borderColor
      shapePaint.style = Paint.Style.STROKE
      shapePaint.strokeWidth = pill.borderWidth
      innerRect.set(rect)
      innerRect.inset(pill.borderWidth / 2, pill.borderWidth / 2)
      canvas.drawRoundRect(innerRect, pill.borderRadius, pill.borderRadius, shapePaint)
    }
    val save = canvas.save()
    canvas.clipRect(rect)
    var left = x + pill.paddingHorizontal + pill.borderWidth
    val right = rect.right - pill.paddingHorizontal - pill.borderWidth
    if (reservesIconSlot && right - left >= fontSize) {
      icon?.let {
        val iconTop = y + (metrics.ascent + metrics.descent - fontSize) / 2
        val scale = fontSize / max(it.width, it.height)
        innerRect.set(left, iconTop, left + it.width * scale, iconTop + it.height * scale)
        innerRect.offset((fontSize - innerRect.width()) / 2, (fontSize - innerRect.height()) / 2)
        // The paint is shared by all pills, so the tint is set for every icon, tinted or not.
        iconPaint.colorFilter = iconTint
        canvas.drawBitmap(it, null, innerRect, iconPaint)
      }
      left += fontSize * ICON_SLOT_RATIO
    }
    canvas.drawText(displayedLabel(labelPaint, max(0f, right - left)), left, y.toFloat(), labelPaint)
    canvas.restoreToCount(save)
  }

  private fun displayedLabel(
    paint: TextPaint,
    width: Float,
  ): String {
    if (width != ellipsizedForWidth) {
      ellipsizedLabel = TextUtils.ellipsize(label, paint, width, TextUtils.TruncateAt.END).toString()
      ellipsizedForWidth = width
    }
    return ellipsizedLabel
  }

  companion object {
    // The icon occupies a square of the label's font size plus a quarter of it as a gap.
    private const val ICON_SLOT_RATIO = 1.25f

    // Drawing happens on the main thread only, so all pills share these scratch objects
    // instead of allocating native paints per pill.
    private val iconPaint = Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG)
    private val shapePaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val drawLabelPaint = TextPaint()
    private val drawMetrics = Paint.FontMetrics()
    private val rect = RectF()
    private val innerRect = RectF()

    /**
     * Gives every pill in [text] its width limit. Layout sites reach this through
     * `prepareWidthAwareSpans`; returns true when a limit changed.
     */
    fun prepareForMeasurement(
      text: CharSequence?,
      width: Int,
    ): Boolean {
      val spanned = text as? Spanned ?: return false
      var changed = false
      spanned.getSpans(0, spanned.length, LinkPillSpan::class.java).forEach { pill ->
        if (pill.leadingMargin < 0) {
          pill.resolveLeadingMargin(spanned, spanned.getSpanStart(pill), spanned.getSpanEnd(pill))
        }
        changed = pill.prepareForMeasurement(width - pill.leadingMargin) || changed
      }
      return changed
    }

    fun registerView(
      text: CharSequence?,
      view: View,
      onSlotReleased: (() -> Unit)? = null,
    ) {
      val spanned = text as? Spanned ?: return
      spanned.getSpans(0, spanned.length, LinkPillSpan::class.java).forEach { it.registerView(view, onSlotReleased) }
    }

    /** Redraws the pills in `[start, end)`, which skipped drawing while a spoiler concealed them. */
    fun redraw(
      view: TextView,
      start: Int,
      end: Int,
    ) {
      val spanned = view.text as? Spanned ?: return
      spanned.getSpans(start, end, LinkPillSpan::class.java).forEach { it.reflowIn(view) }
    }
  }
}
