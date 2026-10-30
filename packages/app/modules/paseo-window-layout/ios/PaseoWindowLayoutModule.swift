import ExpoModulesCore
import UIKit

private var supportsModernWindowLayout: Bool {
  if #available(iOS 27.1, *) { return true }
  return false
}

public final class PaseoWindowLayoutModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoWindowLayout")

    Function("supportsModernWindowLayout") { supportsModernWindowLayout }

    View(PaseoTopBarGeometryView.self) {
      Events("onGeometryChange")

      Prop("contentHeight") { (view: PaseoTopBarGeometryView, height: Double) in
        view.contentHeight = CGFloat(height)
      }
      Prop("primaryRowHeight") { (view: PaseoTopBarGeometryView, height: Double) in
        view.primaryRowHeight = CGFloat(height)
      }
      Prop("topPadding") { (view: PaseoTopBarGeometryView, padding: Double) in
        view.topPadding = CGFloat(padding)
      }
      Prop("horizontalContentPadding") { (view: PaseoTopBarGeometryView, padding: Double) in
        view.horizontalContentPadding = CGFloat(padding)
      }
      Prop("navigationGroup") { (view: PaseoTopBarGeometryView, enabled: Bool) in
        view.navigationGroup = enabled
      }
    }


    View(PaseoBottomBarGeometryView.self) {
      ViewName("BottomBarGeometryProbe")
      Events("onGeometryChange")
      Prop("extent") { (view: PaseoBottomBarGeometryView, extent: Double) in
        view.extent = CGFloat(extent)
      }
      Prop("adaptHorizontalEdges") { (view: PaseoBottomBarGeometryView, enabled: Bool) in
        view.adaptHorizontalEdges = enabled
      }
    }
    View(PaseoContentBandGeometryView.self) {
      ViewName("ContentBandGeometryProbe")
      Events("onGeometryChange")
    }
  }
}

private struct TopBarGeometry: Equatable {
  let top: CGFloat
  let left: CGFloat
  let right: CGFloat
  let availableWidth: CGFloat
  let ownerWidth: CGFloat
  let ownerLeadingOffset: CGFloat
  let leadingCornerInset: CGFloat
  let requiresLeadingCornerSlot: Bool
  let alignmentCenterY: CGFloat?
}

// This view only measures. React owns the content and its normal-flow padding.
final class PaseoTopBarGeometryView: ExpoView {
  let onGeometryChange = EventDispatcher()

  var contentHeight: CGFloat = 0 {
    didSet { scheduleGeometryUpdate() }
  }
  var primaryRowHeight: CGFloat = 0 {
    didSet { scheduleGeometryUpdate() }
  }
  var topPadding: CGFloat = 0 {
    didSet { scheduleGeometryUpdate() }
  }
  var horizontalContentPadding: CGFloat = 0 {
    didSet { scheduleGeometryUpdate() }
  }
  var navigationGroup = false {
    didSet { scheduleGeometryUpdate() }
  }

