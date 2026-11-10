import ExpoModulesCore
import UIKit

public final class PaseoWindowLayoutModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoWindowLayout")
    Function("setVerticalBarBehavior") { (behavior: String) in
      let disabled = behavior == "disabled"
      DispatchQueue.main.async { VerticalBarPreference.setDisabled(disabled) }
    }
    Function("getVerticalBarBehavior") { () -> String in
      VerticalBarPreference.disabled ? "disabled" : "automatic"
    }
    View(WindowLayoutView.self) {
      Events("onGeometryChange")
    }
  }
}

final class WindowLayoutView: ExpoView {
  let onGeometryChange = EventDispatcher()
  private var updateScheduled = false
  private var previousPayload: [String: Any]?
  private var divisions: [CGRect] = []
  private var occlusions: [CGRect] = []
  private var barGuide: UILayoutGuide?
  private var barEdge = "none"
  private var bottomBarGuide: UILayoutGuide?
  private var topBarGuide: UILayoutGuide?
  private var measuredBounds = CGRect.zero

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) {
        (view: WindowLayoutView, _) in
        view.setNeedsUpdateConstraints()
        view.scheduleUpdate()
      }
    }
    #endif
    NotificationCenter.default.addObserver(
      self,
      selector: #selector(verticalBarPreferenceDidChange),
      name: VerticalBarPreference.didChange,
      object: nil
    )
  }

  @objc private func verticalBarPreferenceDidChange() {
    previousPayload = nil
    setNeedsUpdateConstraints()
    scheduleUpdate()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    previousPayload = nil
    bottomBarGuide = nil
    topBarGuide = nil
    setNeedsUpdateConstraints()
    scheduleUpdate()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    setNeedsUpdateConstraints()
    scheduleUpdate()
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    if bounds != measuredBounds {
      measuredBounds = bounds
      setNeedsUpdateConstraints()
    }
    scheduleUpdate()
  }

  override func updateConstraints() {
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      // UIKit tracks these reads and invalidates constraints when regions change.
      divisions = reservedRegions(kind: .division).compactMap { $0.isActive ? $0.frame : nil }
      // Elements drawn over the window, such as the status bar pill with the vertical bar off.
      // Frames already include the system's interactive margins.
      occlusions = reservedRegions(kind: .occlusion).compactMap { $0.isActive ? $0.frame : nil }
      let edge: String
      switch traitCollection.verticalBarEdge {
      case .leading: edge = "leading"
      case .trailing: edge = "trailing"
      default: edge = "none"
      }
      if bottomBarGuide == nil {
        // Where a bottom bar rests: above the home indicator, refined to the
        // screen's corners rather than the rectangular safe area.
        bottomBarGuide = layoutGuide(for: .bar(onEdge: UIRectEdge.bottom, extent: 44))
      }
      if topBarGuide == nil {
        // Where a top bar rests. Beside a partial status region it can start above the
        // rectangular safe area; content still keeps out of the occlusions.
        topBarGuide = layoutGuide(for: .bar(onEdge: UIRectEdge.top, extent: 44))
      }
      if edge != barEdge {
        barEdge = edge
        barGuide = edge == "none" ? nil : layoutGuide(
          for: .bar(onEdge: edge == "trailing" ? .right : .left, extent: 44)
        )
      }
    }
    #endif
    super.updateConstraints()
    scheduleUpdate()
  }

  private func scheduleUpdate() {
    guard !updateScheduled else { return }
    updateScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.updateScheduled = false
      self.publish()
    }
  }

  private func publish() {
    guard window != nil, bounds.width > 0, bounds.height > 0 else { return }
    // A disabled bar keeps its preferred edge in the traits, but nothing occupies it.
    let barDisabled = VerticalBarPreference.disabled
    let bar = barDisabled ? nil : barGuide?.layoutFrame
    var barPayload: Any = NSNull()
    if let bar, bar.width > 0, bar.height > 0 { barPayload = rect(bar) }
    // Before UIKit resolves the guide its frame has no height: publish null (the
    // system inset applies) rather than a false zero clearance.
    var bottomClearance: Any = NSNull()
    if let bottomBar = bottomBarGuide?.layoutFrame, bottomBar.height > 0 {
      bottomClearance = max(0, bounds.maxY - bottomBar.maxY)
    }
    var statusBarPayload: Any = NSNull()
    if let window, let frame = window.windowScene?.statusBarManager?.statusBarFrame,
       frame.width > 0, frame.height > 0 {
      // The scene reports the frame in its coordinate space, which a full-screen window shares.
      statusBarPayload = rect(convert(frame, from: window))
    }
    var topBar: Any = NSNull()
    if let frame = topBarGuide?.layoutFrame, frame.width > 0, frame.height > 0 {
      topBar = rect(frame)
    }
    let payload: [String: Any] = [
      "bounds": rect(bounds),
      "verticalBarEdge": barEdge,
      "verticalBar": barPayload,
      "verticalBarBehavior": barDisabled ? "disabled" : "automatic",
      "statusBar": statusBarPayload,
      "topBar": topBar,
      "bottomClearance": bottomClearance,
      "occlusions": occlusions.map(rect),
      "divisions": divisions.map(rect)
    ]
    guard !NSDictionary(dictionary: payload).isEqual(to: previousPayload ?? [:]) else { return }
    previousPayload = payload
    onGeometryChange(payload)
  }

  private func rect(_ frame: CGRect) -> [String: CGFloat] {
    ["x": frame.minX, "y": frame.minY, "width": frame.width, "height": frame.height]
  }
}

