import XCTest
import UIKit

final class WordFadeTests: XCTestCase {
  private var window: UIWindow!
  private var text: UITextView!
  private var animator: TailFadeInAnimator!

  override func setUp() {
    super.setUp()
    window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
    let controller = UIViewController()
    window.rootViewController = controller
    text = UITextView(frame: CGRect(x: 10, y: 30, width: 300, height: 400))
    text.font = .systemFont(ofSize: 20)
    text.isEditable = false
    text.isSelectable = true
    controller.view.addSubview(text)
    window.makeKeyAndVisible()
  }

  override func tearDown() {
    animator?.close()
    animator = nil
    window.isHidden = true
    window = nil
    super.tearDown()
  }

  private func content(_ value: String) -> NSAttributedString {
    NSAttributedString(string: value, attributes: [.font: UIFont.systemFont(ofSize: 20), .foregroundColor: UIColor.label])
  }

  private func reveal(from start: Int) {
    let matches = try! NSRegularExpression(pattern: "\\S+").matches(in: text.text, range: NSRange(location: start, length: text.textStorage.length - start))
    animator.receive(ranges: matches.map {
      WordFadeRange(start: $0.range.location, end: NSMaxRange($0.range), startedAt: Date().timeIntervalSince1970 * 1000, spanMs: 40)
    })
  }

  func testRemountKeepsExpiredWordsOpaque() {
    text.attributedText = content("old new")
    animator = TailFadeInAnimator(textView: text)
    let now = Date().timeIntervalSince1970 * 1000
    animator.receive(ranges: [
      WordFadeRange(start: 0, end: 3, startedAt: now - 200, spanMs: 40),
      WordFadeRange(start: 4, end: 7, startedAt: now, spanMs: 40)
    ])
    XCTAssertEqual(alpha(0), 1)
    XCTAssertLessThan(alpha(4), 0.1)
  }

  private func alpha(_ index: Int) -> CGFloat {
    (text.textStorage.attribute(.foregroundColor, at: index, effectiveRange: nil) as! UIColor).cgColor.alpha
  }

  private func after(_ interval: TimeInterval, _ assertion: @escaping () -> Void) {
    let done = expectation(description: "native display frames")
    DispatchQueue.main.asyncAfter(deadline: .now() + interval) { assertion(); done.fulfill() }
    wait(for: [done], timeout: 2)
  }

  func testHistoryIsPlainAndAppendedWordFadesLeftToRight() {
    text.attributedText = content("History ")
    animator = TailFadeInAnimator(textView: text)
    XCTAssertFalse(animator.isAnimating)
    text.attributedText = content("History abcdefgh ")
    reveal(from: 8)
    XCTAssertEqual(alpha(0), 1)
    XCTAssertEqual(alpha(8), 0, accuracy: 0.05)
    XCTAssertTrue(animator.isAnimating)
    after(0.065) { XCTAssertGreaterThan(self.alpha(8), self.alpha(15)) }
    after(0.2) {
      XCTAssertEqual(self.alpha(15), 1)
      XCTAssertFalse(self.animator.isAnimating)
      XCTAssertEqual(self.text.text, "History abcdefgh ")
    }
  }

  func testCompletionPreservesSelectionBackgroundAndOriginalAlpha() {
    let color = UIColor.red.withAlphaComponent(0.7)
    let value = NSAttributedString(string: "Native selection", attributes: [.font: UIFont.systemFont(ofSize: 20), .foregroundColor: color, .backgroundColor: UIColor.darkGray])
    text.attributedText = value
    text.selectedRange = NSRange(location: 0, length: 6)
    animator = TailFadeInAnimator(textView: text)
    reveal(from: 0)
    XCTAssertEqual(text.textStorage.attribute(.backgroundColor, at: 0, effectiveRange: nil) as? UIColor, .darkGray)
    after(0.25) {
      XCTAssertEqual(self.alpha(0), 0.7, accuracy: 0.001)
      XCTAssertEqual(self.text.selectedRange, NSRange(location: 0, length: 6))
      XCTAssertEqual(self.text.attributedText, value)
    }
  }

  func testGraphemeClustersAndAppendDuringFadeKeepOriginalColors() {
    text.attributedText = content("")
    animator = TailFadeInAnimator(textView: text)
    text.textStorage.append(content("👨‍👩‍👧‍👦 café "))
    reveal(from: 0)
    let next = text.textStorage.length
    text.textStorage.append(content("more "))
    reveal(from: next)
    XCTAssertEqual(alpha(0), alpha(1))
    after(0.25) {
      for index in 0..<self.text.textStorage.length { XCTAssertEqual(self.alpha(index), 1) }
      XCTAssertFalse(self.animator.isAnimating)
    }
  }

