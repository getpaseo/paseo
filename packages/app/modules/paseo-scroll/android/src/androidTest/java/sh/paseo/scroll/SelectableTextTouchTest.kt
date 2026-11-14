package sh.paseo.scroll

import android.app.Activity
import android.content.Intent
import android.os.SystemClock
import android.text.InputType
import android.view.MotionEvent
import android.view.View
import android.view.ViewConfiguration
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.scroll.ReactScrollView
import com.facebook.react.views.scroll.ReactScrollViewManager
import com.facebook.react.views.view.ReactViewGroup
import com.facebook.soloader.SoLoader
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Touches on chat text in the timeline's scroll view. Chat text is selectable, so a tap or a long
 * press focuses it, and the focus may not scroll the timeline. The touches are injected into a real
 * window, so touch mode, focus and the selection controller run as on device.
 */
@RunWith(AndroidJUnit4::class)
class SelectableTextTouchTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private var activity: Activity? = null

  @After fun finish() {
    activity?.finish()
  }

  // A reply whose top is on screen and whose bottom is below the viewport.
  @Test fun tappingTextThatRunsBelowTheViewportKeepsTheOffset() {
    val timeline = openTimeline(edge = Edge.TOP)

    timeline.tap(visibleY = EDGE_Y + 100)

    assertTrue("The tap focuses the text", timeline.textHasFocus())
    assertEquals("Offset after the tap", OFFSET, timeline.settledScrollY())
  }

  // A reply whose bottom is on screen and whose top is above the viewport, like a link at its end.
  @Test fun tappingTextThatStartsAboveTheViewportKeepsTheOffset() {
    val timeline = openTimeline(edge = Edge.BOTTOM)

    timeline.tap(visibleY = EDGE_Y - 100)

    assertTrue("The tap focuses the text", timeline.textHasFocus())
    assertEquals("Offset after the tap", OFFSET, timeline.settledScrollY())
  }

  @Test fun longPressSelectsAWordAndKeepsTheOffset() {
    val timeline = openTimeline(edge = Edge.TOP)

    timeline.longPress(visibleY = EDGE_Y + 100)

    assertTrue("The long press selects text", timeline.textHasSelection())
    assertEquals("Offset after the long press", OFFSET, timeline.settledScrollY())
  }

  // Inputs in the timeline, such as an agent's question form, still scroll into view to be typed in.
  @Test fun tappingAnInputThatRunsBelowTheViewportRevealsIt() {
    val timeline = openTimeline(edge = Edge.TOP, editable = true)

    timeline.tap(visibleY = EDGE_Y + 100)

    assertTrue("The tap focuses the input", timeline.textHasFocus())
    assertNotEquals("Offset after the tap", OFFSET, timeline.settledScrollY())
  }

  private inner class Timeline(private val scroll: ReactScrollView, private val text: TextView) {
    fun scrollTo(y: Int) {
      instrumentation.runOnMainSync { scroll.scrollTo(0, y) }
      awaitFrames(2)
    }

    fun tap(visibleY: Int) {
      val downTime = SystemClock.uptimeMillis()
      touch(downTime, MotionEvent.ACTION_DOWN, visibleY)
      touch(downTime, MotionEvent.ACTION_UP, visibleY)
    }

    fun longPress(visibleY: Int) {
      val downTime = SystemClock.uptimeMillis()
      touch(downTime, MotionEvent.ACTION_DOWN, visibleY)
      SystemClock.sleep(ViewConfiguration.getLongPressTimeout() * 2L)
      touch(downTime, MotionEvent.ACTION_UP, visibleY)
    }

    fun textHasFocus(): Boolean {
      awaitFrames(2)
      var focused = false
      instrumentation.runOnMainSync { focused = text.isFocused }
      return focused
    }

    fun textHasSelection(): Boolean {
      awaitFrames(2)
      var selected = false
      instrumentation.runOnMainSync { selected = text.hasSelection() }
      return selected
    }

    fun settledScrollY(): Int {
      var previous = scrollY()
      repeat(60) {
        awaitFrames(3)
        val current = scrollY()
        if (current == previous) return current
        previous = current
      }
      throw AssertionError("Offset never settled")
    }

    private fun scrollY(): Int {
      var y = 0
      instrumentation.runOnMainSync { y = scroll.scrollY }
      return y
    }

    // Injected through the window like a finger, which puts the window in touch mode.
    private fun touch(downTime: Long, action: Int, visibleY: Int) {
      val location = IntArray(2)
      instrumentation.runOnMainSync { scroll.getLocationOnScreen(location) }
      val x = location[0] + WIDTH / 2f
      val y = location[1] + visibleY.toFloat()
      val event = MotionEvent.obtain(downTime, SystemClock.uptimeMillis(), action, x, y, 0)
      instrumentation.sendPointerSync(event)
      event.recycle()
    }

    fun awaitFrames(count: Int) {
      repeat(count) {
        instrumentation.waitForIdleSync()
        SystemClock.sleep(16)
      }
    }
  }

  /** Which edge of the text is on screen, at [EDGE_Y]; the other is past the viewport. */
  private enum class Edge { TOP, BOTTOM }

  /** A timeline scrolled to [OFFSET] with one block of chat text taller than the viewport. */
  private fun openTimeline(edge: Edge, editable: Boolean = false): Timeline {
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
      val text =
        if (editable) {
          // No input connection: building one runs React Native's focus search through Fabric, which
          // this context does not run. The input is still a text editor, which is what the reveal
          // checks.
          object : EditText(context) {
            override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? = null
          }.apply { inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE }
        } else {
          // How enriched-markdown and React Native's <Text selectable> set up chat text.
          TextView(context).apply { setTextIsSelectable(true) }
        }
      text.setText(CHAT_TEXT)
      content.addView(text)
      scroll.addView(content)
      started.setContentView(
        FrameLayout(started).apply { addView(scroll, FrameLayout.LayoutParams(WIDTH, VIEWPORT)) }
      )
      // Fabric lays out React content; nothing in a React view group lays out its children itself.
      content.layout(0, 0, WIDTH, CONTENT_HEIGHT)
      text.measure(exact(WIDTH), View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED))
      assertTrue("The text is taller than the viewport", text.measuredHeight > VIEWPORT)
      val top = if (edge == Edge.TOP) OFFSET + EDGE_Y else OFFSET + EDGE_Y - text.measuredHeight
      text.layout(0, top, WIDTH, top + text.measuredHeight)
      timeline = Timeline(scroll, text)
    }
    timeline.awaitFrames(2)
    timeline.scrollTo(OFFSET)
    assertEquals("Starts at the offset", OFFSET, timeline.settledScrollY())
    return timeline
  }

  private fun exact(size: Int) = View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY)

  private companion object {
    const val WIDTH = 600
    const val VIEWPORT = 800
    const val CONTENT_HEIGHT = 4000
    const val OFFSET = 1200
    // Below the plain activity's action bar, which overlays the top of the window.
    const val EDGE_Y = 500
    val CHAT_TEXT = List(30) { "Line $it of a reply in the chat timeline." }.joinToString("\n")
  }
}
