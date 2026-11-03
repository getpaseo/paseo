package sh.paseo.scroll;

import android.content.Context;
import android.graphics.Matrix;
import android.graphics.Rect;
import android.view.View;
import android.view.ViewTreeObserver;
import androidx.annotation.Nullable;
import com.facebook.react.views.scroll.MaintainVisibleScrollPositionHelper;
import com.facebook.react.views.scroll.ReactScrollView;
import com.facebook.react.views.scroll.ReactScrollViewHelper;

/**
 * React Native's vertical scroll view with two corrections. Java, because the content-position
 * config type is internal to React Native's Kotlin module.
 */
final class PaseoScrollView extends ReactScrollView {
  private final float[] transformValues = new float[9];
  private final ViewTreeObserver.OnPreDrawListener clampBeforeDraw =
      () -> {
        clampToContentEnd();
        return true;
      };
  private boolean keepsVisibleContentPosition = false;
  private boolean isClampPending = false;

  PaseoScrollView(Context context) {
    super(context);
  }

  // Both RN focus handling and Android selection visibility requests use this calculation.
  // Its coordinates ignore inversion. Keep focus/selection bookkeeping, but leave timeline
  // movement to user gestures and explicit scroll commands.
  @Override
  protected int computeScrollDeltaToGetChildRectOnScreen(Rect rect) {
    // RN's Android scale: -1 becomes a 180-degree rotation with positive scaleY.
    getMatrix().getValues(transformValues);
    if (transformValues[Matrix.MSCALE_Y] < 0) return 0;
    return super.computeScrollDeltaToGetChildRectOnScreen(rect);
  }

  @Override
  public void setMaintainVisibleContentPosition(
      @Nullable MaintainVisibleScrollPositionHelper.Config config) {
    super.setMaintainVisibleContentPosition(config);
    keepsVisibleContentPosition = config != null;
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
    if (!keepsVisibleContentPosition) {
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
