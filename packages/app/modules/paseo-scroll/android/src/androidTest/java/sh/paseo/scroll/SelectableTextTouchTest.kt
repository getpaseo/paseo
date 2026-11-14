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

  // A reply that is still streaming gets new text while the user's tap holds its focus.
  @Test fun aStreamingUpdateToTappedTextKeepsTheOffset() {
    val timeline = openTimeline(edge = Edge.BOTTOM)
    timeline.tap(visibleY = EDGE_Y - 100)
    assertTrue("The tap focuses the text", timeline.textHasFocus())

    timeline.updateText("$CHAT_TEXT\nOne more line of the reply.")

    assertEquals("Offset after the update", OFFSET, timeline.settledScrollY())
  }

  // The timeline changes height while tapped text holds focus, as when the composer above the
  // keyboard loses its queued message.
  @Test fun aTimelineResizeAfterATapKeepsTheOffset() {
    val timeline = openTimeline(edge = Edge.TOP)
    timeline.tap(visibleY = EDGE_Y + 100)
    assertTrue("The tap focuses the text", timeline.textHasFocus())

    timeline.resize(height = VIEWPORT + 200)

    assertEquals("Offset after the resize", OFFSET, timeline.settledScrollY())
  }

  @Test fun longPressSelectsAWordAndKeepsTheOffset() {
    val timeline = openTimeline(edge = Edge.TOP)

    val word = timeline.wordAt(visibleY = EDGE_Y + 100)

    timeline.longPress(visibleY = EDGE_Y + 100)

    assertEquals("Selected text", word, timeline.selectedText())
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

    fun resize(height: Int) {
      instrumentation.runOnMainSync {
        scroll.layoutParams = scroll.layoutParams.apply { this.height = height }
      }
    }

    // Replaces the text and lays it out again at its top, the way a streaming reply mounts.
    fun updateText(value: String) {
      instrumentation.runOnMainSync {
        text.setText(value)
        text.measure(exact(WIDTH), unspecified())
        text.layout(0, text.top, WIDTH, text.top + text.measuredHeight)
      }
    }

    fun textHasFocus(): Boolean {
      awaitFrames(2)
      var focused = false
      instrumentation.runOnMainSync { focused = text.isFocused }
      return focused
    }

    fun selectedText(): String {
      awaitFrames(2)
      var selected = ""
      instrumentation.runOnMainSync {
        selected = text.text.substring(text.selectionStart, text.selectionEnd)
      }
      return selected
    }

    /** The word under [visibleY] at the current offset. */
    fun wordAt(visibleY: Int): String {
      var word = ""
      instrumentation.runOnMainSync {
        val chars = text.text
        val y = scroll.scrollY + visibleY - text.top
        val offset = text.getOffsetForPosition(TOUCH_X - text.left, y.toFloat())
        var start = offset
        var end = offset
        while (start > 0 && chars[start - 1].isLetterOrDigit()) start--
        while (end < chars.length && chars[end].isLetterOrDigit()) end++
        word = chars.substring(start, end)
      }
      assertTrue("The touch lands on a word", word.isNotEmpty())
      return word
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
      val x = location[0] + TOUCH_X
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
          // Selectable, as React Native's TextInput makes itself when attached, so only being a text
          // editor tells it apart from chat text. No input connection: building one runs React
          // Native's focus search through Fabric, which this context does not run.
          object : EditText(context) {
            override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? = null
          }.apply {
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            setTextIsSelectable(true)
          }
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
      text.measure(exact(WIDTH), unspecified())
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

  private fun unspecified() = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)

  private companion object {
    const val WIDTH = 600
    const val TOUCH_X = WIDTH / 2f
    const val VIEWPORT = 800
    const val CONTENT_HEIGHT = 6000
    const val OFFSET = 2400
    // Below the plain activity's action bar, which overlays the top of the window.
    const val EDGE_Y = 500
    val CHAT_TEXT = List(30) { "Line $it of a reply in the chat timeline." }.joinToString("\n")
  }
}