  private var lastGeometry: TopBarGeometry?
  private var updateScheduled = false
  private var barGuide: UILayoutGuide?
  private var barExtent: CGFloat = -1
  private var guideConstraints: [NSLayoutConstraint] = []
  private weak var guideWindow: UIWindow?
  private var reservedRegionFrames: [CGRect] = []
  private var divisionRegionFrames: [CGRect] = []
  private var reservedRegionAlignmentCenterY: CGFloat?
  private let guideObserver = BarLayoutObserver()
  private let topContentBand = ContentBandLayoutView(frame: .zero)

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    guard supportsModernWindowLayout else { return }
    guideObserver.isUserInteractionEnabled = false
    guideObserver.translatesAutoresizingMaskIntoConstraints = false
    guideObserver.onChange = { [weak self] in self?.scheduleGeometryUpdate() }
    addSubview(guideObserver)
    topContentBand.onChange = { [weak self] in self?.scheduleGeometryUpdate() }
    topContentBand.setRegionOwner(self)
    addSubview(topContentBand)
    if #available(iOS 17.0, *) {
      registerForTraitChanges([UITraitDisplayScale.self]) {
        (view: PaseoTopBarGeometryView, _) in
        view.clearGuide()
        view.lastGeometry = nil
        view.setNeedsUpdateConstraints()
        view.scheduleGeometryUpdate()
      }
    }
    if #available(iOS 27.1, *) {
      registerForTraitChanges(UITraitCollection.systemTraitsAffectingVerticalBarEdge) {
        (view: PaseoTopBarGeometryView, _) in
        view.clearGuide()
        view.setNeedsUpdateConstraints()
        view.scheduleGeometryUpdate()
      }
    }
  }

  override var center: CGPoint {
    didSet {
      if center != oldValue {
        setNeedsUpdateConstraints()
        scheduleGeometryUpdate()
      }
    }
  }

  override var bounds: CGRect {
    didSet {
      if bounds != oldValue {
        setNeedsUpdateConstraints()
        scheduleGeometryUpdate()
      }
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    scheduleGeometryUpdate()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    setNeedsUpdateConstraints()
    scheduleGeometryUpdate()
  }

  override func didMoveToSuperview() {
    super.didMoveToSuperview()
    setNeedsUpdateConstraints()
    scheduleGeometryUpdate()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    clearGuide()
    lastGeometry = nil
    setNeedsUpdateConstraints()
    scheduleGeometryUpdate()
  }
  override func updateConstraints() {
    let previousFrames = reservedRegionFrames
    let previousDivisions = divisionRegionFrames
    let previousCenterY = reservedRegionAlignmentCenterY
    if #available(iOS 27.1, *) {
      // Reading reserved regions here lets UIKit automatically invalidate this view
      // when a region moves, without coupling geometry to window resize callbacks.
      divisionRegionFrames = reservedRegions(kind: .division)
        .compactMap { $0.isActive ? $0.frame : nil }
      divisionRegionFrames.sort { lhs, rhs in
        lhs.minX == rhs.minX ? lhs.minY < rhs.minY : lhs.minX < rhs.minX
      }
      reservedRegionFrames = divisionRegionFrames
      for region in reservedRegions(kind: .occlusion) where region.isActive {
        reservedRegionFrames.append(region.frame)
      }
      reservedRegionFrames.sort { lhs, rhs in
        lhs.minX == rhs.minX ? lhs.minY < rhs.minY : lhs.minX < rhs.minX
      }
      reservedRegionAlignmentCenterY = window.flatMap { primarySystemRegionCenterY(in: $0) }
    } else {
      reservedRegionFrames = []
      divisionRegionFrames = []
      reservedRegionAlignmentCenterY = nil
    }
    super.updateConstraints()
    if reservedRegionFrames != previousFrames || divisionRegionFrames != previousDivisions ||
        reservedRegionAlignmentCenterY != previousCenterY {
      scheduleGeometryUpdate()
    }
  }

  @available(iOS 27.1, *)
  private func primarySystemRegionCenterY(in window: UIWindow) -> CGFloat? {
    let viewport = convert(bounds, to: window)
    let candidates = window.reservedRegions(kind: .occlusion)
      .filter(\.isActive)
      .filter { region in
        let frame = region.frame
        // This is deliberately geometric matching, not semantic region identity:
        // choose the nearest active top-right primary region for this attached view.
        return frame.maxX >= window.bounds.maxX &&
          frame.minX > window.bounds.minX &&
          frame.midY <= window.bounds.midY &&
          frame.maxY >= viewport.minY
      }
    guard let region = candidates.min(by: { lhs, rhs in
      let left = lhs.frame.midX - window.bounds.maxX
      let right = rhs.frame.midX - window.bounds.maxX
      let leftDistance = hypot(left, lhs.frame.midY - window.bounds.minY)
      let rightDistance = hypot(right, rhs.frame.midY - window.bounds.minY)
      return leftDistance < rightDistance
    }) else { return nil }
    // UIKit's current frame already includes interactive margins; do not add them.
    return convert(CGPoint(x: region.frame.midX, y: region.frame.midY), from: window).y - bounds.minY
  }

  private func clearGuide() {
    NSLayoutConstraint.deactivate(guideConstraints)
    guideConstraints = []
    barGuide = nil
    guideWindow = nil
    barExtent = -1
  }

  private func scheduleGeometryUpdate() {
    guard !updateScheduled else { return }
    updateScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.updateScheduled = false
      self.updateGeometry()
    }
  }

  private func updateGeometry() {
    guard supportsModernWindowLayout, let window, bounds.width > 0, bounds.height > 0,
          contentHeight.isFinite, contentHeight > 0, topPadding.isFinite else { return }
    updateConstraintsIfNeeded()

    let padding = max(0, topPadding)
    // Side-bar environments can use the top edge in either window shape.
    // Other windows keep their existing top safe-area behavior.
    var usesTopEdgePlacement = window.bounds.width > window.bounds.height && safeAreaInsets.top == 0
    if #available(iOS 27.1, *) {
      // Custom containers can report no bar preference while the native system
      // controls still occupy a partial top-trailing reserved region.
      usesTopEdgePlacement = usesTopEdgePlacement ||
        traitCollection.verticalBarEdge != .unspecified || reservedRegionAlignmentCenterY != nil
    }
    var top: CGFloat = 0
    var left: CGFloat = 0
    var right: CGFloat = bounds.width
    var noFit = false
    var usesNativeBarPlacement = false
    let ownerLeadingOffset = max(0, convert(bounds, to: window).minX - window.bounds.minX)
    var leadingCornerInset: CGFloat = 0
    var requiresLeadingCornerSlot = false
    var alignmentCenterY = usesTopEdgePlacement ? nil : reservedRegionAlignmentCenterY

    if #available(iOS 27.1, *) {
      let extent = contentHeight + padding
      let contentPadding = max(0, horizontalContentPadding)
      if guideWindow !== window || barExtent != extent {
        clearGuide()
        guideWindow = window
        barExtent = extent
        let guide = layoutGuide(for: .bar(onEdge: UIRectEdge.top, extent: extent))
        barGuide = guide
        guideConstraints = [
          guideObserver.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
          guideObserver.trailingAnchor.constraint(equalTo: guide.trailingAnchor),
          guideObserver.topAnchor.constraint(equalTo: guide.topAnchor),
          guideObserver.bottomAnchor.constraint(equalTo: guide.bottomAnchor)
        ]
        NSLayoutConstraint.activate(guideConstraints)
        setNeedsLayout()
        layoutIfNeeded()
      }

      if let frame = barGuide?.layoutFrame, frame.width > 0, frame.height > 0 {
        top = usesTopEdgePlacement ? 0 : max(0, frame.minY - bounds.minY)
        // Credit the row's existing padding against bar margins, not safe-area insets.
        if !(navigationGroup && usesTopEdgePlacement) {
          left = max(0, frame.minX - bounds.minX - contentPadding)
          right = min(bounds.width, frame.maxX - bounds.minX + contentPadding)
        }
        usesNativeBarPlacement = !usesTopEdgePlacement && frame.height >= extent
      }

      if usesTopEdgePlacement {
        // The .bar guide's horizontal margins describe its lower resting band.
        // Query corners at the actual edge-aligned control band's position instead.
        topContentBand.frame = CGRect(
          x: bounds.minX - ownerLeadingOffset, y: bounds.minY,
          width: window.bounds.width, height: primaryRowHeight
        )
        topContentBand.setNeedsUpdateConstraints()
        topContentBand.layoutIfNeeded()
        leadingCornerInset = topContentBand.edgeInsets(
          for: .safeArea(cornerAdaptation: .horizontal)
        ).left
        // Publish a window requirement, not a result tied to the old sidebar position.
        // React projects its current row height and shell allocation in the same render.
        requiresLeadingCornerSlot = (barGuide?.layoutFrame.minY ?? bounds.minY) > bounds.minY
      }

      // Keep a complete native bar placement. Reapply occlusions only when our
      // top-edge layout overrides it; folds still divide either placement.
      let exclusions = usesNativeBarPlacement ? divisionRegionFrames : reservedRegionFrames
      if let centerY = alignmentCenterY, primaryRowHeight > 0 {
        top = max(0, centerY - primaryRowHeight / 2 - padding)
      }

      // A zero-width result is intentional: the parent must choose a vertical
      // placement instead of retaining stale top-bar geometry.
      for _ in 0...exclusions.count {
        let bandTop = bounds.minY + top + padding
        let bandBottom = bandTop + contentHeight
        let minX = bounds.minX + left
        let maxX = bounds.minX + right
        var cursor = minX
        var bestStart = minX
        var bestWidth: CGFloat = 0
        var nextTop = top
        for frame in exclusions where frame.maxY > bandTop && frame.minY < bandBottom {
          guard frame.maxX >= minX, frame.minX <= maxX else { continue }
          let start = max(minX, frame.minX)
          let end = min(maxX, frame.maxX)
          if start - cursor > bestWidth {
            bestStart = cursor
            bestWidth = start - cursor
          }
          cursor = max(cursor, end)
          nextTop = max(nextTop, frame.maxY - bounds.minY - padding)
        }
        if maxX - cursor > bestWidth {
          bestStart = cursor
          bestWidth = maxX - cursor
        }
        if bestWidth > 0 {
          left = bestStart - bounds.minX
          right = left + bestWidth
          break
        }
        guard nextTop > top else {
          noFit = true
          break
        }
        top = nextTop
        alignmentCenterY = nil
      }
      if noFit {
        left = max(0, min(bounds.width, left))
        right = left
      }
    }

    let scale = window.screen.scale
    func roundUp(_ value: CGFloat) -> CGFloat { ceil(value * scale) / scale }
    let roundedLeft = roundUp(left)
    let roundedRight = roundUp(max(0, bounds.width - right))
    let width = noFit ? 0 : max(0, bounds.width - roundedLeft - roundedRight)
    let geometry = TopBarGeometry(
      top: roundUp(top), left: roundedLeft, right: roundedRight, availableWidth: width,
      ownerWidth: bounds.width, ownerLeadingOffset: ownerLeadingOffset,
      leadingCornerInset: roundUp(leadingCornerInset), requiresLeadingCornerSlot: requiresLeadingCornerSlot,
      alignmentCenterY: alignmentCenterY
    )
    guard geometry != lastGeometry else { return }
    lastGeometry = geometry
    onGeometryChange([
      "top": geometry.top,
      "left": geometry.left,
      "right": geometry.right,
      "availableWidth": geometry.availableWidth,
      "ownerWidth": geometry.ownerWidth,
      "ownerLeadingOffset": geometry.ownerLeadingOffset,
      "leadingCornerInset": geometry.leadingCornerInset,
      "requiresLeadingCornerSlot": geometry.requiresLeadingCornerSlot,
      "alignmentCenterY": geometry.alignmentCenterY.map { $0 as Any } ?? NSNull()
    ])
  }
}