  func testCurrentRangesReplaceEveryPreviousRangeAndPreserveNewStyles() {
    text.attributedText = content("old word")
    animator = TailFadeInAnimator(textView: text)
    let now = Date().timeIntervalSince1970 * 1000
    animator.receive(ranges: [WordFadeRange(start: 0, end: 3, startedAt: now, spanMs: 60)])
    let color = UIColor.red.withAlphaComponent(0.7)
    text.attributedText = NSAttributedString(string: "old word new", attributes: [.foregroundColor: color])
    animator.receive(ranges: [WordFadeRange(start: 9, end: 12, startedAt: now + 200, spanMs: 60)])
    XCTAssertEqual(alpha(0), 0.7, accuracy: 0.001)
    XCTAssertEqual(alpha(9), 0)
    animator.receive(ranges: [])
    XCTAssertEqual(alpha(9), 0.7, accuracy: 0.001)
    XCTAssertFalse(animator.isAnimating)
    animator.close()
    text.attributedText = content("recycled")
    animator = TailFadeInAnimator(textView: text)
    animator.receive(ranges: [WordFadeRange(start: 4, end: 8, startedAt: now + 200, spanMs: 60)])
    XCTAssertEqual(alpha(0), 1)
    XCTAssertEqual(alpha(4), 0)
  }

  func testRightToLeftTextStillFadesFromVisualLeftToRight() {
    for value in ["שלום", "العربية"] {
      text.attributedText = content(value)
      text.layoutIfNeeded()
      let ordered = (0..<text.textStorage.length).sorted { lhs, rhs in
        let left = text.position(from: text.beginningOfDocument, offset: lhs)!
        let right = text.position(from: text.beginningOfDocument, offset: rhs)!
        return text.caretRect(for: left).minX < text.caretRect(for: right).minX
      }
      animator = TailFadeInAnimator(textView: text)
      reveal(from: 0)
      after(0.065) {
        XCTAssertGreaterThan(self.alpha(ordered.first!), self.alpha(ordered.last!), value)
      }
      animator.close()
    }
  }

  func testDetachedSurfaceSettlesAndCanAnimateAfterReattachment() {
    text.attributedText = content("Visible word")
    animator = TailFadeInAnimator(textView: text)
    reveal(from: 0)
    text.removeFromSuperview()
    after(0.2) {
      XCTAssertFalse(self.animator.isAnimating)
      XCTAssertEqual(self.alpha(0), 1)
    }
    window.rootViewController!.view.addSubview(text)
    let next = text.textStorage.length
    text.textStorage.append(content(" appended"))
    reveal(from: next)
    XCTAssertTrue(animator.isAnimating)
    after(0.2) {
      XCTAssertFalse(self.animator.isAnimating)
      XCTAssertEqual(self.alpha(self.text.textStorage.length - 1), 1)
    }
  }

  func testConsecutiveWordsFormOneFrontAcrossTheWordBoundary() {
    text.attributedText = content("one two")
    animator = TailFadeInAnimator(textView: text)
    let now = Date().timeIntervalSince1970 * 1000
    animator.receive(ranges: [
      WordFadeRange(start: 0, end: 3, startedAt: now, spanMs: 60),
      WordFadeRange(start: 4, end: 7, startedAt: now + 60, spanMs: 60)
    ])
    after(0.05) {
      let alphas = [0, 1, 2, 4, 5, 6].map { self.alpha($0) }
      for index in 1..<alphas.count {
        XCTAssertLessThanOrEqual(alphas[index], alphas[index - 1], "opacity must not increase in reading order")
      }
      XCTAssertGreaterThan(self.alpha(2), self.alpha(4), "the next word must not overtake the end of the previous word")
    }
  }

  func testReplacementAndCloseReleaseOldRanges() {
    text.attributedText = content("Old text")
    animator = TailFadeInAnimator(textView: text)
    text.attributedText = content("Replacement")
    animator.receive(ranges: [])
    XCTAssertFalse(animator.isAnimating)
    XCTAssertEqual(alpha(0), 1)
    animator.close()
    text.attributedText = content("Replacement appended")
    XCTAssertEqual(alpha(12), 1)
  }
}
