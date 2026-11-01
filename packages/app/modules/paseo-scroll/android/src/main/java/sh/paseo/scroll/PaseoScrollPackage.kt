package sh.paseo.scroll

import android.graphics.Matrix
import android.graphics.Rect
import android.view.View
import com.facebook.react.ReactPackage
import com.facebook.react.ViewManagerOnDemandReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.ViewManager
import com.facebook.react.views.scroll.ReactScrollView
import com.facebook.react.views.scroll.ReactScrollViewManager

/** Keeps RN's scroll props, commands, events, and Fabric component unchanged. */
class PaseoScrollPackage : ReactPackage, ViewManagerOnDemandReactPackage {
  override fun createNativeModules(context: ReactApplicationContext): List<NativeModule> = emptyList()
  override fun createViewManagers(context: ReactApplicationContext): List<ViewManager<*, *>> =
    listOf(PaseoScrollViewManager())
  override fun getViewManagerNames(context: ReactApplicationContext): Collection<String> =
    listOf(ReactScrollViewManager.REACT_CLASS)
  override fun createViewManager(context: ReactApplicationContext, name: String): ViewManager<*, *>? =
    if (name == ReactScrollViewManager.REACT_CLASS) PaseoScrollViewManager() else null
}

private class PaseoScrollViewManager : ReactScrollViewManager() {
  override fun createViewInstance(context: ThemedReactContext): ReactScrollView =
    PaseoScrollView(context)
}

private class PaseoScrollView(context: ThemedReactContext) : ReactScrollView(context) {
  private val transformValues = FloatArray(9)

  private val isInverted: Boolean
    get() {
      // RN's Android scale: -1 becomes a 180-degree rotation with positive scaleY.
      matrix.getValues(transformValues)
      return transformValues[Matrix.MSCALE_Y] < 0
    }

  // Both RN focus handling and Android selection visibility requests use this calculation.
  // Its coordinates ignore inversion. Keep focus/selection bookkeeping, but leave timeline
  // movement to user gestures and explicit scroll commands.
  override fun computeScrollDeltaToGetChildRectOnScreen(rect: Rect): Int {
    if (isInverted) return 0
    return super.computeScrollDeltaToGetChildRectOnScreen(rect)
  }

  // A nested panel's remaining delta uses its own visual direction. Consuming it in
  // an inverted timeline moves the timeline the opposite way when the panel hits an edge.
  override fun onNestedScroll(target: View, dxConsumed: Int, dyConsumed: Int, dxUnconsumed: Int, dyUnconsumed: Int) {
    if (isInverted) return
    super.onNestedScroll(target, dxConsumed, dyConsumed, dxUnconsumed, dyUnconsumed)
  }

  override fun onNestedFling(target: View, velocityX: Float, velocityY: Float, consumed: Boolean): Boolean {
    if (isInverted && !consumed) return true
    return super.onNestedFling(target, velocityX, velocityY, consumed)
  }
}