/// The app-wide vertical bar preference (iOS 27.1). Disabling it moves the status bar back to the
/// top and removes the bar's leading or trailing safe-area inset, so content takes the full width.
///
/// React Native owns the root view controller, so the override is installed on
/// `UIViewController.preferredVerticalBarBehavior` and applies only to a window's root view
/// controller; every other view controller keeps UIKit's answer.
enum VerticalBarPreference {
  static let didChange = Notification.Name("PaseoVerticalBarPreferenceDidChange")
  private(set) static var disabled = false
  private static var installed = false

  static func setDisabled(_ value: Bool) {
    guard value != disabled else { return }
    // Devices and windows without a bar still receive the request. Honoring a disable
    // there makes the layout report "disabled" and the compact header drops its top padding.
    // Enabling stays allowed so a preference left on from another window can be restored.
    if value, !supportsVerticalBar() { return }
    disabled = value
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      install()
      for scene in UIApplication.shared.connectedScenes {
        guard let windowScene = scene as? UIWindowScene else { continue }
        for window in windowScene.windows {
          window.rootViewController?.setNeedsUpdateOfVerticalBarConfiguration()
        }
      }
    }
    #endif
    NotificationCenter.default.post(name: didChange, object: nil)
  }

  /// True when a connected window can show a vertical bar. Must run on the main queue.
  private static func supportsVerticalBar() -> Bool {
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      for scene in UIApplication.shared.connectedScenes {
        guard let windowScene = scene as? UIWindowScene else { continue }
        for window in windowScene.windows {
          let edge = window.traitCollection.verticalBarEdge
          if edge == .leading || edge == .trailing { return true }
        }
      }
    }
    #endif
    return false
  }

  #if compiler(>=6.4)
  @available(iOS 27.1, *)
  private static func install() {
    guard !installed else { return }
    installed = true
    let selector = #selector(getter: UIViewController.preferredVerticalBarBehavior)
    guard let method = class_getInstanceMethod(UIViewController.self, selector) else { return }
    typealias Getter = @convention(c) (UIViewController, Selector) -> UIVerticalBarBehavior
    let original = unsafeBitCast(method_getImplementation(method), to: Getter.self)
    let replacement: @convention(block) (UIViewController) -> UIVerticalBarBehavior = { controller in
      if disabled, let window = controller.viewIfLoaded?.window, window.rootViewController === controller {
        return .disabled
      }
      return original(controller, selector)
    }
    method_setImplementation(method, imp_implementationWithBlock(replacement))
  }
  #endif
}