private final class BarLayoutObserver: UIView {
  var onChange: (() -> Void)?

  override func layoutSubviews() {
    super.layoutSubviews()
    onChange?()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    onChange?()
  }
}


private final class BottomBarLayoutObserver: UIView {
  var onChange: (() -> Void)?

  override var center: CGPoint {
    didSet {
      if center != oldValue { onChange?() }
    }
  }

  override var bounds: CGRect {
    didSet {
      if bounds != oldValue { onChange?() }
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    onChange?()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    onChange?()
  }
}

private final class ContentBandLayoutView: UIView {
  var onChange: (() -> Void)?
  private(set) var exclusions: [CGRect] = []
  private(set) var divisions: [CGRect] = []
  private(set) var placementBounds: CGRect = .zero
  private weak var regionOwner: UIView?
  private var ownerBottomLimit: CGFloat?
  private var marginsGuide: UILayoutGuide?
  private let observer = BottomBarLayoutObserver()

  func setRegionOwner(_ owner: UIView?, bottomLimit: CGFloat? = nil) {
    guard regionOwner !== owner || ownerBottomLimit != bottomLimit else { return }
    regionOwner = owner
    ownerBottomLimit = bottomLimit
    setNeedsUpdateConstraints()
  }

  override init(frame: CGRect) {
    super.init(frame: frame)
    configure()
  }

