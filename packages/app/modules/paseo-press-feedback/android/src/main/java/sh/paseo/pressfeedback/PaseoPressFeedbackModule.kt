package sh.paseo.pressfeedback

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.types.ColorCompat
import expo.modules.kotlin.views.ExpoView

class PaseoPressFeedbackModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PaseoPressFeedback")
    View(PaseoPressFeedbackView::class) {
      Prop("tint") { view: PaseoPressFeedbackView, color: Color -> view.paint.color = ColorCompat.toArgb(color) }
      Prop("radius") { view: PaseoPressFeedbackView, radius: Double -> view.radius = radius.toFloat() * view.resources.displayMetrics.density }
      Prop("resetKey") { view: PaseoPressFeedbackView, key: String -> view.reset(key) }
      AsyncFunction("acknowledge") { view: PaseoPressFeedbackView -> view.acknowledge() }
    }
  }
}

class PaseoPressFeedbackView(context: Context, appContext: AppContext) : ExpoView(context, appContext) {
  val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  var radius = 0f
  private var acknowledged = false
  private var resetKey = ""
  init { setWillNotDraw(false); importantForAccessibility = IMPORTANT_FOR_ACCESSIBILITY_NO }
  fun acknowledge() { acknowledged = true; invalidate() }
  fun reset(key: String) {
    if (key != resetKey) { resetKey = key; acknowledged = false; invalidate() }
  }
  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    if (acknowledged) canvas.drawRoundRect(0f, 0f, width.toFloat(), height.toFloat(), radius, radius, paint)
  }
}
