package sh.paseo.scroll

import android.app.Activity
import android.content.Intent
import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.JavaOnlyArray
import com.facebook.react.bridge.JavaOnlyMap
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.react.uimanager.DisplayMetricsHolder
import com.facebook.react.uimanager.ReactStylesDiffMap
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.views.scroll.ReactScrollView
import com.facebook.react.views.scroll.ReactScrollViewManager
import com.facebook.soloader.SoLoader
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

class NestedScrollActivity : Activity()

@RunWith(AndroidJUnit4::class)
class NestedScrollTest {
  @Test fun invertedTimelineDoesNotConsumePanelOvershoot() = withNestedScroll(inverted = true) { parent, child ->
    val before = parent.scrollY
    assertTrue(child.startNestedScroll(View.SCROLL_AXIS_VERTICAL))
    child.scrollTo(0, 600)
    assertEquals(600, child.scrollY)
    assertTrue(child.dispatchNestedScroll(0, 0, 0, 100, null))
    assertEquals("Panel overshoot must not move the inverted timeline", before, parent.scrollY)
    child.scrollTo(0, 0)
    assertTrue(child.dispatchNestedScroll(0, 0, 0, -100, null))
    assertEquals("Overshoot at either edge must stay inside the panel", before, parent.scrollY)
    child.stopNestedScroll()
  }

  @Test fun ordinaryParentStillConsumesPanelOvershoot() = withNestedScroll(inverted = false) { parent, child ->
    val before = parent.scrollY
    assertTrue(child.startNestedScroll(View.SCROLL_AXIS_VERTICAL))
    child.scrollTo(0, 600)
    assertEquals(600, child.scrollY)
    assertTrue(child.dispatchNestedScroll(0, 0, 0, 100, null))
    assertEquals(before + 100, parent.scrollY)
    child.stopNestedScroll()
  }

  @Test fun panelCanStillScrollInsideInvertedTimeline() = withNestedScroll(inverted = true) { parent, child ->
    val before = parent.scrollY
    assertTrue(child.startNestedScroll(View.SCROLL_AXIS_VERTICAL))
    child.scrollTo(0, 100)
    assertTrue(child.dispatchNestedScroll(0, 100, 0, 0, null))
    assertEquals(100, child.scrollY)
    assertEquals(before, parent.scrollY)
    child.stopNestedScroll()
    parent.scrollTo(0, before + 100)
    assertEquals(before + 100, parent.scrollY)
  }

  @Test fun invertedTimelineAbsorbsUnconsumedPanelFling() = checkFling(inverted = true)

  @Test fun ordinaryParentStillAcceptsUnconsumedPanelFling() = checkFling(inverted = false)

  private fun checkFling(inverted: Boolean) = withNestedScroll(
    inverted = inverted,
    afterFrames = { parent ->
      if (inverted) assertEquals("Panel fling must not move the inverted timeline", 400, parent.scrollY)
      else assertTrue("Control fling must move an ordinary parent", parent.scrollY > 400)
    }
  ) { parent, child ->
    parent.scrollTo(0, 400)
    assertTrue(child.startNestedScroll(View.SCROLL_AXIS_VERTICAL))
    child.scrollTo(0, 600)
    assertEquals(600, child.scrollY)
    assertTrue(child.dispatchNestedFling(0f, 1500f, false))
    child.stopNestedScroll()
  }

  private fun withNestedScroll(
    inverted: Boolean,
    afterFrames: ((ReactScrollView) -> Unit)? = null,
    check: (ReactScrollView, ReactScrollView) -> Unit
  ) {
    val instrumentation = InstrumentationRegistry.getInstrumentation()
    val activity = instrumentation.startActivitySync(
      Intent(instrumentation.context, NestedScrollActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    )
    lateinit var parent: ReactScrollView
    try {
      instrumentation.runOnMainSync {
        val appContext = instrumentation.targetContext
        DisplayMetricsHolder.initDisplayMetricsIfNotInitialized(appContext)
        SoLoader.init(appContext, OpenSourceMergedSoMapping)
        val reactContext = ScrollTestContext(appContext)
        val context = ThemedReactContext(reactContext, appContext)
        val manager = PaseoScrollPackage().createViewManager(reactContext, ReactScrollViewManager.REACT_CLASS) as ReactScrollViewManager
        parent = manager.createViewInstance(context)
        val child = manager.createViewInstance(context).apply { isNestedScrollingEnabled = true }
        val panelContent = View(context)
        child.addView(panelContent, FrameLayout.LayoutParams(300, 800))
        val content = FrameLayout(context)
        content.addView(child, FrameLayout.LayoutParams(300, 200).apply { topMargin = 500 })
        parent.addView(content, FrameLayout.LayoutParams(300, 2000))
        panelContent.measure(exact(300), exact(800))
        panelContent.layout(0, 0, 300, 800)
        child.measure(exact(300), exact(200))
        child.layout(0, 500, 300, 700)
        content.measure(exact(300), exact(2000))
        content.layout(0, 0, 300, 2000)
        parent.measure(exact(300), exact(400))
        parent.layout(0, 0, 300, 400)
        // The same transform React Native applies to an inverted FlatList on Android.
        manager.updateProperties(parent, ReactStylesDiffMap(JavaOnlyMap.of(
          "transform", JavaOnlyArray.of(JavaOnlyMap.of("scale", if (inverted) -1.0 else 1.0))
        )))
        activity.setContentView(parent, ViewGroup.LayoutParams(300, 400))
        parent.scrollTo(0, 400)
        check(parent, child)
      }
      if (afterFrames != null) {
        // Let the framework's real fling animation advance, with an ordinary-parent control.
        SystemClock.sleep(500)
        instrumentation.runOnMainSync { afterFrames(parent) }
      }
    } finally {
      instrumentation.runOnMainSync { activity.finish() }
    }
  }

  private fun exact(size: Int) = View.MeasureSpec.makeMeasureSpec(size, View.MeasureSpec.EXACTLY)
}