  required init?(coder: NSCoder) {
    super.init(coder: coder)
    configure()
  }

  private func configure() {
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    // Query the local control band outside rectangular safe-area margins.
    // Each owner retains its own vertical system-bar or inset placement.
    insetsLayoutMarginsFromSafeArea = false
    layoutMargins = .zero
    guard #available(iOS 27.1, *) else { return }
    let guide = layoutGuide(for: .margins(cornerAdaptation: .horizontal))
    marginsGuide = guide
    observer.translatesAutoresizingMaskIntoConstraints = false
    observer.onChange = { [weak self] in self?.onChange?() }
    addSubview(observer)
    NSLayoutConstraint.activate([
      observer.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
      observer.trailingAnchor.constraint(equalTo: guide.trailingAnchor),
      observer.topAnchor.constraint(equalTo: guide.topAnchor),
      observer.bottomAnchor.constraint(equalTo: guide.bottomAnchor)
    ])
  }

  var horizontalInsets: UIEdgeInsets {
    guard let frame = marginsGuide?.layoutFrame else { return .zero }
    return UIEdgeInsets(top: 0, left: max(0, frame.minX - bounds.minX), bottom: 0,
                       right: max(0, bounds.maxX - frame.maxX))
  }

  override func updateConstraints() {
    if #available(iOS 27.1, *) {
      let owner = regionOwner ?? superview ?? self
      // UIKit tracks these owner reads and invalidates constraints when regions change.
      let activeDivisions = owner.reservedRegions(kind: .division).filter(\.isActive)
      var nextDivisions: [CGRect] = activeDivisions.map { region in
        self.convert(region.frame, from: owner)
      }
      nextDivisions.sort { lhs, rhs in
        lhs.minX == rhs.minX ? lhs.minY < rhs.minY : lhs.minX < rhs.minX
      }
      let regions = owner.reservedRegions(kind: .occlusion).filter(\.isActive) + activeDivisions
      let frames = regions.map { self.convert($0.frame, from: owner) }
      let next = frames
        .sorted { lhs, rhs in
          lhs.minX == rhs.minX ? lhs.minY < rhs.minY : lhs.minX < rhs.minX
        }
      var nextPlacementBounds = convert(owner.bounds, from: owner)
      let placementBottom = convert(
        CGPoint(x: owner.bounds.midX, y: ownerBottomLimit ?? (owner.bounds.maxY - owner.safeAreaInsets.bottom)),
        from: owner
      ).y
      nextPlacementBounds.size.height = max(0, placementBottom - nextPlacementBounds.minY)
      if next != exclusions || nextDivisions != divisions || nextPlacementBounds != placementBounds {
        exclusions = next
        divisions = nextDivisions
        placementBounds = nextPlacementBounds
        onChange?()
      }
    }
    super.updateConstraints()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    setNeedsUpdateConstraints()
    onChange?()
  }
}

