import CoreText
import UIKit

private let measureText = "mmmmmmmmmm"

/// The terminal font at one size: a CTFont per face (regular, bold, italic, bold italic) and the
/// cell those faces are laid out on. Cells are whole device pixels so every column origin is
/// exact. CoreText's cascade list covers characters the family lacks.
final class TerminalFont {
  let family: String
  let size: CGFloat
  let displayScale: CGFloat
  private let faces: [CTFont]

  /// Cell size and baseline in points, each a whole number of device pixels.
  let cellWidth: CGFloat
  let cellHeight: CGFloat
  let baseline: CGFloat
  let underlineOffset: CGFloat
  let underlineThickness: CGFloat
  let strikeOffset: CGFloat
  let strikeThickness: CGFloat

  init(family: String, size: CGFloat, displayScale: CGFloat) {
    self.family = family
    self.size = size
    self.displayScale = displayScale
    let regular = TerminalFont.makeFont(family: family, size: size, traits: [])
    faces = [
      regular,
      TerminalFont.makeFont(family: family, size: size, traits: .traitBold),
      TerminalFont.makeFont(family: family, size: size, traits: .traitItalic),
      TerminalFont.makeFont(family: family, size: size, traits: [.traitBold, .traitItalic]),
    ]

    let pixel = { (value: CGFloat) in max(1, (value * displayScale).rounded()) / displayScale }
    let line = CTLineCreateWithAttributedString(
      NSAttributedString(string: measureText, attributes: [.font: regular]))
    let width = CGFloat(CTLineGetTypographicBounds(line, nil, nil, nil))
    cellWidth = pixel(width / CGFloat(measureText.count))
    let ascent = CTFontGetAscent(regular)
    let descent = CTFontGetDescent(regular)
    let leading = CTFontGetLeading(regular)
    cellHeight = pixel(ascent + descent + leading)
    baseline = pixel(ascent)
    underlineOffset = -CTFontGetUnderlinePosition(regular)
    underlineThickness = max(1 / displayScale, CTFontGetUnderlineThickness(regular))
    strikeOffset = -CTFontGetXHeight(regular) / 2
    strikeThickness = underlineThickness
  }

  func font(flags: Int) -> CTFont { faces[TerminalFont.face(flags: flags)] }

  func sameAs(family: String, size: CGFloat, displayScale: CGFloat) -> Bool {
    self.family == family && self.size == size && self.displayScale == displayScale
  }

  static func face(flags: Int) -> Int {
    (flags & TerminalStyleFlags.bold != 0 ? 1 : 0) + (flags & TerminalStyleFlags.italic != 0 ? 2 : 0)
  }

  private static func makeFont(family: String, size: CGFloat, traits: UIFontDescriptor.SymbolicTraits) -> CTFont {
    let base = UIFontDescriptor(fontAttributes: [.family: family])
    let descriptor = traits.isEmpty ? base : (base.withSymbolicTraits(traits) ?? base)
    return UIFont(descriptor: descriptor, size: size) as CTFont
  }
}
