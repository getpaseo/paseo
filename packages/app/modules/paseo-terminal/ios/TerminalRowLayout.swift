import CoreText
import UIKit

/// Shaped glyphs may exceed their slot by this many points before they are scaled down.
private let overflowTolerance: CGFloat = 0.5
/// Stands in for an open edge when a group is clipped on one side only.
private let clipUnbounded: CGFloat = 100_000

/// Lays text out left to right in logical order. The override fixes every character's direction;
/// the base direction also covers trailing spaces, which bidi rule L1 otherwise moves to the
/// direction detected from the first strong character, ahead of an Arabic or Hebrew row.
private let leftToRightAttributes: [NSAttributedString.Key: Any] = {
  var base = CTWritingDirection.leftToRight
  let paragraph = withUnsafeBytes(of: &base) { bytes in
    CTParagraphStyleCreate(
      [CTParagraphStyleSetting(
        spec: .baseWritingDirection, valueSize: MemoryLayout<CTWritingDirection>.size, value: bytes.baseAddress!)],
      1)
  }
  let overrideLeftToRight = CTWritingDirection.leftToRight.rawValue | 2  // kCTWritingDirectionOverride
  return [
    NSAttributedString.Key(kCTWritingDirectionAttributeName as String): [NSNumber(value: overrideLeftToRight)],
    NSAttributedString.Key(kCTParagraphStyleAttributeName as String): paragraph,
  ]
}()

/// Colors a row is painted with besides its own styles.
struct TerminalRowPaint {
  let selectionBackground: TerminalColor
  let selectionForeground: TerminalColor
}

/// One row shaped once and placed on the terminal grid.
///
/// Each run of cells with the same font face is shaped as a whole line, in logical order and left
/// to right like the terminal grid, so contextual forms, ligatures, marks and fallback fonts see
/// their neighbours. CoreText reports which UTF-16 offset produced each glyph. Cells whose units
/// produced no advancing glyph, and cells a reordered glyph crosses, join the cluster of the cell
/// before them: a ligature, conjunct, emoji sequence or reordered mark that spans columns. Each
/// group is drawn at its first cell's column with the glyph offsets CoreText produced, centred in
/// the columns it owns and scaled down only when wider than them. Colors never split groups.
final class TerminalRowLayout {
  let source: TerminalRowSource
  private let font: TerminalFont
  private let units: [UInt16]
  private let cellCount: Int
  private var cellCol: [Int]
  private var cellSpan: [Int]
  private var cellStart: [Int]
  private var cellEnd: [Int]
  private var cellForeground: [TerminalColor]
  private var cellBackground: [TerminalColor]
  private var cellFlags: [Int]
  private var cellGlyph: [TerminalCustomGlyph?]
  private var groups: [Group] = []
  /// The row's painted extent, relative to its top edge. Marks stacked above or below a
  /// letter and some fallback glyphs ink outside the row; the view repaints that area with it.
  private(set) var inkTop: CGFloat = 0
  private(set) var inkBottom: CGFloat

  private struct GlyphRun {
    let font: CTFont
    var glyphs: [CGGlyph]
    /// Relative to the group's pen origin, y up from the baseline.
    var positions: [CGPoint]
  }

  private struct Group {
    let firstCell: Int
    let lastCell: Int
    let col: Int
    let offset: CGFloat
    let scale: CGFloat
    let runs: [GlyphRun]
  }

  private struct ShapedGlyph {
    let font: CTFont
    let glyph: CGGlyph
    let position: CGPoint
    let advance: CGFloat
    let cell: Int
  }

