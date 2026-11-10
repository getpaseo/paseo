import ExpoModulesCore
import UIKit

public final class PaseoWindowLayoutModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoWindowLayout")
    View(WindowLayoutView.self) {
      Events("onGeometryChange")
    }
    View(WindowLayoutTopInsetView.self) {
      Prop("additionalPadding", 0.0) { (view: WindowLayoutTopInsetView, padding: Double) in
        view.additionalPadding = CGFloat(padding)
      }
      Prop("unownedInset", 0.0) { (view: WindowLayoutTopInsetView, inset: Double) in
        view.unownedInset = CGFloat(inset)
      }
    }
  }
}

private let windowLayoutInsetsDidChange = Notification.Name("PaseoWindowLayoutInsetsDidChange")

final class WindowLayoutView: ExpoView {
  let onGeometryChange = EventDispatcher()
  private(set) var topInset: CGFloat = 0
  private(set) var hasTopBand = false
  private var updateObserver: CFRunLoopObserver?
  private var previousPayload: [String: Any]?
  private var divisions: [CGRect] = []
  private var barGuide: UILayoutGuide?
  private var barEdge = "none"
  private var bottomBarGuide: UILayoutGuide?
  private var topBarGuide: UILayoutGuide?
  private var occlusions: [CGRect] = []
  private var measuredBounds = CGRect.zero

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    #if compiler(>=6.4)
    if #available(iOS 27.1, *) {
      registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) {
        (view: WindowLayoutView, _) in
        view.setNeedsUpdateConstraints()
        view.scheduleUpdate()
      }
    }
    #endif
  }

  deinit {
    if let updateObserver { CFRunLoopObserverInvalidate(updateObserver) }
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
    setNeedsLayout()
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
    guard updateObserver == nil else { return }
    // A main-queue block can run between bounds and safe-area updates. Sample after
    // UIKit's layout transaction, once per turn, before the run loop goes idle.
    updateObserver = CFRunLoopObserverCreateWithHandler(
      kCFAllocatorDefault, CFRunLoopActivity.beforeWaiting.rawValue, false, CFIndex.max
    ) { [weak self] _, _ in
      guard let self else { return }
      self.updateObserver = nil
      self.publish()
    }
    CFRunLoopAddObserver(CFRunLoopGetMain(), updateObserver, .commonModes)
  }

  private func publish() {
    guard window != nil, bounds.width > 0, bounds.height > 0 else { return }
    // Resolve pending constraints and guides before pairing them with this view's insets.
    updateConstraintsIfNeeded()
    layoutIfNeeded()
    let bar = barGuide?.layoutFrame
    var barPayload: Any = NSNull()
    if let bar, bar.width > 0, bar.height > 0 { barPayload = rect(bar) }
    // Before UIKit resolves the guide its frame has no height: publish null (the
    // system inset applies) rather than a false zero clearance.
    var bottomClearance: Any = NSNull()
    if let bottomBar = bottomBarGuide?.layoutFrame, bottomBar.height > 0 {
      bottomClearance = max(0, bounds.maxY - bottomBar.maxY)
    }
    var topBar: Any = NSNull()
    var topBarFrame: CGRect? = nil
    if let frame = topBarGuide?.layoutFrame, frame.width > 0, frame.height > 0 {
      topBar = rect(frame)
      topBarFrame = frame
    }
    let insets = safeAreaInsets
    var nextTopInset = insets.top
    var nextHasTopBand = false
    if let frame = topBarFrame, frame.minY < insets.top {
      nextTopInset = max(0, frame.minY)
      nextHasTopBand = true
    }
    if nextTopInset != topInset || nextHasTopBand != hasTopBand {
      topInset = nextTopInset
      hasTopBand = nextHasTopBand
      NotificationCenter.default.post(name: windowLayoutInsetsDidChange, object: self)
    }
    let payload: [String: Any] = [
      "bounds": rect(bounds),
      "insets": [
        "top": insets.top,
        "right": insets.right,
        "bottom": insets.bottom,
        "left": insets.left
      ],
      "verticalBarEdge": barEdge,
      "verticalBar": barPayload,
      "bottomClearance": bottomClearance,
      "topBar": topBar,
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

final class WindowLayoutTopInsetView: ExpoView {
  var additionalPadding: CGFloat = 0 {
    didSet { updatePadding() }
  }
  // A Modal has its own physical viewport outside the owning native layout root.
  var unownedInset: CGFloat = 0 {
    didSet { updatePadding() }
  }
  private weak var layoutSource: WindowLayoutView?
  private var appliedHeight: CGFloat?

  override func didMoveToSuperview() {
    super.didMoveToSuperview()
    bindSource()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    bindSource()
  }

  deinit {
    NotificationCenter.default.removeObserver(self, name: windowLayoutInsetsDidChange, object: nil)
  }

  private func bindSource() {
    var ancestor = superview
    var source: WindowLayoutView?
    while let view = ancestor {
      if let root = view as? WindowLayoutView {
        source = root
        break
      }
      ancestor = view.superview
    }
    if layoutSource !== source {
      NotificationCenter.default.removeObserver(
        self, name: windowLayoutInsetsDidChange, object: layoutSource
      )
      layoutSource = source
      if let source {
        NotificationCenter.default.addObserver(
          self, selector: #selector(insetsDidChange(_:)),
          name: windowLayoutInsetsDidChange, object: source
        )
      }
    }
    updatePadding()
  }

  @objc private func insetsDidChange(_ notification: Notification) {
    updatePadding()
  }

  private func updatePadding() {
    guard window != nil else { return }
    let height: CGFloat
    if let source = layoutSource {
      height = source.topInset + (source.hasTopBand ? 0 : additionalPadding)
    } else {
      height = unownedInset
    }
    guard height != appliedHeight else { return }
    appliedHeight = height
    // Update Yoga on the native side; a JS geometry/context commit can trail rotation.
    setStyleSize(nil, height: NSNumber(value: Double(height)))
  }
}
