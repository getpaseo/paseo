package sh.paseo.scroll

import android.app.Activity
import android.content.Intent
import android.os.SystemClock
import android.view.View
import android.widget.FrameLayout
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
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Forward-order parent, as used by the current Android timeline, and a nested panel at its edge. */
@RunWith(AndroidJUnit4::class)
class PanelEdgeTest {
  private val instrumentation = InstrumentationRegistry.getInstrumentation()
  private var activity: Activity? = null
  private lateinit var manager: ReactScrollViewManager

  @After fun finish() {
    instrumentation.runOnMainSync { activity?.finish() }
  }

  @Test fun panelBottomEdgeLeavesTimelineStill() {
    val (parent, child) = openPanel()
    instrumentation.runOnMainSync {
      child.scrollTo(0, 600)
      assertTrue(child.startNestedScroll(View.SCROLL_AXIS_VERTICAL))
      child.dispatchNestedScroll(0, 0, 0, 100, null)
      child.stopNestedScroll()
      assertEquals("Panel stays at its bottom", 600, child.scrollY)
      assertEquals("Panel overshoot must leave timeline still", 400, parent.scrollY)
    }
  }

  @Test fun panelTopEdgeLeavesTimelineStill() {
    val (parent, child) = openPanel()
    instrumentation.runOnMainSync {
      child.scrollTo(0, 0)
      assertTrue(child.startNestedScroll(View.SCROLL_AXIS_VERTICAL))
      child.dispatchNestedScroll(0, 0, 0, -100, null)
      child.stopNestedScroll()
      assertEquals("Panel stays at its top", 0, child.scrollY)
      assertEquals("Panel overshoot must leave timeline still", 400, parent.scrollY)
    }
  }

  @Test fun panelFlingLeavesTimelineStill() {
    val (parent, child) = openPanel()
    instrumentation.runOnMainSync {
      child.scrollTo(0, 600)
      assertTrue(child.startNestedScroll(View.SCROLL_AXIS_VERTICAL))
      child.dispatchNestedFling(0f, 1500f, false)
      child.stopNestedScroll()
    }
    SystemClock.sleep(500)
    instrumentation.runOnMainSync {
      assertEquals("Panel fling must leave timeline still", 400, parent.scrollY)
    }
  }

  @Test fun disablingChildNestedScrollPreventsHandoff() {
    val (parent, child) = openPanel()
    instrumentation.runOnMainSync {
      child.isNestedScrollingEnabled = false
      assertEquals(false, child.startNestedScroll(View.SCROLL_AXIS_VERTICAL))
      child.dispatchNestedScroll(0, 0, 0, 100, null)
      assertEquals(400, parent.scrollY)
    }
  }

  @Test fun ordinaryParentStillConsumesNestedOvershoot() {
    val (parent, child) = openPanel()
    instrumentation.runOnMainSync {
      manager.setNativeId(parent, "ordinary-scroll-parent")
      assertTrue(child.startNestedScroll(View.SCROLL_AXIS_VERTICAL))
      child.dispatchNestedScroll(0, 0, 0, 100, null)
      child.stopNestedScroll()
      assertEquals("Ordinary parent retains framework handoff", 500, parent.scrollY)
    }
  }

  @Test fun ordinaryParentStillConsumesUnconsumedFling() {
    val (parent, child) = openPanel()
    instrumentation.runOnMainSync {
      manager.setNativeId(parent, "ordinary-scroll-parent")
      child.scrollTo(0, 600)
      assertTrue(child.startNestedScroll(View.SCROLL_AXIS_VERTICAL))
      child.dispatchNestedFling(0f, 1500f, false)
      child.stopNestedScroll()
    }
    SystemClock.sleep(500)
    instrumentation.runOnMainSync { assertTrue(parent.scrollY > 400) }
  }

  @Test fun consumedPanelFlingDoesNotStartParentFling() {
    val (parent, child) = openPanel()
    instrumentation.runOnMainSync {
      assertTrue(child.startNestedScroll(View.SCROLL_AXIS_VERTICAL))
      assertEquals(false, child.dispatchNestedFling(0f, 1500f, true))
      child.stopNestedScroll()
      assertEquals(400, parent.scrollY)
    }
  }

  @Test fun panelInteriorScrollingLeavesTimelineStill() {
    val (parent, child) = openPanel()
    instrumentation.runOnMainSync {
      child.scrollTo(0, 100)
      assertEquals(100, child.scrollY)
      assertEquals(400, parent.scrollY)
      parent.scrollTo(0, 500)
      assertEquals("Direct timeline scrolling remains available", 500, parent.scrollY)
    }
  }

  private fun openPanel(): Pair<ReactScrollView, ReactScrollView> {
    val started = instrumentation.startActivitySync(
      Intent(instrumentation.targetContext, Activity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    )
    activity = started
    lateinit var parent: ReactScrollView
    lateinit var child: ReactScrollView
    instrumentation.runOnMainSync {
      DisplayMetricsHolder.initDisplayMetricsIfNotInitialized(started)
      SoLoader.init(started, OpenSourceMergedSoMapping)
      val react = ScrollTestContext(started.applicationContext)
      val context = ThemedReactContext(react, started)
      manager = PaseoScrollPackage().createViewManager(react, ReactScrollViewManager.REACT_CLASS) as ReactScrollViewManager
      parent = manager.createViewInstance(context)
      manager.setNativeId(parent, "agent-chat-scroll-native-virtualized")
      child = manager.createViewInstance(context)
      child.isNestedScrollingEnabled = true
      val content = ReactViewGroup(context)
      content.addView(child, FrameLayout.LayoutParams(300, 200).apply { topMargin = 400 })
      parent.addView(content)
      val childContent = ReactViewGroup(context)
      child.addView(childContent)
      started.setContentView(FrameLayout(started).apply { addView(parent, FrameLayout.LayoutParams(300, 400)) })
      parent.layout(0, 0, 300, 400)
      content.layout(0, 0, 300, 2000)
      child.layout(0, 400, 300, 600)
      childContent.layout(0, 0, 300, 800)
      parent.scrollTo(0, 400)
    }
    return Pair(parent, child)
  }
}