  init(source: TerminalRowSource, font: TerminalFont, customGlyphs: TerminalCustomGlyphs) {
    self.source = source
    self.font = font
    units = Array(source.text.utf16)
    cellCount = source.cells.count / 2
    cellCol = Array(repeating: 0, count: cellCount)
    cellSpan = Array(repeating: 1, count: cellCount)
    cellStart = Array(repeating: 0, count: cellCount)
    cellEnd = Array(repeating: 0, count: cellCount)
    cellForeground = Array(repeating: TerminalColor(0), count: cellCount)
    cellBackground = Array(repeating: TerminalColor(0), count: cellCount)
    cellFlags = Array(repeating: 0, count: cellCount)
    cellGlyph = Array(repeating: nil, count: cellCount)
    inkBottom = font.cellHeight
    readCells(customGlyphs: customGlyphs)
    shapeRuns()
  }

  var accessibilityText: String {
    var text = source.text
    while text.last == " " { text.removeLast() }
    return text
  }

  private func readCells(customGlyphs: TerminalCustomGlyphs) {
    var offset = 0
    var col = 0
    var styleIndex = 0
    var styleEndCol = 0
    for cell in 0..<cellCount {
      let length = source.cells[cell * 2]
      let span = max(1, source.cells[cell * 2 + 1])
      while col >= styleEndCol && styleIndex + 3 < source.styles.count {
        styleEndCol += Int(source.styles[styleIndex])
        styleIndex += 4
      }
      let style = styleIndex - 4
      if style >= 0 {
        cellForeground[cell] = TerminalColor(source.styles[style + 1])
        cellBackground[cell] = TerminalColor(source.styles[style + 2])
        cellFlags[cell] = Int(source.styles[style + 3])
      }
      cellCol[cell] = col
      cellSpan[cell] = span
      cellStart[cell] = offset
      cellEnd[cell] = min(units.count, offset + length)
      cellGlyph[cell] = customGlyphs[text(from: cellStart[cell], to: cellEnd[cell])]
      offset = cellEnd[cell]
      col += span
    }
  }

  private func text(from start: Int, to end: Int) -> String {
    String(utf16CodeUnits: Array(units[start..<end]), count: end - start)
  }

  private func shapesWith(_ cell: Int, _ other: Int) -> Bool {
    cellGlyph[cell] == nil && cellGlyph[other] == nil
      && TerminalFont.face(flags: cellFlags[cell]) == TerminalFont.face(flags: cellFlags[other])
  }

  private func shapeRuns() {
    var cell = 0
    while cell < cellCount {
      if cellGlyph[cell] != nil {
        cell += 1
        continue
      }
      var last = cell
      while last + 1 < cellCount && shapesWith(cell, last + 1) { last += 1 }
      shapeRun(first: cell, last: last)
      cell = last + 1
    }
  }

