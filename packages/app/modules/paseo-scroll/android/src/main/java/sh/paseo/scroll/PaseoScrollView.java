package sh.paseo.scroll;

import android.content.Context;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import androidx.annotation.Nullable;
import com.facebook.react.R;
import com.facebook.react.views.scroll.MaintainVisibleScrollPositionHelper;
import com.facebook.react.views.scroll.ReactScrollView;
import com.facebook.react.views.scroll.ReactScrollViewHelper;

/**
 * React Native's vertical scroll view with two corrections. Java, because the content-position
 * config type is internal to React Native's Kotlin module.
 */
final class PaseoScrollView extends ReactScrollView {
  // The chat timeline's end pin, packages/app/src/agent-stream/native-end-pin.tsx.
  private static final String END_PIN_NATIVE_ID = "paseo-end-pin";

  private final ViewTreeObserver.OnPreDrawListener clampBeforeDraw =
      () -> {
        clampToContentEnd();
        return true;
      };
  private @Nullable MaintainVisibleScrollPositionHelper.Config visibleContentPosition = null;
  private boolean isClampPending = false;
  private boolean isUserDragging = false;

  PaseoScrollView(Context context) {
    super(context);
  }

  @Override
  public void setMaintainVisibleContentPosition(
      @Nullable MaintainVisibleScrollPositionHelper.Config config) {
    super.setMaintainVisibleContentPosition(config);
    visibleContentPosition = config;
  }

  // While the timeline follows its end, its end pin anchors the content position, so every line that
  // mounts scrolls the content by its height. A drag owns the offset from the frame it begins, and
  // JS removes the pin only a round trip later. While the user drags, the correction for the pin is
  // skipped, so the line grows below the rows under the finger. iOS's PaseoScrollViewComponentView
  // does the same.
  // MaintainVisibleScrollPositionHelper is the only caller: it moves the offset by its anchor's move.
  @Override
  public void scrollToPreservingMomentum(int x, int y) {
    if (isUserDragging && isEndPinTheAnchor()) return;
    super.scrollToPreservingMomentum(x, y);
  }

  // The drag begins where React Native emits onScrollBeginDrag.
  @Override
  protected void handleInterceptedTouchEvent(MotionEvent ev) {
    super.handleInterceptedTouchEvent(ev);
    isUserDragging = true;
  }

  @Override
  public boolean onTouchEvent(MotionEvent ev) {
    boolean handled = super.onTouchEvent(ev);
    int action = ev.getActionMasked();
    if (action == MotionEvent.ACTION_UP || action == MotionEvent.ACTION_CANCEL) {
      isUserDragging = false;
    }
    return handled;
  }

  // The helper anchors on the first content child from minIndexForVisible that reaches into the
  // viewport. The pin is the first child and sits at the bottom of the content, so it always does.
  private boolean isEndPinTheAnchor() {
    if (visibleContentPosition == null || visibleContentPosition.getMinIndexForVisible() != 0) {
      return false;
    }
    View content = getChildAt(0);
    if (!(content instanceof ViewGroup) || ((ViewGroup) content).getChildCount() == 0) return false;
    Object nativeId = ((ViewGroup) content).getChildAt(0).getTag(R.id.view_tag_native_id);
    return END_PIN_NATIVE_ID.equals(nativeId);
  }

  // With maintainVisibleContentPosition set, a mount that shrinks the content past the offset would
  // apply the shrink twice:
  // 1. MaintainVisibleScrollPositionHelper.willMountItems records the anchor's frame.
  // 2. The mount lays out the shorter content, and ReactScrollView.onLayoutChange clamps the offset
  //    to the new end.
  // 3. MaintainVisibleScrollPositionHelper.didMountItems adds the anchor's move to the clamped
  //    offset, so the shrink moves the offset a second time (to the top, for a shrink at the end).
  // The clamp waits for the pre-draw pass instead, which runs after didMountItems and before the
  // frame draws: the anchor's move applies to the offset the content had before the mount, and the
  // clamp only catches what the anchor did not account for.
  // https://github.com/react/react-native/issues/58578 tracks it; remove this override once
  // https://github.com/react/react-native/pull/58695 ships in the React Native version we use.
  @Override
  public void onLayoutChange(
      View v,
      int left,
      int top,
      int right,
      int bottom,
      int oldLeft,
      int oldTop,
      int oldRight,
      int oldBottom) {
    if (visibleContentPosition == null) {
      super.onLayoutChange(v, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom);
      return;
    }
    if (!isClampPending) {
      isClampPending = true;
      getViewTreeObserver().addOnPreDrawListener(clampBeforeDraw);
    }
    ReactScrollViewHelper.emitLayoutChangeEvent(this);
  }

  @Override
  protected void onDetachedFromWindow() {
    cancelPendingClamp();
    isUserDragging = false;
    super.onDetachedFromWindow();
  }

  private void clampToContentEnd() {
    cancelPendingClamp();
    View content = getChildAt(0);
    if (content == null || content.getWidth() == 0 || content.getHeight() == 0 || !isShown()) {
      return;
    }
    int viewportHeight = getHeight() - getPaddingTop() - getPaddingBottom();
    int maxScrollY = Math.max(0, content.getHeight() - viewportHeight);
    if (getScrollY() > maxScrollY) {
      scrollTo(getScrollX(), maxScrollY);
    }
  }

  private void cancelPendingClamp() {
    if (!isClampPending) return;
    isClampPending = false;
    getViewTreeObserver().removeOnPreDrawListener(clampBeforeDraw);
  }
}
