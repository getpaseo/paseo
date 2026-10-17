import AppKit
import CoreGraphics

struct CapturedGesture {
  let id: String
  let points: [CGPoint]
  let foreground: [String: Any]
}

private class TrailView: NSView {
  var points: [CGPoint] = []
  override func draw(_ dirtyRect: NSRect) {
    NSColor(calibratedRed: 0.55, green: 0.35, blue: 1, alpha: 0.95).setStroke()
    let line = NSBezierPath()
    line.lineWidth = 4
    line.lineCapStyle = .round
    let height = CGDisplayBounds(CGMainDisplayID()).height
    for (index, point) in points.enumerated() {
      let local = NSPoint(x: point.x - window!.frame.minX, y: height - point.y - window!.frame.minY)
      if index == 0 { line.move(to: local) } else { line.line(to: local) }
    }
    line.stroke()
    let label = "Parlez · Échap pour annuler" as NSString
    label.draw(
      at: NSPoint(x: 24, y: 24),
      withAttributes: [
        .font: NSFont.systemFont(ofSize: 15, weight: .medium), .foregroundColor: NSColor.white,
        .backgroundColor: NSColor.black.withAlphaComponent(0.7),
      ])
  }
}

@MainActor final class GestureOverlay {
  private var gesture: CapturedGesture?
  private var panels: [NSPanel] = []
  private var timer: Timer?
  private var points: [CGPoint] = []
  func begin(id: String, foreground: [String: Any]) {
    cancel()
    gesture = CapturedGesture(id: id, points: [], foreground: foreground)
    points = [CGEvent(source: nil)?.location ?? .zero]
    for screen in NSScreen.screens {
      let panel = NSPanel(
        contentRect: screen.frame, styleMask: [.borderless, .nonactivatingPanel],
        backing: .buffered, defer: false)
      panel.isOpaque = false
      panel.backgroundColor = .clear
      panel.hasShadow = false
      panel.ignoresMouseEvents = true
      panel.level = .screenSaver
      panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
      let view = TrailView(frame: NSRect(origin: .zero, size: screen.frame.size))
      view.points = points
      panel.contentView = view
      panel.orderFrontRegardless()
      panels.append(panel)
    }
    timer = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { self?.sample() }
    }
    RunLoop.main.add(timer!, forMode: .common)
  }
  private func sample() {
    guard let point = CGEvent(source: nil)?.location, let previous = points.last,
      hypot(point.x - previous.x, point.y - previous.y) >= 2, points.count < 12000
    else { return }
    points.append(point)
    for panel in panels {
      let view = panel.contentView as! TrailView
      view.points = points
      view.needsDisplay = true
    }
  }
  func finish() -> CapturedGesture? {
    sample()
    let result = gesture.map {
      CapturedGesture(id: $0.id, points: points, foreground: $0.foreground)
    }
    cancel()
    return result
  }
  func cancel() {
    timer?.invalidate()
    timer = nil
    panels.forEach { $0.orderOut(nil) }
    panels.removeAll()
    gesture = nil
    points.removeAll()
  }
}

func annotateGesture(_ image: CGImage, bounds: CGRect, points: [CGPoint]) -> (CGImage, CGImage?) {
  let width = image.width
  let height = image.height
  guard
    let context = CGContext(
      data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
      space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { return (image, nil) }
  context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
  let scaleX = CGFloat(width) / bounds.width
  let scaleY = CGFloat(height) / bounds.height
  let pixels = points.map {
    CGPoint(x: ($0.x - bounds.minX) * scaleX, y: ($0.y - bounds.minY) * scaleY)
  }
  context.setStrokeColor(CGColor(red: 0.55, green: 0.35, blue: 1, alpha: 1))
  context.setFillColor(CGColor(red: 0.55, green: 0.35, blue: 1, alpha: 1))
  context.setLineWidth(4 * scaleX)
  context.setLineCap(.round)
  for (index, point) in pixels.enumerated() {
    let converted = CGPoint(x: point.x, y: CGFloat(height) - point.y)
    if index == 0 { context.move(to: converted) } else { context.addLine(to: converted) }
  }
  context.strokePath()
  if pixels.count == 1, let point = pixels.first {
    context.fillEllipse(
      in: CGRect(
        x: point.x - 4 * scaleX, y: CGFloat(height) - point.y - 4 * scaleY, width: 8 * scaleX,
        height: 8 * scaleY))
  }
  guard let annotated = context.makeImage() else { return (image, nil) }
  let visible = pixels.filter {
    $0.x >= 0 && $0.y >= 0 && $0.x < CGFloat(width) && $0.y < CGFloat(height)
  }
  guard let first = visible.first else { return (annotated, nil) }
  var box = CGRect(origin: first, size: CGSize(width: 1, height: 1))
  for point in visible { box = box.union(CGRect(origin: point, size: CGSize(width: 1, height: 1))) }
  box =
    box.insetBy(dx: -32 * scaleX, dy: -32 * scaleY).intersection(
      CGRect(x: 0, y: 0, width: width, height: height)
    ).integral
  return (annotated, annotated.cropping(to: box))
}