  private func shapeRun(first: Int, last: Int) {
    let start = cellStart[first]
    let end = cellEnd[last]
    guard end > start else { return }
    var cellOfUnit = Array(repeating: first, count: end - start)
    for cell in first...last where cellEnd[cell] > cellStart[cell] {
      for unit in cellStart[cell]..<cellEnd[cell] { cellOfUnit[unit - start] = cell }
    }

    var attributes = leftToRightAttributes
    attributes[NSAttributedString.Key(kCTFontAttributeName as String)] = font.font(flags: cellFlags[first])
    let line = CTLineCreateWithAttributedString(
      NSAttributedString(string: text(from: start, to: end), attributes: attributes))

    var shaped: [ShapedGlyph] = []
    for run in CTLineGetGlyphRuns(line) as? [CTRun] ?? [] {
      let count = CTRunGetGlyphCount(run)
      guard count > 0 else { continue }
      let runAttributes = CTRunGetAttributes(run) as NSDictionary
      let runFont = runAttributes[kCTFontAttributeName as String].map { $0 as! CTFont }
        ?? font.font(flags: cellFlags[first])
      var glyphs = Array(repeating: CGGlyph(0), count: count)
      var positions = Array(repeating: CGPoint.zero, count: count)
      var advances = Array(repeating: CGSize.zero, count: count)
      var indices = Array(repeating: CFIndex(0), count: count)
      let all = CFRange(location: 0, length: 0)
      CTRunGetGlyphs(run, all, &glyphs)
      CTRunGetPositions(run, all, &positions)
      CTRunGetAdvances(run, all, &advances)
      CTRunGetStringIndices(run, all, &indices)
      for index in 0..<count {
        let unit = min(max(0, indices[index]), cellOfUnit.count - 1)
        shaped.append(ShapedGlyph(
          font: runFont, glyph: glyphs[index], position: positions[index],
          advance: advances[index].width, cell: cellOfUnit[unit]))
      }
    }

    // A cell starts a cluster unless a reordered glyph crosses into it or it has no advance.
    var startsCluster = Array(repeating: true, count: last - first + 1)
    var advance = Array(repeating: CGFloat(0), count: last - first + 1)
    var furthestCell = first
    for glyph in shaped {
      advance[glyph.cell - first] += glyph.advance
      if glyph.cell < furthestCell {
        for cell in (glyph.cell + 1)...furthestCell { startsCluster[cell - first] = false }
      } else {
        furthestCell = glyph.cell
      }
    }
    if last > first {
      for cell in (first + 1)...last where advance[cell - first] == 0 {
        startsCluster[cell - first] = false
      }
    }

    var groupFirst = first
    for cell in first...last {
      let closesGroup = cell == last || startsCluster[cell + 1 - first]
      guard closesGroup else { continue }
      addGroup(first: groupFirst, last: cell, glyphs: shaped.filter { $0.cell >= groupFirst && $0.cell <= cell })
      groupFirst = cell + 1
    }
  }

  private func addGroup(first: Int, last: Int, glyphs: [ShapedGlyph]) {
    let isBlank = (cellStart[first]..<cellEnd[last]).allSatisfy { units[$0] == 0x20 }
    guard let origin = glyphs.first?.position.x, !isBlank else { return }
    let columns = (first...last).reduce(0) { $0 + cellSpan[$1] }
    let slot = CGFloat(columns) * font.cellWidth
    let advance = glyphs.reduce(CGFloat(0)) { $0 + $1.advance }
    let scale = advance > slot + overflowTolerance ? slot / advance : 1
    let offset = scale < 1 ? 0 : (slot - advance) / 2
    var runs: [GlyphRun] = []
    for glyph in glyphs {
      let position = CGPoint(x: glyph.position.x - origin, y: glyph.position.y)
      if let lastRun = runs.last, CFEqual(lastRun.font, glyph.font) {
        runs[runs.count - 1].glyphs.append(glyph.glyph)
        runs[runs.count - 1].positions.append(position)
      } else {
        runs.append(GlyphRun(font: glyph.font, glyphs: [glyph.glyph], positions: [position]))
      }
    }
    groups.append(Group(
      firstCell: first, lastCell: last, col: cellCol[first], offset: offset, scale: scale, runs: runs))
    extendInk(runs: runs, scale: scale)
  }

  /// Grows the row's ink extent to cover the glyphs as `draw` places them, padded by a device pixel
  /// for antialiasing.
  private func extendInk(runs: [GlyphRun], scale: CGFloat) {
    let centerY = font.cellHeight / 2
    let baselineInTextSpace = font.cellHeight / 2 - font.baseline
    let pixel = 1 / font.displayScale
    for run in runs {
      var bounds = Array(repeating: CGRect.zero, count: run.glyphs.count)
      CTFontGetBoundingRectsForGlyphs(run.font, .horizontal, run.glyphs, &bounds, run.glyphs.count)
      for (glyph, position) in zip(bounds, run.positions) where !glyph.isEmpty {
        let top = centerY - (position.y + baselineInTextSpace + glyph.maxY) * scale - pixel
        let bottom = centerY - (position.y + baselineInTextSpace + glyph.minY) * scale + pixel
        inkTop = min(inkTop, (top * font.displayScale).rounded(.down) / font.displayScale)
        inkBottom = max(inkBottom, (bottom * font.displayScale).rounded(.up) / font.displayScale)
      }
    }
  }

