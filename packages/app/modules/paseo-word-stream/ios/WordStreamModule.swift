import ExpoModulesCore
import UIKit

struct WordRangeRecord: Record {
  @Field var start: Int = 0
  @Field var end: Int = 0
  @Field var startedAt: Double = 0
  @Field var spanMs: Double = 0
}

public final class WordStreamModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoWordStream")
    View(WordFadeHost.self) {
      Prop("ranges") { (view: WordFadeHost, ranges: [WordRangeRecord]) in
        view.ranges = ranges.map {
          WordFadeRange(start: $0.start, end: $0.end, startedAt: $0.startedAt, spanMs: $0.spanMs)
        }
      }
    }
  }
}

final class WordFadeHost: ExpoView {
  private weak var textView: UITextView?
  private var animator: TailFadeInAnimator?
  var ranges: [WordFadeRange] = [] {
    didSet {
      animator?.receive(ranges: ranges)
      setNeedsLayout()
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    // RN's child owns geometry. Its drawRect installs the attributed string.
    subviews.forEach { $0.layer.displayIfNeeded() }
    bindTextView()
  }

  override func didAddSubview(_ subview: UIView) {
    super.didAddSubview(subview)
    setNeedsLayout()
  }

  override func willRemoveSubview(_ subview: UIView) {
    animator?.close()
    animator = nil
    textView = nil
    super.willRemoveSubview(subview)
  }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window == nil {
      animator?.close()
      animator = nil
      textView = nil
    } else {
      setNeedsLayout()
    }
  }

  override func prepareForRecycle() {
    ranges = []
    animator?.close()
    animator = nil
    textView = nil
    super.prepareForRecycle()
  }

  private func bindTextView() {
    guard let child = Self.findTextView(self) else { return }
    if child !== textView {
      animator?.close()
      textView = child
      animator = TailFadeInAnimator(textView: child)
    }
    animator?.receive(ranges: ranges)
  }

  private static func findTextView(_ view: UIView) -> UITextView? {
    if let text = view as? UITextView { return text }
    for child in view.subviews {
      if let text = findTextView(child) { return text }
    }
    return nil
  }
}
