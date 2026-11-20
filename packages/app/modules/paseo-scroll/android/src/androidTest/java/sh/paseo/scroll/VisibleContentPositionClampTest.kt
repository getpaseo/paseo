package sh.paseo.scroll

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.graphics.Canvas
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.facebook.react.uimanager.ReactStylesDiffMap
import com.facebook.react.uimanager.RootView
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.scroll.ReactScrollView
import com.facebook.react.views.scroll.ReactScrollViewManager
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.soloader.SoLoader
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * A Fabric mount that shrinks the content of a scroll view with `maintainVisibleContentPosition`
 * set. The mount runs through React Native's real position keeper, driven by the same
 * willMountItems/didMountItems calls Fabric makes, inside a real window so layout clamps and draws
 * happen as they do on a device.
 */
@RunWith(AndroidJUnit4::class)
class VisibleContentPositionClampTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private var activity: Activity? = null

  @After fun finish() {
    activity?.finish()
  }

  @Test fun shrinkAtTheEndLandsAtTheNewEnd() {
    val timeline = openTimeline(anchor = Anchor.END)

    timeline.shrinkInOneMount()

    assertEquals("Offset after the mount", NEW_END, timeline.scrollY())
    assertEquals("Offset in the first frame drawn after the mount", NEW_END, timeline.firstDrawnScrollY())
  }

  @Test fun shrinkBelowAnUnmovedAnchorIsClampedBeforeTheFrameDraws() {
    val timeline = openTimeline(anchor = Anchor.TOP_ROW)

    timeline.shrinkInOneMount()

    assertEquals("Offset in the first frame drawn after the mount", NEW_END, timeline.firstDrawnScrollY())
    assertEquals("Offset after the mount", NEW_END, timeline.scrollY())
  }

  @Test fun shrinkDuringATouchDragLeavesNoOffsetPastTheEnd() {
    val timeline = openTimeline(anchor = Anchor.TOP_ROW)

    timeline.beginDrag()
    assertTrue("The drag owns the viewport", timeline.scrollY() < CONTENT_HEIGHT - VIEWPORT)
    timeline.shrinkInOneMount()
    val drawn = timeline.firstDrawnScrollY()
    timeline.endDrag()
    val settled = timeline.settledScrollY()

    assertTrue("Offset $drawn drawn past the end $NEW_END", drawn <= NEW_END)
    assertTrue("Offset $settled settled past the end $NEW_END", settled <= NEW_END)
    timeline.awaitFrames(10)
    assertEquals("Offset kept moving after the drag ended", settled, timeline.scrollY())
  }

  @Test fun growthAtTheEndFollowsWithoutATouch() {
    val timeline = openTimeline(anchor = Anchor.END)

    timeline.growInOneMount()

    assertEquals("Offset after the mount", CONTENT_HEIGHT + GROWTH - VIEWPORT, timeline.scrollY())
  }

  // The drag begins before JS stops following and removes the pin, so a line mounting in the drag's
  // first frames must not scroll the rows the finger is on.
  @Test fun growthAtTheEndDuringATouchDragKeepsTheRowsUnderTheFinger() {
    val timeline = openTimeline(anchor = Anchor.END)

    timeline.beginDrag()
    val dragged = timeline.scrollY()
    assertTrue("The drag owns the viewport", dragged < CONTENT_HEIGHT - VIEWPORT)
    timeline.growInOneMount()

    assertEquals("Offset after the mount", dragged, timeline.scrollY())
    assertEquals("Offset in the first frame drawn after the mount", dragged, timeline.firstDrawnScrollY())
    timeline.endDrag()
  }

  private enum class Anchor {
    /** A zero-height view at the bottom of the content, first child: the end pin. */
    END,
    /** A row at the top of the content that reaches into the viewport and does not move. */
    TOP_ROW,
  }

  private inner class Timeline(
    val scroll: ReactScrollView,
    private val content: ReactViewGroup,
    private val endPin: View,
    private val probe: DrawProbe,
    private val reactContext: MountingReactContext,
  ) {
    private var dragY = 0f
    private var downTime = 0L

    fun scrollY(): Int {
      var y = 0
      instrumentation.runOnMainSync { y = scroll.scrollY }
      return y
    }

    fun shrinkInOneMount() = resizeInOneMount(CONTENT_HEIGHT - SHRINK)

    fun growInOneMount() = resizeInOneMount(CONTENT_HEIGHT + GROWTH)

    private fun resizeInOneMount(height: Int) {
      instrumentation.runOnMainSync {
        probe.drawnScrollY.clear()
        reactContext.mount { layoutContent(height) }
        probe.invalidate()
      }
    }

    fun firstDrawnScrollY(): Int {
      val deadline = SystemClock.uptimeMillis() + 2000
      while (SystemClock.uptimeMillis() < deadline) {
        instrumentation.waitForIdleSync()
        var drawn: Int? = null
        instrumentation.runOnMainSync { drawn = probe.drawnScrollY.firstOrNull() }
        drawn?.let { return it }
        SystemClock.sleep(16)
      }
      throw AssertionError("No frame was drawn after the mount")
    }

    fun beginDrag() {
      downTime = SystemClock.uptimeMillis()
      dragY = 300f
      touch(MotionEvent.ACTION_DOWN)
      // Finger moves down, so the content scrolls up from the end and the drag owns the viewport.
      repeat(6) {
        dragY += 12f
        touch(MotionEvent.ACTION_MOVE)
      }
    }

    fun endDrag() {
      dragY += 4f
      touch(MotionEvent.ACTION_MOVE)
      touch(MotionEvent.ACTION_UP)
    }

    fun settledScrollY(): Int {
      var previous = scrollY()
      repeat(60) {
        awaitFrames(2)
        val current = scrollY()
        if (current == previous) return current
        previous = current
      }
      throw AssertionError("Offset never settled")
    }

    fun awaitFrames(count: Int) {
      repeat(count) {
        instrumentation.waitForIdleSync()
        SystemClock.sleep(16)
      }
    }

    fun layoutContent(height: Int) {
      content.layout(0, 0, WIDTH, height)
      endPin.layout(0, height, 0, height)
    }

    private fun touch(action: Int) {
      instrumentation.runOnMainSync {
        val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, WIDTH / 2f, dragY, 0)
        scroll.dispatchTouchEvent(event)
        event.recycle()
      }
    }
  }

  /** The React surface root a scroll view reports its native gestures to. */
  private class SurfaceRoot(context: Context) : FrameLayout(context), RootView {
    override fun onChildStartedNativeGesture(childView: View?, ev: MotionEvent) {}

    override fun onChildEndedNativeGesture(childView: View, ev: MotionEvent) {}

    override fun handleException(t: Throwable) {
      throw t
    }
  }

  private class DrawProbe(context: Context) : View(context) {
    val drawnScrollY = mutableListOf<Int>()

    override fun onDraw(canvas: Canvas) {
      drawnScrollY += (parent.parent as View).scrollY
    }
  }

  private fun openTimeline(anchor: Anchor): Timeline {
    val started =
      instrumentation.startActivitySync(
        Intent(instrumentation.targetContext, Activity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      )
    activity = started
    lateinit var timeline: Timeline
    instrumentation.runOnMainSync {
      DisplayMetricsHolder.initDisplayMetricsIfNotInitialized(started)
      SoLoader.init(started, OpenSourceMergedSoMapping)
      val reactContext = MountingReactContext(started.applicationContext)
      val context = ThemedReactContext(reactContext, started)
      val manager =
        PaseoScrollPackage().createViewManager(reactContext, ReactScrollViewManager.REACT_CLASS)
          as ReactScrollViewManager
      val scroll = manager.createViewInstance(context)
      val content = ReactViewGroup(context)
      val endPin = View(context).apply { setTag(com.facebook.react.R.id.view_tag_native_id, END_PIN_NATIVE_ID) }
      val probe = DrawProbe(context)
      if (anchor == Anchor.END) {
        content.addView(endPin)
        content.addView(probe)
      } else {
        content.addView(probe)
        content.addView(endPin)
      }
      scroll.addView(content)
      manager.updateProperties(
        scroll,
        ReactStylesDiffMap(
          JavaOnlyMap.of("maintainVisibleContentPosition", JavaOnlyMap.of("minIndexForVisible", 0))
        ),
      )
      started.setContentView(SurfaceRoot(started).apply { addView(scroll, FrameLayout.LayoutParams(WIDTH, VIEWPORT)) })
      timeline = Timeline(scroll, content, endPin, probe, reactContext)
      timeline.layoutContent(CONTENT_HEIGHT)
      probe.layout(0, 0, WIDTH, PROBE_HEIGHT)
    }
    timeline.awaitFrames(2)
    instrumentation.runOnMainSync { timeline.scroll.scrollTo(0, CONTENT_HEIGHT - VIEWPORT) }
    timeline.awaitFrames(2)
    assertEquals("Starts at the end", CONTENT_HEIGHT - VIEWPORT, timeline.scrollY())
    return timeline
  }

  private companion object {
    const val WIDTH = 300
    const val VIEWPORT = 600
    const val CONTENT_HEIGHT = 1000
    const val SHRINK = 240
    const val GROWTH = 120
    const val END_PIN_NATIVE_ID = "paseo-end-pin"
    const val NEW_END = CONTENT_HEIGHT - SHRINK - VIEWPORT
    const val PROBE_HEIGHT = 700
  }
}
