package sh.paseo.wordstream

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.text.Spannable
import android.text.SpannableString
import android.text.Editable
import android.text.style.BackgroundColorSpan
import android.view.View
import android.view.ViewGroup
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class WordFadeTest {
  @Test fun replacementUsesOnlyTheCurrentTransactionsRangesAndStartTimes() = onMain {
    val view = textView("old word")
    val surface = host(view)
    val now = System.currentTimeMillis().toDouble() + 1000
    surface.ranges = listOf(WordRange().apply { start = 0; end = 3; startedAt = now; spanMs = 60.0 })
    surface.viewTreeObserver.dispatchOnPreDraw()
    view.text = SpannableString("old word new")
    surface.ranges = listOf(WordRange().apply { start = 9; end = 12; startedAt = now + 200; spanMs = 60.0 })
    surface.viewTreeObserver.dispatchOnPreDraw()
    val text = view.text as Spannable
    assertEquals(listOf(9, 10, 11), spans(view).map { text.getSpanStart(it) })
    assertEquals(listOf(now.toLong() + 200, now.toLong() + 220, now.toLong() + 240), spans(view).map { it.startAt })
    surface.reset()
  }

  @Test fun observingGrowthPreservesTheReadOnlyNativeTextBuffer() = onMain {
    val view = textView("history ")
    view.setTextIsSelectable(true)
    assertFalse(view.text is Editable)
    val surface = host(view)
    view.text = SpannableString("history word ")
    assertFalse("animation must not switch RN text into an editable buffer", view.text is Editable)
    surface.reset()
  }

  @Test fun nativeFadesKeepEmojiAndCombiningMarksTogether() = onMain {
    val view = textView("")
    val surface = host(view)
    view.text = SpannableString("👨‍👩‍👧‍👦 cafe\u0301 ")
    receive(surface, view, 0)
    surface.viewTreeObserver.dispatchOnPreDraw()
    val text = view.text as Spannable
    val ranges = spans(view).map { text.subSequence(text.getSpanStart(it), text.getSpanEnd(it)).toString() }
    assertEquals(listOf("👨‍👩‍👧‍👦", "c", "a", "f", "e\u0301"), ranges)
    surface.reset()
  }

  @Test fun appendedWordsFadeWhenTextReplacementInvalidatesTheLayout() = onMain {
    val view = textView("history ")
    view.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    val surface = host(view)
    view.text = SpannableString("history final words ")
    receive(surface, view, 8)
    // RN can replace text without another measure when its bounds stay fixed.
    surface.viewTreeObserver.dispatchOnPreDraw()
    assertTrue("appended words must have fade spans before their first draw", spans(view).isNotEmpty())
    surface.reset()
  }

  @Test fun inlineCodeBackgroundNeverFlashesBrighterDuringFade() {
    lateinit var view: TextView
    lateinit var surface: WordFadeHost
    lateinit var before: Bitmap
    onMain {
      view = textView("MMMMMM")
      (view.text as Spannable).setSpan(BackgroundColorSpan(Color.DKGRAY), 0, 6, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
      before = bitmap(view)
      surface = host(view)
      receive(surface, view, 0)
      surface.viewTreeObserver.dispatchOnPreDraw()
    }
    Thread.sleep(70)
    onMain {
      val during = bitmap(view)
      surface.reset()
      for (y in 0 until before.height) for (x in 0 until before.width) {
        assertTrue("fade must not brighten inline-code background at $x,$y", Color.red(during.getPixel(x, y)) <= Color.red(before.getPixel(x, y)))
      }
    }
  }

  @Test fun aRemountNeverRestartsAnExpiredWord() = onMain {
    val view = textView("history next")
    val surface = host(view)
    val expired = WordRange().apply { start = 0; end = 7; startedAt = System.currentTimeMillis().toDouble() - 200; spanMs = 40.0 }
    val fresh = WordRange().apply { start = 8; end = 12; startedAt = System.currentTimeMillis().toDouble(); spanMs = 40.0 }
    surface.ranges = listOf(expired, fresh)
    surface.viewTreeObserver.dispatchOnPreDraw()
    val text = view.text as Spannable
    assertEquals(4, spans(view).size)
    for (span in spans(view)) assertTrue(text.getSpanStart(span) >= 8)
    surface.reset()
  }

  @Test fun aPropUpdatedBeforeChildTextAppliesBeforeDrawing() = onMain {
    val view = textView("history ")
    val surface = host(view)
    val range = WordRange().apply { start = 8; end = 13; startedAt = System.currentTimeMillis().toDouble(); spanMs = 40.0 }
    surface.ranges = listOf(range)
    surface.viewTreeObserver.dispatchOnPreDraw()
    assertEquals(0, spans(view).size)
    view.text = SpannableString("history final")
    surface.viewTreeObserver.dispatchOnPreDraw()
    assertEquals(5, spans(view).size)
    surface.reset()
  }

  @Test fun fadeMovesFromLeftToRightWithoutChangingTextLayout() = onMain {
    val view = textView("MMMMMM")
    val before = bitmap(view)
    val text = view.text as Spannable
    val layout = view.layout
    val clock = FadeClock()
    for (index in 0 until text.length) {
      val span = FadeInSpan(clock, index * 20L)
      text.setSpan(span, index, index + 1, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
    }
    clock.now = 0L
    assertEquals(0L, brightness(bitmap(view), 0, view.width))
    clock.now = 100L
    val middle = bitmap(view)
    val half = layout.getPrimaryHorizontal(text.length).toInt() / 2
    assertTrue("left half must be more visible", brightness(middle, 0, half) > brightness(middle, half, half * 2))
    clock.now = 1000L
    val after = bitmap(view)
    assertTrue("settled rendering must match baseline", before.sameAs(after))
    assertEquals("MMMMMM", view.text.toString())
    assertEquals(1, view.layout.lineCount)
  }

  @Test fun bindingPreservesHistoryAndOnlyAnimatesAppendedWords() = onMain {
    val view = textView("history ")
    val surface = host(view)
    surface.viewTreeObserver.dispatchOnPreDraw()
    assertEquals(0, spans(view).size)
    view.text = SpannableString("history one two ")
    receive(surface, view, 8)
    measure(view)
    surface.viewTreeObserver.dispatchOnPreDraw()
    assertEquals(6, spans(view).size)
    val text = view.text as Spannable
    for (span in spans(view)) assertTrue(text.getSpanStart(span) >= "history ".length)
    surface.reset()
    assertEquals(0, spans(view).size)
    assertEquals("history one two ", view.text.toString())
  }

  @Test fun consecutiveWordsFormOneFrontThatNeverRestartsAtAWordBoundary() = onMain {
    val view = textView("one two three")
    val surface = host(view)
    val now = System.currentTimeMillis().toDouble()
    surface.ranges = listOf(
      WordRange().apply { start = 0; end = 3; startedAt = now; spanMs = 60.0 },
      WordRange().apply { start = 4; end = 7; startedAt = now + 60; spanMs = 60.0 },
      WordRange().apply { start = 8; end = 13; startedAt = now + 120; spanMs = 60.0 },
    )
    surface.viewTreeObserver.dispatchOnPreDraw()
    val text = view.text as Spannable
    val ordered = spans(view).sortedBy { text.getSpanStart(it) }
    assertEquals(11, ordered.size)
    for (index in 1 until ordered.size) {
      assertTrue(
        "character ${index} must not start fading before character ${index - 1}",
        ordered[index].startAt >= ordered[index - 1].startAt,
      )
    }
    assertTrue("the front must keep moving inside a word", ordered[1].startAt > ordered[0].startAt)
    surface.reset()
  }

  @Test fun recyclingWithCopiedSpansLeavesOnlyTheNewRanges() = onMain {
    val view = textView("old word")
    val surface = host(view)
    receive(surface, view, 0)
    val copied = SpannableString(view.text)
    surface.reset()
    surface.removeView(view)
    view.text = copied
    surface.addView(view)
    val now = System.currentTimeMillis().toDouble() + 1000
    surface.ranges = listOf(WordRange().apply { start = 4; end = 8; startedAt = now; spanMs = 40.0 })
    surface.viewTreeObserver.dispatchOnPreDraw()
    val text = view.text as Spannable
    assertEquals(listOf(4, 5, 6, 7), spans(view).map { text.getSpanStart(it) })
    assertEquals(listOf(0L, 10L, 20L, 30L), spans(view).map { it.startAt - now.toLong() })
    surface.reset()
  }

  @Test fun rightToLeftGraphemesStartInNativeVisualOrder() = onMain {
    val view = textView("שלום")
    val surface = host(view)
    val now = System.currentTimeMillis().toDouble() + 1000
    surface.ranges = listOf(WordRange().apply { start = 0; end = 4; startedAt = now; spanMs = 80.0 })
    surface.viewTreeObserver.dispatchOnPreDraw()
    val text = view.text as Spannable
    val visual = spans(view).sortedBy { view.layout.getPrimaryHorizontal(text.getSpanStart(it)) }
    assertEquals(listOf(0L, 20L, 40L, 60L), visual.map { it.startAt - now.toLong() })
    surface.reset()
  }

  @Test fun settledHostRemovesSpansAndMatchesItsBaseline() {
    lateinit var view: TextView
    lateinit var surface: WordFadeHost
    lateinit var baseline: Bitmap
    onMain {
      view = textView("settled word")
      baseline = bitmap(view)
      surface = host(view)
      receive(surface, view, 0)
      assertEquals(11, spans(view).size)
    }
    Thread.sleep(350)
    onMain {
      assertEquals(0, spans(view).size)
      assertTrue(baseline.sameAs(bitmap(view)))
      surface.reset()
    }
  }

  private fun receive(surface: WordFadeHost, view: TextView, start: Int) {
    surface.ranges = Regex("\\S+").findAll(view.text, start).map { match ->
      WordRange().apply { this.start = match.range.first; end = match.range.last + 1; startedAt = System.currentTimeMillis().toDouble(); spanMs = 40.0 }
    }.toList()
  }

  private fun host(view: TextView) = WordFadeHost(view.context).apply { addView(view) }

  private fun onMain(block: () -> Unit) = InstrumentationRegistry.getInstrumentation().runOnMainSync(block)

  private fun textView(text: String): TextView {
    val context = InstrumentationRegistry.getInstrumentation().targetContext
    return TextView(context).apply {
      layoutParams = ViewGroup.LayoutParams(900, ViewGroup.LayoutParams.WRAP_CONTENT)
      textSize = 32f
      setTextColor(Color.WHITE)
      setBackgroundColor(Color.BLACK)
      setPadding(0, 0, 0, 0)
      setText(SpannableString(text), TextView.BufferType.SPANNABLE)
      measure(this)
    }
  }

  private fun measure(view: TextView) {
    view.measure(View.MeasureSpec.makeMeasureSpec(900, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(400, View.MeasureSpec.AT_MOST))
    view.layout(0, 0, view.measuredWidth, view.measuredHeight)
  }

  private fun bitmap(view: TextView): Bitmap = Bitmap.createBitmap(view.width, view.height, Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) }
  private fun spans(view: TextView): Array<FadeInSpan> = (view.text as Spannable).getSpans(0, view.text.length, FadeInSpan::class.java)
  private fun brightness(bitmap: Bitmap, from: Int, to: Int): Long {
    var total = 0L
    for (y in 0 until bitmap.height) for (x in from until minOf(to, bitmap.width)) total += Color.red(bitmap.getPixel(x, y))
    return total
  }
}