  private func isSelected(_ cell: Int, row: Int, selection: TerminalSelection?) -> Bool {
    selection?.contains(row: row, col: cellCol[cell], span: cellSpan[cell]) ?? false
  }

  private func foreground(_ cell: Int, row: Int, selection: TerminalSelection?, paint: TerminalRowPaint) -> TerminalColor {
    isSelected(cell, row: row, selection: selection) ? paint.selectionForeground : cellForeground[cell]
  }

  /// Draws the row with its top edge at `top`, selected cells in selection colors.
  func draw(in context: CGContext, row: Int, top: CGFloat, selection: TerminalSelection?, paint: TerminalRowPaint) {
    let cellWidth = font.cellWidth
    let cellHeight = font.cellHeight
    for cell in 0..<cellCount {
      let background = isSelected(cell, row: row, selection: selection) ? paint.selectionBackground : cellBackground[cell]
      guard background.isPainted else { continue }
      context.setFillColor(background.cgColor())
      context.fill(CGRect(x: CGFloat(cellCol[cell]) * cellWidth, y: top, width: CGFloat(cellSpan[cell]) * cellWidth, height: cellHeight))
    }

    let centerY = top + cellHeight / 2
    let baselineInTextSpace = cellHeight / 2 - font.baseline
    // A group whose cells differ in color or selection is drawn once per color, clipped to those
    // cells' columns. Only edges between differently colored cells clip; outer edges may overhang.
    for group in groups {
      var first = group.firstCell
      while first <= group.lastCell {
        let color = foreground(first, row: row, selection: selection, paint: paint)
        var last = first
        while last < group.lastCell && foreground(last + 1, row: row, selection: selection, paint: paint) == color {
          last += 1
        }
        context.saveGState()
        if first > group.firstCell || last < group.lastCell {
          let left = first > group.firstCell ? CGFloat(cellCol[first]) * cellWidth : -clipUnbounded
          let right = last < group.lastCell ? CGFloat(cellCol[last] + cellSpan[last]) * cellWidth : clipUnbounded
          context.clip(to: CGRect(x: left, y: -clipUnbounded, width: right - left, height: 2 * clipUnbounded))
        }
        context.setFillColor(color.cgColor())
        context.translateBy(x: CGFloat(group.col) * cellWidth + group.offset, y: centerY)
        context.scaleBy(x: group.scale, y: -group.scale)
        context.textMatrix = .identity
        for run in group.runs {
          let positions = run.positions.map { CGPoint(x: $0.x, y: $0.y + baselineInTextSpace) }
          CTFontDrawGlyphs(run.font, run.glyphs, positions, run.glyphs.count, context)
        }
        context.restoreGState()
        first = last + 1
      }
    }

    let baseline = top + font.baseline
    for cell in 0..<cellCount {
      let color = foreground(cell, row: row, selection: selection, paint: paint)
      let left = CGFloat(cellCol[cell]) * cellWidth
      let width = CGFloat(cellSpan[cell]) * cellWidth
      if let glyph = cellGlyph[cell] {
        glyph.draw(in: context, rect: CGRect(x: left, y: top, width: width, height: cellHeight), color: color.cgColor())
      }
      let flags = cellFlags[cell]
      if flags & (TerminalStyleFlags.underline | TerminalStyleFlags.strikethrough) == 0 { continue }
      context.setFillColor(color.cgColor())
      if flags & TerminalStyleFlags.underline != 0 {
        context.fill(CGRect(x: left, y: baseline + font.underlineOffset, width: width, height: font.underlineThickness))
      }
      if flags & TerminalStyleFlags.strikethrough != 0 {
        context.fill(CGRect(x: left, y: baseline + font.strikeOffset, width: width, height: font.strikeThickness))
      }
    }
  }
}
