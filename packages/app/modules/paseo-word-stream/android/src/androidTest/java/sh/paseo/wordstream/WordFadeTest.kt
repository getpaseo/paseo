package sh.paseo.wordstream

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Typeface
import android.text.Editable
import android.text.Spannable
import android.text.SpannableString
import android.text.style.BackgroundColorSpan
import android.util.TypedValue
import android.view.Choreographer
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.ceil
import kotlin.math.floor

@RunWith(AndroidJUnit4::class)
class WordFadeTest {
  @Test fun replacementUsesOnlyTheCurrentTransactionsRangesAndStartTimes() = withSurface("old word") { s ->
    s.host.ranges = listOf(word(0, 3, 200))
    assertHidden(s.view, s.render(0), 0, 3)
    s.view.text = SpannableString("old word new")
    val baseline = bitmap(s.view)
    s.host.ranges = listOf(word(9, 12, 200))
    val beforeStart = s.render(200)
    assertRegionEquals(s.view, baseline, beforeStart, 0, 9)
    assertHidden(s.view, beforeStart, 9, 12)
    assertTrue(brightness(s.render(230), bounds(s.view, 9, 10)) > 0)
  }

  @Test fun observingGrowthPreservesTheReadOnlyNativeTextBuffer() = withSurface("history ") { s ->
    s.view.setTextIsSelectable(true)
    assertFalse(s.view.text is Editable)
    s.view.text = SpannableString("history word ")
    s.host.ranges = listOf(word(8, 12))
    s.render(70)
    assertFalse("animation must not switch RN text into an editable buffer", s.view.text is Editable)
  }

  @Test fun nativeFadesKeepEmojiAndCombiningMarksTogether() {
    withSurface("e\u0301e\u0301") { s ->
      val baseline = bitmap(s.view)
      s.host.ranges = listOf(word(0, 4, span = 120))
      val middle = s.render(60)
      val first = bounds(s.view, 0, 2)
      for (y in 0 until baseline.height) for (x in first) {
        val expected = Color.red(baseline.getPixel(x, y)) * 0.4
        assertEquals("base letter and accent must share opacity", expected, Color.red(middle.getPixel(x, y)).toDouble(), 3.0)
      }
      assertHidden(s.view, middle, 2, 4)
      assertTrue(baseline.sameAs(s.render(270)))
    }
    withSurface("👨‍👩‍👧‍👦 cafe\u0301") { s ->
      val baseline = bitmap(s.view)
      val width = s.view.layout.getLineWidth(0)
      s.host.ranges = listOf(word(0, s.view.text.length))
      s.render(70)
      assertEquals(width, s.view.layout.getLineWidth(0), 0f)
      assertTrue(baseline.sameAs(s.render(190)))
      assertEquals("👨‍👩‍👧‍👦 cafe\u0301", s.view.text.toString())
    }
  }

  @Test fun appendedWordsFadeWhenTextReplacementInvalidatesTheLayout() = withSurface("history ") { s ->
    s.view.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    s.view.text = SpannableString("history final words ")
    assertTrue("fixture must require a new layout", s.view.isLayoutRequested)
    s.host.ranges = listOf(word(8, 13), word(14, 19, 40))
    // Commit ranges while layout is invalid, then perform the normal view
    // traversal without resending either text or range props.
    s.host.viewTreeObserver.dispatchOnPreDraw()
    measure(s.view)
    val first = s.render(0)
    assertHidden(s.view, first, 8, 19)
    val settled = s.render(230)
    s.host.reset()
    assertRegionEquals(s.view, settled, first, 0, 8)
    assertTrue(bitmap(s.view).sameAs(settled))
  }

