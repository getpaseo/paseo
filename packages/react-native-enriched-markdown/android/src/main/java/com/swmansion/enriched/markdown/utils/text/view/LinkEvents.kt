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
 * Parent intercept is handled by [LinkLongPressMovementMethod], which
 * disallows it for the press and releases it when the press ends.
 */
fun TextView.cancelJSTouchForLinkTap(event: MotionEvent) {
  val currentMovementMethod = movementMethod
  if (currentMovementMethod is LinkLongPressMovementMethod && currentMovementMethod.isLinkTouchActive) {
    NativeGestureUtil.notifyNativeGestureStarted(this, event)
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