private func layoutRectPayload(_ value: CGRect) -> [String: CGFloat] {
  ["x": value.origin.x, "y": value.origin.y, "width": value.width, "height": value.height]
}

private struct HorizontalContentGeometry: Equatable {
  let left: CGFloat
  let right: CGFloat
  let exclusions: [CGRect]
  let placementBounds: CGRect

  var event: [String: Any] {
    ["margins": ["left": left, "right": right],
     "exclusions": exclusions.map { layoutRectPayload($0) },
     "placementBounds": layoutRectPayload(placementBounds)]
  }
}
private struct BottomBarGeometry: Equatable {
  let bounds: CGRect
  let bar: CGRect
  let horizontal: HorizontalContentGeometry?

  var event: [String: Any] {
    var result: [String: Any] = [
      "bounds": layoutRectPayload(bounds),
      "bar": layoutRectPayload(bar)
    ]
    if let horizontal {
      result["horizontal"] = horizontal.event
    }
    return result
  }
}

final class PaseoBottomBarGeometryView: ExpoView {
  let onGeometryChange = EventDispatcher()
  var extent: CGFloat = 0 {
    didSet { if extent != oldValue { scheduleGeometryUpdate() } }
  }
  var adaptHorizontalEdges = false {
    didSet {
      guard adaptHorizontalEdges != oldValue else { return }
      contentBand?.removeFromSuperview()
      contentBand = nil
      lastGeometry = nil
      scheduleGeometryUpdate()
    }
  }
  private var contentBand: ContentBandLayoutView?