  @Test fun inlineCodeBackgroundNeverFlashesBrighterDuringFade() = withSurface("MMMMMM") { s ->
    (s.view.text as Spannable).setSpan(BackgroundColorSpan(Color.DKGRAY), 0, 6, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
    val before = bitmap(s.view)
    s.host.ranges = listOf(word(0, 6))
    val during = s.render(70)
    assertFalse("mid-fade text must differ from its settled baseline", before.sameAs(during))
    for (y in 0 until before.height) for (x in 0 until before.width) {
      assertTrue("fade must not brighten inline-code background at $x,$y", Color.red(during.getPixel(x, y)) <= Color.red(before.getPixel(x, y)))
    }
    assertTrue(before.sameAs(s.render(190)))
  }

  @Test fun aRemountNeverRestartsAnExpiredWord() = withSurface("history next") { s ->
    val baseline = bitmap(s.view)
    s.clock.advanceTo(200)
    s.host.ranges = listOf(word(0, 7), word(8, 12, 200))
    val frame = s.render(200)
    assertRegionEquals(s.view, baseline, frame, 0, 8)
    assertHidden(s.view, frame, 8, 12)
    s.host.reset()
    s.host.removeView(s.view)
    s.host.addView(s.view)
    s.host.ranges = listOf(word(0, 7), word(8, 12, 200))
    assertTrue("remount must resume the same frame", frame.sameAs(s.render(200)))
  }

  @Test fun aPropUpdatedBeforeChildTextAppliesBeforeDrawing() = withSurface("history ") { s ->
    val history = bitmap(s.view)
    s.host.ranges = listOf(word(8, 13))
    assertTrue(history.sameAs(s.render(0)))
    s.view.text = SpannableString("history final")
    val baseline = bitmap(s.view)
    val first = s.render(0)
    assertRegionEquals(s.view, baseline, first, 0, 8)
    assertHidden(s.view, first, 8, 13)
    assertTrue(baseline.sameAs(s.render(190)))
  }

  @Test fun fadeMovesFromLeftToRightWithoutChangingTextLayout() = withSurface("MMMMMM") { s ->
    val baseline = bitmap(s.view)
    val width = s.view.layout.getLineWidth(0)
    s.host.ranges = listOf(word(0, 6, span = 120))
    assertHidden(s.view, s.render(0), 0, 6)
    val middle = s.render(100)
    assertTrue("left half must be more visible", brightness(middle, bounds(s.view, 0, 3)) > brightness(middle, bounds(s.view, 3, 6)))
    assertTrue("settled rendering must match baseline", baseline.sameAs(s.render(270)))
    assertEquals("MMMMMM", s.view.text.toString())
    assertEquals(1, s.view.layout.lineCount)
    assertEquals(width, s.view.layout.getLineWidth(0), 0f)
  }

  @Test fun bindingPreservesHistoryAndOnlyAnimatesAppendedWords() = withSurface("history ") { s ->
    val history = bitmap(s.view)
    assertTrue(history.sameAs(s.render(0)))
    s.view.text = SpannableString("history one two ")
    measure(s.view)
    val baseline = bitmap(s.view)
    s.host.ranges = listOf(word(8, 11), word(12, 15, 40))
    val first = s.render(0)
    assertRegionEquals(s.view, baseline, first, 0, 8)
    assertHidden(s.view, first, 8, 15)
    s.host.reset()
    assertTrue(baseline.sameAs(s.render(0)))
    assertFalse("reset must release scheduled animation work", s.clock.hasPendingFrame)
  }

  @Test fun consecutiveWordsFormOneFrontThatNeverRestartsAtAWordBoundary() = withSurface("MM MMMMMMMM MMM") { s ->
    val baseline = bitmap(s.view)
    s.host.ranges = listOf(word(0, 2, 0, 60), word(3, 11, 60, 60), word(12, 15, 120, 60))
    val letters = s.view.text.indices.filter { s.view.text[it] != ' ' }
    for (time in 0L..330L step 10) {
      val frame = s.render(time)
      val opacity = letters.map { index ->
        val region = bounds(s.view, index, index + 1)
        brightness(frame, region).toDouble() / brightness(baseline, region)
      }
      for (index in 1 until opacity.size) {
        assertTrue("front reversed at character $index at ${time}ms", opacity[index - 1] + 0.01 >= opacity[index])
      }
    }
    assertTrue(baseline.sameAs(s.render(330)))
  }

  @Test fun recyclingWithCopiedTextLeavesOnlyTheNewRanges() = withSurface("old word") { s ->
    val baseline = bitmap(s.view)
    s.host.ranges = listOf(word(0, 8))
    s.render(0)
    val copied = SpannableString(s.view.text)
    s.host.reset()
    s.host.removeView(s.view)
    s.view.text = copied
    s.host.addView(s.view)
    s.host.ranges = listOf(word(4, 8))
    val first = s.render(0)
    assertRegionEquals(s.view, baseline, first, 0, 4)
    assertHidden(s.view, first, 4, 8)
    assertTrue(baseline.sameAs(s.render(190)))
  }

  @Test fun rightToLeftTextFadesFromTheNativeVisualLeft() = withSurface("שלום") { s ->
    val baseline = bitmap(s.view)
    s.host.ranges = listOf(word(0, 4, span = 80))
    val frame = s.render(30)
    val letters = s.view.text.indices.sortedBy { bounds(s.view, it, it + 1).first }
    val left = bounds(s.view, letters.first(), letters.first() + 1)
    val right = bounds(s.view, letters.last(), letters.last() + 1)
    assertTrue("leftmost letter must have started", brightness(frame, left) > 0)
    assertEquals("rightmost letter must still be hidden", 0L, brightness(frame, right))
    assertTrue(baseline.sameAs(s.render(230)))
  }

  @Test fun settledHostStopsRequestingFramesAndMatchesItsBaseline() = withSurface("settled word") { s ->
    val baseline = bitmap(s.view)
    s.host.ranges = listOf(word(0, 7), word(8, 12))
    s.render(189)
    assertTrue("unsettled run must still request frames", s.clock.hasPendingFrame)
    assertTrue(baseline.sameAs(s.render(190)))
    assertFalse("settled host must release scheduled animation work", s.clock.hasPendingFrame)
  }

  private fun word(start: Int, end: Int, at: Long = 0, span: Long = 40) = WordRange().apply {
    this.start = start; this.end = end; startedAt = at.toDouble(); spanMs = span.toDouble()
  }

  private class TestFrameClock : WordFadeFrameClock {
    private var now = 0L
    private val callbacks = mutableSetOf<Choreographer.FrameCallback>()
    val hasPendingFrame get() = callbacks.isNotEmpty()
    override fun currentTimeMillis() = now
    override fun postFrameCallback(callback: Choreographer.FrameCallback) { callbacks.add(callback) }
    override fun removeFrameCallback(callback: Choreographer.FrameCallback) { callbacks.remove(callback) }
    fun advanceTo(time: Long) {
      require(time >= now)
      now = time
      val frame = callbacks.toList()
      callbacks.clear()
      frame.forEach { it.doFrame(time * 1_000_000) }
    }
  }

  private class Surface(val view: TextView, val clock: TestFrameClock, val host: WordFadeHost) {
    fun render(time: Long): Bitmap {
      host.viewTreeObserver.dispatchOnPreDraw()
      clock.advanceTo(time)
      return bitmap(view)
    }
  }

  private fun withSurface(text: String, block: (Surface) -> Unit) =
    InstrumentationRegistry.getInstrumentation().runOnMainSync {
      val context = InstrumentationRegistry.getInstrumentation().targetContext
      val view = TextView(context).apply {
        layoutParams = ViewGroup.LayoutParams(900, ViewGroup.LayoutParams.WRAP_CONTENT)
        // Pixel units keep every fixture on one line at any density.
        setTextSize(TypedValue.COMPLEX_UNIT_PX, 48f)
        typeface = Typeface.MONOSPACE
        setTextColor(Color.WHITE)
        setBackgroundColor(Color.BLACK)
        setPadding(0, 0, 0, 0)
        setText(SpannableString(text), TextView.BufferType.SPANNABLE)
        measure(this)
      }
      val clock = TestFrameClock()
      val host = WordFadeHost(context, clock).apply { addView(view) }
      try { block(Surface(view, clock, host)) } finally { host.reset(); host.removeView(view) }
    }

  companion object {
    private fun measure(view: TextView) {
      view.measure(View.MeasureSpec.makeMeasureSpec(900, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(400, View.MeasureSpec.AT_MOST))
      view.layout(0, 0, view.measuredWidth, view.measuredHeight)
    }
    private fun bitmap(view: TextView): Bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) }
    private fun bounds(view: TextView, start: Int, end: Int): IntRange {
      require(view.layout.lineCount == 1) { "fixture text must fit on one line: ${view.text}" }
      val a = view.layout.getPrimaryHorizontal(start)
      val b = view.layout.getPrimaryHorizontal(end)
      return floor(minOf(a, b)).toInt().coerceAtLeast(0) until ceil(maxOf(a, b)).toInt().coerceAtMost(view.width)
    }
    private fun brightness(bitmap: Bitmap, region: IntRange): Long {
      var total = 0L
      for (y in 0 until bitmap.height) for (x in region) total += Color.red(bitmap.getPixel(x, y))
      return total
    }
    private fun assertHidden(view: TextView, bitmap: Bitmap, start: Int, end: Int) {
      assertEquals("new text must not flash before its start: text=${view.text} layout=${view.layout.text} region=${bounds(view, start, end)} columns=${(start until end).map { brightness(bitmap, bounds(view, it, it + 1)) }}", 0L, brightness(bitmap, bounds(view, start, end)))
    }
    private fun assertRegionEquals(view: TextView, expected: Bitmap, actual: Bitmap, start: Int, end: Int) {
      for (y in 0 until expected.height) for (x in bounds(view, start, end)) {
        assertEquals("settled text changed at $x,$y", expected.getPixel(x, y), actual.getPixel(x, y))
      }
    }
  }
}
