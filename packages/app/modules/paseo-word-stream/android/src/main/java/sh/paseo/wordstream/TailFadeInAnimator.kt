package sh.paseo.wordstream

import android.animation.ValueAnimator
import android.icu.text.BreakIterator
import android.text.Spannable
import android.view.Choreographer
import android.widget.TextView
import java.lang.ref.WeakReference
import java.text.Bidi

/**
 * Adapted from Software Mansion's TailFadeInAnimator; see UPSTREAM.md.
 *
 * One clock per surface. A released word is a run of graphemes whose start
 * times are spread across the interval the word owns before the next word
 * follows; the next word starts where this one ends. All spans read the same
 * clock, so a frame paints one monotone front instead of a fade per word.
 */
internal class TailFadeInAnimator(
  textView: TextView,
  private val frameClock: WordFadeFrameClock,
) {
  private data class SpanRange(val span: FadeInSpan, val start: Int, val end: Int)
  private class ActiveFade(val spans: List<SpanRange>, val endsAt: Long)
  private val viewRef = WeakReference(textView)
  private val activeAnimations = mutableListOf<ActiveFade>()
  private val characters = BreakIterator.getCharacterInstance()
  private val clock = FadeClock()
  private var scheduled = false
  private val frame = Choreographer.FrameCallback { tick() }
  private var buffer: Spannable? = null
  private var ranges: List<WordRange>? = null
  private val isIdle: Boolean get() = activeAnimations.isEmpty()

  fun receive(next: List<WordRange>) {
    val text = viewRef.get()?.text as? Spannable ?: return
    if (buffer === text && ranges === next) return
    cancelAll()
    buffer = text
    ranges = next
    // RN may copy CharacterStyles while replacing its read-only buffer.
    text.getSpans(0, text.length, FadeInSpan::class.java).forEach { text.removeSpan(it) }
    if (!ValueAnimator.areAnimatorsEnabled()) return
    val now = frameClock.currentTimeMillis()
    clock.now = now
    for (range in next) {
      if (range.start < 0 || range.end > text.length || range.end <= range.start) continue
      if (now >= range.startedAt + range.spanMs + FadeInSpan.DURATION_MS) continue
      animateRange(text, range.start, range.end, range.startedAt, range.spanMs)
    }
    if (!isIdle) schedule()
  }

  private fun animateRange(text: Spannable, start: Int, end: Int, startedAt: Double, spanMs: Double) {
    // Grapheme boundaries keep emoji and combining marks together.
    val word = text.subSequence(start, end).toString()
    characters.setText(word)
    val ranges = mutableListOf<IntRange>()
    var from = characters.first()
    var to = characters.next()
    while (to != BreakIterator.DONE) {
      ranges.add(from until to)
      from = to
      to = characters.next()
    }
    // RN can invalidate Layout until TextView.onDraw. Alpha spans need only
    // native Unicode visual order, so they also work before that first draw.
    val bidi = Bidi(word, Bidi.DIRECTION_DEFAULT_LEFT_TO_RIGHT)
    val levels = ByteArray(ranges.size) { bidi.getLevelAt(ranges[it].first).toByte() }
    val visualOrder = Array<Any>(ranges.size) { ranges[it] }
    Bidi.reorderVisually(levels, 0, visualOrder, 0, visualOrder.size)
    val spans = visualOrder.mapIndexed { index, item ->
      val range = item as IntRange
      val startAt = (startedAt + spanMs * index / visualOrder.size).toLong()
      val span = FadeInSpan(clock, startAt)
      val spanStart = start + range.first
      val spanEnd = start + range.last + 1
      text.setSpan(span, spanStart, spanEnd, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
      SpanRange(span, spanStart, spanEnd)
    }
    activeAnimations.add(ActiveFade(spans, (startedAt + spanMs).toLong() + FadeInSpan.DURATION_MS))
  }

  private fun schedule() {
    if (scheduled) return
    scheduled = true
    frameClock.postFrameCallback(frame)
  }

  private fun tick() {
    scheduled = false
    if (activeAnimations.isEmpty()) return
    val view = viewRef.get()
    if (view == null) {
      cancelAll()
      return
    }
    paint(frameClock.currentTimeMillis())
    view.invalidate()
    if (activeAnimations.isNotEmpty()) schedule()
  }

  /** Advance the shared clock, keep spans bound to the current text, and drop settled runs. */
  private fun paint(now: Long) {
    clock.now = now
    val current = buffer ?: return
    for (fade in activeAnimations.toList()) {
      if (now >= fade.endsAt) cleanup(fade, current)
    }
  }

  private fun cleanup(fade: ActiveFade, current: Spannable?) {
    if (!activeAnimations.remove(fade)) return
    fade.spans.forEach { current?.removeSpan(it.span) }
  }

  fun cancelAll() {
    val current = buffer
    buffer = null
    ranges = null
    activeAnimations.toList().forEach { cleanup(it, current) }
    if (scheduled) {
      frameClock.removeFrameCallback(frame)
      scheduled = false
    }
  }

}