  private var lastGeometry: BottomBarGeometry?
  private var updateScheduled = false
  private var barGuide: UILayoutGuide?
  private var guideObserver: BottomBarLayoutObserver?
  private var guideConstraints: [NSLayoutConstraint] = []
  private weak var guideWindow: UIWindow?
  private var guideExtent: CGFloat = -1
  @available(iOS 27.1, *)
  private func horizontalGeometry(in bar: CGRect) -> HorizontalContentGeometry? {
    guard adaptHorizontalEdges else { return nil }
    let band: ContentBandLayoutView
    if let existing = contentBand {
      band = existing
    } else {
      band = ContentBandLayoutView(frame: .zero)
      band.setRegionOwner(self)
      band.onChange = { [weak self] in self?.scheduleGeometryUpdate() }
      addSubview(band)
      contentBand = band
    }
    // The bar guide already clears the indicator; do not impose the older
    // rectangular safe area on its more precise resting position.
    band.setRegionOwner(self, bottomLimit: bar.maxY)
    let frame = CGRect(x: bounds.minX, y: bar.minY, width: bounds.width, height: bar.height)
    if band.frame != frame {
      band.frame = frame
      band.setNeedsUpdateConstraints()
    }
    band.layoutIfNeeded()
    let insets = band.horizontalInsets
    return HorizontalContentGeometry(left: insets.left, right: insets.right,
                                     exclusions: band.exclusions,
                                     placementBounds: band.placementBounds)
  }

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    backgroundColor = .clear
    guard supportsModernWindowLayout else { return }
    if #available(iOS 17.0, *) {
      registerForTraitChanges([UITraitDisplayScale.self]) {
        (view: PaseoBottomBarGeometryView, _) in
        view.contentBand?.setNeedsUpdateConstraints()
        view.scheduleGeometryUpdate()
      }
    }
  }

  override var center: CGPoint {
    didSet {
      if center != oldValue {
        contentBand?.setNeedsUpdateConstraints()
        scheduleGeometryUpdate()
      }
    }
  }

  override var bounds: CGRect {
    didSet { if bounds != oldValue { scheduleGeometryUpdate() } }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    scheduleGeometryUpdate()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    contentBand?.setNeedsUpdateConstraints()
    scheduleGeometryUpdate()
  }

  override func didMoveToSuperview() {
    super.didMoveToSuperview()
    scheduleGeometryUpdate()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    clearGuide()
    lastGeometry = nil
    scheduleGeometryUpdate()
  }

  private func clearGuide() {
    NSLayoutConstraint.deactivate(guideConstraints)
    guideConstraints = []
    guideObserver?.onChange = nil
    guideObserver?.removeFromSuperview()
    guideObserver = nil
    barGuide = nil
    guideWindow = nil
    guideExtent = -1
  }

  private func scheduleGeometryUpdate() {
    guard supportsModernWindowLayout, !updateScheduled else { return }
    updateScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.updateScheduled = false
      self.updateGeometry()
    }
  }

  private func updateGeometry() {
    guard #available(iOS 27.1, *), let window,
          extent.isFinite, extent >= 0, bounds.width > 0, bounds.height > 0 else { return }

    if guideWindow !== window || guideExtent != extent {
      clearGuide()
      guideWindow = window
      guideExtent = extent
      let guide = layoutGuide(for: .bar(onEdge: UIRectEdge.bottom, extent: extent))
      barGuide = guide
      let observer = BottomBarLayoutObserver()
      observer.isUserInteractionEnabled = false
      observer.translatesAutoresizingMaskIntoConstraints = false
      observer.onChange = { [weak self] in self?.scheduleGeometryUpdate() }
      addSubview(observer)
      guideObserver = observer
      guideConstraints = [
        observer.leadingAnchor.constraint(equalTo: guide.leadingAnchor),
        observer.trailingAnchor.constraint(equalTo: guide.trailingAnchor),
        observer.topAnchor.constraint(equalTo: guide.topAnchor),
        observer.bottomAnchor.constraint(equalTo: guide.bottomAnchor)
      ]
      NSLayoutConstraint.activate(guideConstraints)
      layoutIfNeeded()
    }

    layoutIfNeeded()
    guard let barGuide else { return }
    let geometry = BottomBarGeometry(bounds: bounds, bar: barGuide.layoutFrame,
                                     horizontal: horizontalGeometry(in: barGuide.layoutFrame))
    guard geometry != lastGeometry else { return }
    lastGeometry = geometry
    onGeometryChange(geometry.event)
  }
}

