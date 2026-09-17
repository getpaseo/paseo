import UIKit
import CoreText

/// `startedAt` is wall-clock milliseconds; the run's graphemes start fading
/// evenly across `spanMs`, and each takes the same 150 ms envelope.
struct WordFadeRange { let start: Int; let end: Int; let startedAt: Double; let spanMs: Double }

// Adapts Software Mansion's ENRMTailFadeInAnimator: snapshot foreground colors,
// update NSTextStorage from CADisplayLink, and release the clock when settled.
// One clock per surface; every glyph reads its own absolute start time, so the
// line paints as one monotone front rather than a fade per word.
final class TailFadeInAnimator: NSObject {
  private struct Glyph {
    let range: NSRange
    var color: UIColor
    var appliedColor: UIColor?
    let start: CFTimeInterval
  }
  private struct Word {
    let endsAt: CFTimeInterval
    var glyphs: [Glyph]
  }

  private weak var textView: UITextView?
  private var ranges: [WordFadeRange] = []
  private var words: [Word] = []
  private var observer: NSObjectProtocol?
  private var displayLink: CADisplayLink?
  private var applying = false
  private static let duration: CFTimeInterval = 150

  var isAnimating: Bool { !words.isEmpty }

  init(textView: UITextView) {
    self.textView = textView
    super.init()
    observer = NotificationCenter.default.addObserver(
      forName: NSTextStorage.didProcessEditingNotification,
      object: textView.textStorage,
      queue: nil
    ) { [weak self] _ in self?.refresh() }
  }

  func close() {
    if let observer {
      NotificationCenter.default.removeObserver(observer)
      self.observer = nil
    }
    ranges = []
    restore()
    stopClock()
  }

  deinit {
    if let observer { NotificationCenter.default.removeObserver(observer) }
    displayLink?.invalidate()
  }

  func receive(ranges: [WordFadeRange]) {
    self.ranges = ranges
    refresh()
  }

  private func refresh() {
    guard !applying, let textView else { return }
    // Restore only colors we applied. A Fabric replacement may already carry
    // fresh styles; those are the next snapshot's source of truth.
    restore()
    let storage = textView.textStorage
    let now = Date().timeIntervalSince1970 * 1000
    for range in ranges {
      guard range.start >= 0, range.end <= storage.length, range.end > range.start,
            now < range.startedAt + range.spanMs + Self.duration else { continue }
      words.append(Word(endsAt: range.startedAt + range.spanMs + Self.duration,
                        glyphs: snapshot(NSRange(location: range.start, length: range.end - range.start),
                                         storage: storage, started: range.startedAt, span: range.spanMs)))
    }
    apply(now: now)
    if words.isEmpty { stopClock(); return }
    if displayLink == nil {
      let link = CADisplayLink(target: ClockTarget(self), selector: #selector(ClockTarget.step(_:)))
      link.preferredFramesPerSecond = 0
      link.add(to: .main, forMode: .common)
      displayLink = link
    }
  }

  private func snapshot(_ range: NSRange, storage: NSTextStorage, started: CFTimeInterval, span: CFTimeInterval) -> [Glyph] {
    let word = storage.attributedSubstring(from: range)
    let line = CTLineCreateWithAttributedString(word)
    let string = word.string as NSString
    var ranges: [(NSRange, CGFloat)] = []
    var offset = 0
    while offset < string.length {
      let cluster = string.rangeOfComposedCharacterSequence(at: offset)
      let left = CTLineGetOffsetForStringIndex(line, cluster.location, nil)
      let right = CTLineGetOffsetForStringIndex(line, NSMaxRange(cluster), nil)
      ranges.append((cluster, min(left, right)))
      offset = NSMaxRange(cluster)
    }
    ranges.sort { $0.1 < $1.1 }
    return ranges.enumerated().map { index, entry in
      let absolute = NSRange(location: range.location + entry.0.location, length: entry.0.length)
      return Glyph(range: absolute,
                   color: storage.attribute(.foregroundColor, at: absolute.location, effectiveRange: nil) as? UIColor ?? .label,
                   appliedColor: nil,
                   start: started + span * CFTimeInterval(index) / CFTimeInterval(ranges.count))
    }
  }

  fileprivate func step(_ link: CADisplayLink) {
    guard let textView, textView.window != nil else {
      restore()
      stopClock()
      return
    }
    // RNUITextView assigns its attributed text in drawRect, even when bounds
    // did not change. Flush that assignment before painting this frame.
    textView.superview?.layer.displayIfNeeded()
    apply(now: Date().timeIntervalSince1970 * 1000)
    if words.isEmpty { stopClock() }
  }

  private func apply(now: CFTimeInterval) {
    guard let storage = textView?.textStorage else { return }
    applying = true
    storage.beginEditing()
    for w in words.indices {
      for g in words[w].glyphs.indices {
        let glyph = words[w].glyphs[g]
        guard NSMaxRange(glyph.range) <= storage.length else { continue }
        let alpha = CGFloat(min(1, max(0, (now - glyph.start) / Self.duration)))
        let color = glyph.color.withAlphaComponent(glyph.color.cgColor.alpha * alpha)
        words[w].glyphs[g].appliedColor = color
        storage.addAttribute(.foregroundColor,
                             value: color,
                             range: glyph.range)
      }
    }
    storage.endEditing()
    applying = false
    words.removeAll { now >= $0.endsAt }
  }

  private func restore() {
    guard let storage = textView?.textStorage else { words.removeAll(); return }
    applying = true
    storage.beginEditing()
    for word in words {
      for glyph in word.glyphs where NSMaxRange(glyph.range) <= storage.length {
        let incoming = storage.attribute(.foregroundColor, at: glyph.range.location, effectiveRange: nil) as? UIColor
        if incoming == glyph.appliedColor {
          storage.addAttribute(.foregroundColor, value: glyph.color, range: glyph.range)
        }
      }
    }
    storage.endEditing()
    applying = false
    words.removeAll()
  }

  private func stopClock() {
    displayLink?.invalidate()
    displayLink = nil
  }
}

private final class ClockTarget: NSObject {
  weak var animator: TailFadeInAnimator?
  init(_ animator: TailFadeInAnimator) { self.animator = animator }
  @objc func step(_ link: CADisplayLink) { animator?.step(link) }
}
