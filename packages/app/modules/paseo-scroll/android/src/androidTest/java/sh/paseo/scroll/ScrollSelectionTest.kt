package sh.paseo.scroll

import android.graphics.Rect
import android.text.Selection
import android.text.Spannable
import android.view.View
import android.view.InputDevice
import android.view.MotionEvent
import android.os.SystemClock
import android.widget.FrameLayout
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.JavaOnlyArray
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ReactStylesDiffMap
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.facebook.react.views.scroll.ReactScrollView
import com.facebook.react.views.scroll.ReactScrollViewManager
import com.facebook.soloader.SoLoader
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScrollSelectionTest {
  @Test fun mouseWheelMovesInvertedViewportInVisualDirection() = withScroll(inverted = true) { scroll, _ ->
    val before = scroll.scrollY
    withWheel(1f) { event ->
      assertTrue(scroll.dispatchGenericMotionEvent(event))
      assertTrue("Wheel up must move toward older messages", scroll.scrollY > before)
      assertEquals("The caller's event must not change", 1f, event.getAxisValue(MotionEvent.AXIS_VSCROLL))
    }
    val afterUp = scroll.scrollY
    withWheel(-1f) { event ->
      assertTrue(scroll.dispatchGenericMotionEvent(event))
      assertTrue("Wheel down must move toward newer messages", scroll.scrollY < afterUp)
    }
  }

  @Test fun mouseWheelKeepsOrdinaryScrollDirection() = withScroll(inverted = false) { scroll, _ ->
    val before = scroll.scrollY
    withWheel(1f) { event ->
      assertTrue(scroll.dispatchGenericMotionEvent(event))
      assertTrue(scroll.scrollY < before)
    }
    val afterUp = scroll.scrollY
    withWheel(-1f) { event ->
      assertTrue(scroll.dispatchGenericMotionEvent(event))
      assertTrue(scroll.scrollY > afterUp)
    }
  }

  @Test fun mouseWheelRespectsDisabledScrolling() = withScroll(inverted = true) { scroll, _ ->
    scroll.setScrollEnabled(false)
    val before = scroll.scrollY
    withWheel(1f) { scroll.dispatchGenericMotionEvent(it) }
    assertEquals(before, scroll.scrollY)
  }

  @Test fun focusingSelectableTextKeepsInvertedViewportStill() = withScroll(inverted = true) { scroll, text ->
    val before = scroll.scrollY
    assertTrue(text.requestFocus())
    assertSame(text, scroll.findFocus())
    assertEquals("Text focus must not move the inverted viewport", before, scroll.scrollY)
    assertTrue(text.isTextSelectable)
  }

  @Test fun selectingTextKeepsInvertedViewportStill() = withScroll(inverted = true) { scroll, text ->
    val before = scroll.scrollY
    Selection.setSelection(text.text as Spannable, 0, 8)
    text.requestRectangleOnScreen(Rect(0, 0, 80, 40), true)
    assertEquals("Selection visibility requests must not move the inverted viewport", before, scroll.scrollY)
    assertEquals("Selectab", text.text.subSequence(text.selectionStart, text.selectionEnd).toString())
  }

  @Test fun explicitScrollCommandsStillMoveInvertedViewport() = withScroll(inverted = true) { scroll, _ ->
    scroll.scrollTo(0, 600)
    assertEquals(600, scroll.scrollY)
  }

  @Test fun ordinaryScrollViewsStillRevealSelectedText() = withScroll(inverted = false) { scroll, text ->
    val before = scroll.scrollY
    text.requestRectangleOnScreen(Rect(0, 0, 80, 40), true)
    assertNotEquals(before, scroll.scrollY)
  }

  private fun withScroll(inverted: Boolean, check: (ReactScrollView, TextView) -> Unit) {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.runOnMainSync {
      val appContext = instrumentation.targetContext
      DisplayMetricsHolder.initDisplayMetricsIfNotInitialized(appContext)
      SoLoader.init(appContext, OpenSourceMergedSoMapping)
      val reactContext = BridgeReactContext(appContext)
      val context = ThemedReactContext(reactContext, appContext)
      val manager = PaseoScrollPackage().createViewManager(reactContext, ReactScrollViewManager.REACT_CLASS) as ReactScrollViewManager
      val scroll = manager.createViewInstance(context)
      val content = FrameLayout(context)
      val text = TextView(context).apply {
        setText("Selectable timeline text", TextView.BufferType.SPANNABLE)
        setTextIsSelectable(true)
      }
      content.addView(text, FrameLayout.LayoutParams(300, 100).apply { topMargin = 1400 })
      scroll.addView(content)
      content.measure(exact(300), exact(2000))
      content.layout(0, 0, 300, 2000)
      scroll.measure(exact(300), exact(300))
      scroll.layout(0, 0, 300, 300)
      manager.updateProperties(scroll, ReactStylesDiffMap(JavaOnlyMap.of(
        "transform", JavaOnlyArray.of(JavaOnlyMap.of("scale", if (inverted) -1.0 else 1.0)),
      )))
      assertEquals("RN's Android inversion uses positive scaleY", 1f, scroll.scaleY)
      scroll.scrollTo(0, 400)
      check(scroll, text)
    }
  }

  private fun exact(size: Int) = View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY)

  private fun withWheel(axis: Float, check: (MotionEvent) -> Unit) {
    val time = SystemClock.uptimeMillis()
    val properties = MotionEvent.PointerProperties().apply {
      id = 0
      toolType = MotionEvent.TOOL_TYPE_MOUSE
    }
    val coordinates = MotionEvent.PointerCoords().apply {
      x = 150f
      y = 150f
      setAxisValue(MotionEvent.AXIS_VSCROLL, axis)
    }
    val event = MotionEvent.obtain(
      time, time, MotionEvent.ACTION_SCROLL, 1, arrayOf(properties), arrayOf(coordinates),
      0, 0, 1f, 1f, 0, 0, InputDevice.SOURCE_MOUSE, 0,
    )
    try {
      check(event)
    } finally {
      event.recycle()
    }
  }
}
