package sh.paseo.wordstream

import android.content.Context
import android.view.View
import android.view.ViewTreeObserver
import android.widget.TextView
import android.view.ViewGroup
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Record
import expo.modules.kotlin.records.Field

class WordRange : Record {
  @Field var start: Int = 0
  @Field var end: Int = 0
  @Field var startedAt: Double = 0.0
  @Field var spanMs: Double = 0.0
}

class WordStreamModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PaseoWordStream")
    View(WordFadeHost::class) {
      Prop("ranges") { view: WordFadeHost, ranges: List<WordRange> -> view.ranges = ranges }
      OnViewDestroys { view: WordFadeHost -> view.reset() }
    }
  }
}

/** Fabric owns child layout and commits the text and ranges before pre-draw. */
class WordFadeHost @JvmOverloads constructor(
  context: Context,
  private val frameClock: WordFadeFrameClock = AndroidWordFadeFrameClock,
) : ViewGroup(context) {
  override fun onLayout(changed: Boolean, left: Int, top: Int, right: Int, bottom: Int) {}

  private var animator: TailFadeInAnimator? = null
  var ranges: List<WordRange> = emptyList()
    set(value) {
      field = value
      animator?.cancelAll()
      applyRanges()
      invalidate()
    }
  private val beforeDraw = ViewTreeObserver.OnPreDrawListener { applyRanges(); true }
  private var observer = viewTreeObserver

  init { observer.addOnPreDrawListener(beforeDraw) }

  override fun onViewAdded(child: View) {
    super.onViewAdded(child)
    require(child is TextView) { "WordFadeHost requires a single root TextView" }
    require(childCount == 1) { "WordFadeHost requires a single child" }
    animator = TailFadeInAnimator(child, frameClock)
    applyRanges()
  }

  override fun onViewRemoved(child: View) {
    animator?.cancelAll()
    animator = null
    super.onViewRemoved(child)
  }

  private fun applyRanges() { animator?.receive(ranges) }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    observer = viewTreeObserver
    observer.removeOnPreDrawListener(beforeDraw)
    observer.addOnPreDrawListener(beforeDraw)
    applyRanges()
  }

  override fun onDetachedFromWindow() {
    if (observer.isAlive) observer.removeOnPreDrawListener(beforeDraw)
    animator?.cancelAll()
    super.onDetachedFromWindow()
  }

  fun reset() {
    ranges = emptyList()
    animator?.cancelAll()
  }
}
