package sh.paseo.scroll

import android.graphics.Rect
import android.text.Selection
import android.text.Spannable
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.scroll.ReactScrollView
import com.facebook.react.views.scroll.ReactScrollViewManager
import com.facebook.soloader.SoLoader
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class ScrollSelectionTest {
  @Test fun focusingSelectableTextKeepsInvertedViewportStill() =
    withScroll(Inversion.NegativeScale, ::focusStays)

  @Test fun focusingSelectableTextKeepsHalfTurnViewportStill() =
    withScroll(Inversion.HalfTurn, ::focusStays)

  @Test fun selectingTextKeepsInvertedViewportStill() =
    withScroll(Inversion.NegativeScale, ::selectionStays)

  @Test fun selectingTextKeepsHalfTurnViewportStill() =
    withScroll(Inversion.HalfTurn, ::selectionStays)

  @Test fun explicitScrollCommandsStillMoveInvertedViewport() = withScroll(Inversion.NegativeScale) { scroll, _ ->
    scroll.scrollTo(0, 600)
    assertEquals(600, scroll.scrollY)
  }

  private fun focusStays(scroll: ReactScrollView, text: TextView) {
    val before = scroll.scrollY
    assertTrue(text.requestFocus())
    assertSame(text, scroll.findFocus())
    assertEquals("Text focus must not move the inverted viewport", before, scroll.scrollY)
    assertTrue(text.isTextSelectable)
  }

  private fun selectionStays(scroll: ReactScrollView, text: TextView) {
    val before = scroll.scrollY
    Selection.setSelection(text.text as Spannable, 0, 8)
    text.requestRectangleOnScreen(Rect(0, 0, 80, 40), true)
    assertEquals("Selection visibility requests must not move the inverted viewport", before, scroll.scrollY)
    assertEquals("Selectab", text.text.subSequence(text.selectionStart, text.selectionEnd).toString())
  }

  @Test fun ordinaryScrollViewsStillRevealSelectedText() = withScroll(Inversion.None) { scroll, text ->
    val before = scroll.scrollY
    text.requestRectangleOnScreen(Rect(0, 0, 80, 40), true)
    assertNotEquals(before, scroll.scrollY)
  }

  private enum class Inversion { None, NegativeScale, HalfTurn }

  private fun withScroll(inversion: Inversion, check: (ReactScrollView, TextView) -> Unit) {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    instrumentation.runOnMainSync {
      val appContext = instrumentation.targetContext
      SoLoader.init(appContext, OpenSourceMergedSoMapping)
      val reactContext = BridgeReactContext(appContext)
      val context = ThemedReactContext(reactContext, appContext)
      val manager = PaseoScrollPackage().createViewManager(reactContext, ReactScrollViewManager.REACT_CLASS) as ReactScrollViewManager
      val scroll = manager.createViewInstance(context)
      // Android's production inverted list is `transform: [{scale: -1}]`, which React Native
      // applies as a 180° rotation and a positive scale. `scaleY: -1` is the other flip.
      when (inversion) {
        Inversion.None -> {
          scroll.scaleY = 1f
          scroll.rotation = 0f
        }
        Inversion.NegativeScale -> {
          scroll.scaleY = -1f
          scroll.rotation = 0f
        }
        Inversion.HalfTurn -> {
          scroll.scaleY = 1f
          scroll.rotation = 180f
        }
      }
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
      scroll.scrollTo(0, 400)
      check(scroll, text)
    }
  }

  private fun exact(size: Int) = View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY)
}
