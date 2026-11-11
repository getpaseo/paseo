import CoreGraphics

/// Box drawing and block elements painted as cell geometry instead of font glyphs, so frames and
/// blocks join across cells regardless of the font's own metrics.
final class TerminalCustomGlyph {
  private let rects: [Double]
  private let commands: [Double]
  private let strokeWidth: CGFloat

  init(_ record: TerminalCustomGlyphRecord) {
    rects = record.rects
    commands = record.path
    strokeWidth = CGFloat(record.strokeWidth)
  }

  func draw(in context: CGContext, rect cell: CGRect, color: CGColor) {
    context.saveGState()
    context.setFillColor(color)
    var index = 0
    while index + 3 < rects.count {
      context.fill(CGRect(
        x: cell.minX + CGFloat(rects[index]) * cell.width,
        y: cell.minY + CGFloat(rects[index + 1]) * cell.height,
        width: CGFloat(rects[index + 2]) * cell.width,
        height: CGFloat(rects[index + 3]) * cell.height))
      index += 4
    }
    if !commands.isEmpty {
      let point = { (offset: Int) in
        CGPoint(
          x: cell.minX + CGFloat(self.commands[offset]) * cell.width,
          y: cell.minY + CGFloat(self.commands[offset + 1]) * cell.height)
      }
      let path = CGMutablePath()
      index = 0
      while index < commands.count {
        switch Int(commands[index]) {
        case 0:
          path.move(to: point(index + 1))
          index += 3
        case 1:
          path.addLine(to: point(index + 1))
          index += 3
        case 2:
          path.addQuadCurve(to: point(index + 3), control: point(index + 1))
          index += 5
        default:
          index = commands.count
        }
      }
      context.setStrokeColor(color)
      context.setLineWidth(strokeWidth)
      context.setLineCap(.butt)
      context.setLineJoin(.miter)
      context.addPath(path)
      context.strokePath()
    }
    context.restoreGState()
  }
}

final class TerminalCustomGlyphs {
  static let empty = TerminalCustomGlyphs([])
  private let glyphs: [String: TerminalCustomGlyph]

  init(_ records: [TerminalCustomGlyphRecord]) {
    var glyphs: [String: TerminalCustomGlyph] = [:]
    for record in records { glyphs[record.char] = TerminalCustomGlyph(record) }
    self.glyphs = glyphs
  }

  subscript(text: String) -> TerminalCustomGlyph? { glyphs[text] }
}
