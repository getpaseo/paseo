package sh.paseo.scroll

import android.graphics.Rect
import android.graphics.Matrix
import android.view.InputDevice
import android.view.MotionEvent
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

  private fun isVerticallyInverted(): Boolean {
    // Android FlatList uses scale: -1, which RN decomposes into a 180-degree
    // rotation with positive scaleY. Read the resulting transform, not scaleY.
    matrix.getValues(transformValues)
    return transformValues[Matrix.MSCALE_Y] < 0
  }

  override fun onGenericMotionEvent(event: MotionEvent): Boolean {
    if (!isVerticallyInverted() || event.actionMasked != MotionEvent.ACTION_SCROLL ||
        !event.isFromSource(InputDevice.SOURCE_CLASS_POINTER)) {
      return super.onGenericMotionEvent(event)
    }
    if (!scrollEnabled) return false

    // Android applies wheel axes directly to scrollY; the inversion transform only
    // transforms pointer coordinates. Reverse the vertical axis before delegating so
    // platform scroll bounds and scroll events still apply.
    val properties = Array(event.pointerCount) { index ->
      MotionEvent.PointerProperties().also { event.getPointerProperties(index, it) }
    }
    val coordinates = Array(event.pointerCount) { index ->
      MotionEvent.PointerCoords().also {
        event.getPointerCoords(index, it)
        it.setAxisValue(MotionEvent.AXIS_VSCROLL, -it.getAxisValue(MotionEvent.AXIS_VSCROLL))
      }
    }
    val correctedEvent = MotionEvent.obtain(
      event.downTime, event.eventTime, event.action, event.pointerCount, properties, coordinates,
      event.metaState, event.buttonState, event.xPrecision, event.yPrecision,
      event.deviceId, event.edgeFlags, event.source, event.flags,
    )
    return try {
      super.onGenericMotionEvent(correctedEvent)
    } finally {
      correctedEvent.recycle()
    }
  }

  // Both RN focus handling and Android selection visibility requests use this calculation.
  // Its coordinates ignore inversion. Keep focus/selection bookkeeping, but leave timeline
  // movement to user gestures and explicit scroll commands.
  override fun computeScrollDeltaToGetChildRectOnScreen(rect: Rect): Int =
    if (isVerticallyInverted()) 0 else super.computeScrollDeltaToGetChildRectOnScreen(rect)
}
