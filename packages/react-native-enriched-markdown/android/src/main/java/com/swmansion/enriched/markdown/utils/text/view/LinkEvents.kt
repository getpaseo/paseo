package com.swmansion.enriched.markdown.utils.text.view

import android.view.MotionEvent
import android.view.View
import android.widget.TextView
import com.facebook.react.bridge.ReactContext
import com.facebook.react.uimanager.UIManagerHelper
import com.facebook.react.uimanager.events.NativeGestureUtil
import com.swmansion.enriched.markdown.events.ImagePressEvent
import com.swmansion.enriched.markdown.events.LinkLongPressEvent
import com.swmansion.enriched.markdown.events.LinkPressEvent

fun View.emitLinkPressEvent(url: String, sourceType: String) {
  val reactContext = context as? ReactContext ?: return
  val surfaceId = UIManagerHelper.getSurfaceId(reactContext)
  val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(reactContext, id)
  dispatcher?.dispatchEvent(LinkPressEvent(surfaceId, id, url, sourceType))
}

fun View.emitImagePressEvent(
  url: String,
  altText: String,
) {
  val reactContext = context as? ReactContext ?: return
  val surfaceId = UIManagerHelper.getSurfaceId(reactContext)
  val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(reactContext, id)
  dispatcher?.dispatchEvent(ImagePressEvent(surfaceId, id, url, altText))
}

fun View.emitLinkLongPressEvent(url: String) {
  val reactContext = context as? ReactContext ?: return
  val surfaceId = UIManagerHelper.getSurfaceId(reactContext)
  val dispatcher = UIManagerHelper.getEventDispatcherForReactTag(reactContext, id)
  dispatcher?.dispatchEvent(LinkLongPressEvent(surfaceId, id, url))
}

/**
 * Cancels the JS touch for an active link tap, preventing parent
 * Pressable/TouchableOpacity from firing onPress for the same tap.
 *
 * Also requests that parent ViewGroups do not intercept subsequent touch
 * events in this gesture. This is necessary for react-native-gesture-handler's
 * Pressable, which intercepts at the native ViewGroup level and would otherwise
 * steal the gesture before ACTION_UP reaches the TextView.
 */
fun TextView.cancelJSTouchForLinkTap(event: MotionEvent) {
  val currentMovementMethod = movementMethod
  if (currentMovementMethod is LinkLongPressMovementMethod && currentMovementMethod.isLinkTouchActive) {
    parent?.requestDisallowInterceptTouchEvent(true)
    NativeGestureUtil.notifyNativeGestureStarted(this, event)
  }
}

/**
 * Re-allows parent ViewGroups to intercept touch events once the link
 * touch is no longer active (slop exceeded, gesture ended, or cancelled).
 * This restores normal scrolling behavior for parent ScrollView/RecyclerView.
 *
 * Must be called after [LinkLongPressMovementMethod.onTouchEvent] has
 * processed the event, since that is where [isLinkTouchActive] is updated.
 */
fun TextView.reallowParentInterceptIfLinkReleased() {
  val currentMovementMethod = movementMethod
  if (currentMovementMethod is LinkLongPressMovementMethod && !currentMovementMethod.isLinkTouchActive) {
    parent?.requestDisallowInterceptTouchEvent(false)
  }
}

/**
 * Cancels the JS touch unconditionally, preventing parent
 * Pressable/TouchableOpacity from firing onPress for the same gesture.
 */
fun View.cancelJSTouchForCheckboxTap(event: MotionEvent) {
  parent?.requestDisallowInterceptTouchEvent(true)
  NativeGestureUtil.notifyNativeGestureStarted(this, event)
}
