package sh.paseo.trace

import android.graphics.Rect
import android.os.Build
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.Window
import android.view.WindowInsets
import com.facebook.react.R
import com.facebook.react.bridge.ReactContext
import com.facebook.react.bridge.UiThreadUtil
import com.facebook.react.interfaces.ExtraWindowEventListener
import com.facebook.react.uimanager.ReactPointerEventsView
import com.facebook.react.uimanager.TouchTargetHelper
import com.facebook.react.uimanager.RootView

/** Temporary touch evidence. Only attached while the diagnostic recorder is running. */
internal class TouchDiagnostics(
  private val context: ReactContext,
  private val write: (String, Map<String, String>) -> Unit,
) : ExtraWindowEventListener {
  private val windows = mutableMapOf<Window, TouchCallback>()
  private var nextWindow = 0
  private var activityWindow: Window? = null

  fun start(window: Window?) {
    UiThreadUtil.assertOnUiThread()
    context.addExtraWindowEventListener(this)
    activity(window)
  }

  fun activity(window: Window?) {
    if (activityWindow === window) return
    activityWindow?.let { release(it) }
    activityWindow = window
    window?.let { observe(it) }
  }

  override fun onExtraWindowCreate(window: Window) = observe(window)
  override fun onExtraWindowDestroy(window: Window) = release(window)

  private fun observe(window: Window) {
    if (windows.containsKey(window)) return
    val callback = TouchCallback(window, window.callback, ++nextWindow, write)
    windows[window] = callback
    window.callback = callback
    write("touch.window.open", mapOf("window" to "$nextWindow"))
  }

  private fun release(window: Window) {
    val callback = windows.remove(window) ?: return
    // Another observer may wrap ours. Disable it even when we cannot unwrap its owner.
    callback.active = false
    if (window.callback === callback) window.callback = callback.previous
    write("touch.window.close", mapOf("window" to "${callback.id}"))
  }

  fun close() {
    context.removeExtraWindowEventListener(this)
    windows.keys.toList().forEach { release(it) }
    activityWindow = null
  }
}

private class TouchCallback(
  private val window: Window,
  val previous: Window.Callback,
  val id: Int,
  private val write: (String, Map<String, String>) -> Unit,
) : Window.Callback by previous {
  var active = true
  override fun dispatchTouchEvent(event: MotionEvent): Boolean {
    val boundary = event.actionMasked == MotionEvent.ACTION_DOWN ||
      event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL
    if (!active || !boundary) return previous.dispatchTouchEvent(event)
    val fields = mutableMapOf(
      "window" to "$id", "gesture" to "${event.downTime}",
      "action" to "${event.actionMasked}", "eventMs" to "${event.eventTime}",
      "x" to "${event.x}", "y" to "${event.y}",
      "imeVisible" to if (Build.VERSION.SDK_INT >= 30) "${window.decorView.rootWindowInsets?.isVisible(WindowInsets.Type.ime())}" else "unsupported",
      "imeBottom" to if (Build.VERSION.SDK_INT >= 30) "${window.decorView.rootWindowInsets?.getInsets(WindowInsets.Type.ime())?.bottom}" else "unsupported",
      "focus" to describe(window.currentFocus),
    )
    // This is a hit-test prediction, not proof that the eventual responder accepted the press.
    // Use RN's own pointer-events and transformed-coordinate rules, rather than approximating them.
    val root = reactRootAt(window.decorView, event.x.toInt(), event.y.toInt())
    if (root != null) {
      try {
        val origin = IntArray(2)
        root.getLocationOnScreen(origin)
        val path = TouchTargetHelper.findTargetPathAndCoordinatesForTouch(event.rawX - origin[0], event.rawY - origin[1], root, FloatArray(2))
        path.take(10).forEachIndexed { index, target ->
          fields["hit$index"] = "${target.getViewId()}:${describe(target.getView())}"
        }
      } catch (error: RuntimeException) {
        fields["hitError"] = error.javaClass.simpleName
      }
    }
    write("touch.window.before", fields)
    val handled = previous.dispatchTouchEvent(event)
    write("touch.window.after", mapOf(
      "window" to "$id", "gesture" to "${event.downTime}",
      "action" to "${event.actionMasked}", "handled" to "$handled",
      "focus" to describe(window.currentFocus),
    ))
    return handled
  }
}

private fun describe(view: View?): String {
  if (view == null) return "none"
  // Deliberately omit text, accessibility labels, nativeID, and content descriptions.
  val pointer = (view as? ReactPointerEventsView)?.pointerEvents
  val testId = (view.getTag(R.id.react_test_id) as? String)?.takeIf { it in diagnosticTestIds } ?: ""
  return "${view.javaClass.simpleName}#$testId/${view.id};p=$pointer;a=${view.alpha};enabled=${view.isEnabled};frame=${view.left},${view.top},${view.width},${view.height};translation=${view.translationX},${view.translationY}"
}

// Other test IDs include user-controlled entity IDs. Keep only fixed surface names.
private val diagnosticTestIds = setOf(
  "message-input-root", "composer-fullscreen", "composer-viewport", "composer-viewport-content",
  "composer-dock-content", "composer-track-scroll", "agent-list-backdrop", "file-explorer-backdrop",
  "workspace-create-submit", "new-workspace-launch-submit", "compact-provider-list",
)

// Expo's developer menu adds a full-window Compose host above the React root. It passes ordinary
// touches through, but RN's helper cannot traverse that host. Start at the actual React surface;
// native modal windows expose a separate RootView and receive their own observation.
private fun reactRootAt(view: View, x: Int, y: Int): ViewGroup? {
  if (view.visibility != View.VISIBLE || view.alpha == 0f) return null
  // getGlobalVisibleRect is relative to the window root, including for offset/freeform windows.
  val bounds = Rect()
  if (!view.getGlobalVisibleRect(bounds) || !bounds.contains(x, y)) return null
  if (view is RootView && view is ViewGroup) return view
  if (view is ViewGroup) {
    for (index in view.childCount - 1 downTo 0) {
      reactRootAt(view.getChildAt(index), x, y)?.let { return it }
    }
  }
  return null
}
