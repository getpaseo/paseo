import ExpoModulesCore
import UIKit

public class PaseoPressFeedbackModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoPressFeedback")
    View(PaseoPressFeedbackView.self) {
      Prop("tint") { (view: PaseoPressFeedbackView, color: UIColor) in view.tint = color }
      Prop("radius") { (view: PaseoPressFeedbackView, radius: Double) in view.radius = radius }
      Prop("resetKey") { (view: PaseoPressFeedbackView, key: String) in view.reset(key) }
      AsyncFunction("acknowledge") { (view: PaseoPressFeedbackView) in view.acknowledge() }
    }
  }
}

final class PaseoPressFeedbackView: ExpoView {
  var tint = UIColor.clear
  var radius: Double = 0
  private var acknowledged = false
  private var resetKey = ""
  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isOpaque = false
    isUserInteractionEnabled = false
  }
  func acknowledge() { acknowledged = true; setNeedsDisplay() }
  func reset(_ key: String) {
    if key != resetKey { resetKey = key; acknowledged = false; setNeedsDisplay() }
  }
  override func draw(_ rect: CGRect) {
    if acknowledged { tint.setFill(); UIBezierPath(roundedRect: bounds, cornerRadius: radius).fill() }
  }
}