private struct ContentBandGeometry: Equatable {
  let bounds: CGRect
  let horizontal: HorizontalContentGeometry
  let divisions: [CGRect]

  var event: [String: Any] {
    var result = horizontal.event
    result["bounds"] = layoutRectPayload(bounds)
    result["divisions"] = divisions.map { layoutRectPayload($0) }
    return result
  }
}

final class PaseoContentBandGeometryView: ExpoView {
  let onGeometryChange = EventDispatcher()
  private let contentBand = ContentBandLayoutView(frame: .zero)
  private var lastGeometry: ContentBandGeometry?
  private var updateScheduled = false

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isUserInteractionEnabled = false
    contentBand.onChange = { [weak self] in self?.scheduleGeometryUpdate() }
    addSubview(contentBand)
    if #available(iOS 17.0, *) {
      registerForTraitChanges([UITraitDisplayScale.self]) {
        (view: PaseoContentBandGeometryView, _) in
        view.contentBand.setNeedsUpdateConstraints()
        view.scheduleGeometryUpdate()
      }
    }
  }

  override var center: CGPoint {
    didSet {
      if center != oldValue {
        contentBand.setNeedsUpdateConstraints()
        scheduleGeometryUpdate()
      }
    }
  }

  override var bounds: CGRect {
    didSet { if bounds != oldValue { scheduleGeometryUpdate() } }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    scheduleGeometryUpdate()
  }

  override func safeAreaInsetsDidChange() {
    super.safeAreaInsetsDidChange()
    contentBand.setNeedsUpdateConstraints()
    scheduleGeometryUpdate()
  }

  override func didMoveToSuperview() {
    super.didMoveToSuperview()
    contentBand.setRegionOwner(superview)
    contentBand.setNeedsUpdateConstraints()
    lastGeometry = nil
    scheduleGeometryUpdate()
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    lastGeometry = nil
    contentBand.setRegionOwner(superview)
    contentBand.setNeedsUpdateConstraints()
    scheduleGeometryUpdate()
  }

  private func scheduleGeometryUpdate() {
    guard supportsModernWindowLayout, !updateScheduled else { return }
    updateScheduled = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.updateScheduled = false
      self.updateGeometry()
    }
  }

  private func updateGeometry() {
    guard #available(iOS 27.1, *), window != nil,
          bounds.width > 0, bounds.height > 0 else { return }
    if contentBand.frame != bounds {
      contentBand.frame = bounds
      contentBand.setNeedsUpdateConstraints()
    }
    contentBand.setRegionOwner(superview)
    contentBand.layoutIfNeeded()
    let insets = contentBand.horizontalInsets
    let horizontal = HorizontalContentGeometry(left: insets.left, right: insets.right,
                                               exclusions: contentBand.exclusions,
                                               placementBounds: contentBand.placementBounds)
    let geometry = ContentBandGeometry(bounds: bounds, horizontal: horizontal, divisions: contentBand.divisions)
    guard geometry != lastGeometry else { return }
    lastGeometry = geometry
    onGeometryChange(geometry.event)
  }
}
