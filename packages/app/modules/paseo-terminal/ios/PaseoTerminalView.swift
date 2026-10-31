import ExpoModulesCore
import UIKit

private let minCachedRows = 256
private let cursorAlpha: CGFloat = 0.45

/// Paints terminal frames on the cell grid. Row shaping is cached by row content, and a frame
/// repaints only the rows whose layout, selection or cursor changed. A row's glyphs may ink outside
/// the row, so a repaint covers the old and new row's ink and redraws every row whose ink it meets.
final class PaseoTerminalView: ExpoView {
  let onCellMetrics = EventDispatcher()

  private var fontFamily = "Menlo"
  private var fontSize: CGFloat = 12
  private var font: TerminalFont?
  private var customGlyphs = TerminalCustomGlyphs.empty
  private var frameRecord: TerminalFrameRecord?
  private var frameChanged = false

  private var rows: [TerminalRowLayout] = []
  private var columns = 0
  private var cursor: (row: Int, col: Int)?
  private var selection: TerminalSelection?
  private var background = TerminalColor(Double(0xff00_0000))
  private var cursorColor = TerminalColor(Double(0xffff_ffff))
  private var rowPaint = TerminalRowPaint(
    selectionBackground: TerminalColor(Double(0xffff_ff00)),
    selectionForeground: TerminalColor(Double(0xff00_0000)))
  private var rowCache: [String: TerminalRowLayout] = [:]

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    isOpaque = true
    contentMode = .redraw
    isAccessibilityElement = false
  }

  func setFrame(_ record: TerminalFrameRecord) {
    frameRecord = record
    frameChanged = true
  }

  func setTheme(_ record: TerminalThemeRecord) {
    background = TerminalColor(record.background)
    cursorColor = TerminalColor(record.cursor)
    rowPaint = TerminalRowPaint(
      selectionBackground: TerminalColor(record.selectionBackground),
      selectionForeground: TerminalColor(record.selectionForeground))
    backgroundColor = UIColor(cgColor: background.cgColor())
    setNeedsDisplay()
  }

  func setFontFamily(_ value: String) { fontFamily = value }

  func setFontSize(_ value: Double) { fontSize = CGFloat(value) }

  func setCustomGlyphs(_ records: [TerminalCustomGlyphRecord]) {
    customGlyphs = TerminalCustomGlyphs(records)
    rowCache.removeAll()
    rows = []
    frameChanged = true
  }

  /// Applies a batch of prop updates: font first, then the frame laid out with it.
  func commit() {
    let displayScale = traitCollection.displayScale > 0 ? traitCollection.displayScale : UIScreen.main.scale
    if font?.sameAs(family: fontFamily, size: fontSize, displayScale: displayScale) != true {
      let next = TerminalFont(family: fontFamily, size: fontSize, displayScale: displayScale)
      font = next
      rowCache.removeAll()
      rows = []
      frameChanged = true
      onCellMetrics(["cellWidth": next.cellWidth, "cellHeight": next.cellHeight])
      setNeedsDisplay()
    }
    if frameChanged {
      frameChanged = false
      layoutFrame()
    }
  }

  override func traitCollectionDidChange(_ previous: UITraitCollection?) {
    super.traitCollectionDidChange(previous)
    if previous?.displayScale != traitCollection.displayScale { commit() }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    setNeedsDisplay()
  }

  private func layoutFrame() {
    guard let font, let record = frameRecord else { return }
    let previousRows = rows
    let previousSelection = selection
    let previousCursor = cursor
    let previousColumns = columns

    columns = record.columns
    cursor = record.cursor.map { ($0.row, $0.col) }
    selection = record.selection.map(TerminalSelection.init)
    rows = record.rows.map { encoded in
      if let cached = rowCache[encoded] { return cached }
      let layout = TerminalRowLayout(
        source: TerminalRowSource(encoded: encoded), font: font, customGlyphs: customGlyphs)
      rowCache[encoded] = layout
      return layout
    }
    trimRowCache(keeping: record.rows)
    updateAccessibility()

    if previousColumns != columns || previousRows.count != rows.count {
      setNeedsDisplay()
      return
    }
    for index in rows.indices {
      let layoutChanged = previousRows[index] !== rows[index]
      let selectionChanged = previousSelection?.columns(onRow: index) != selection?.columns(onRow: index)
      let cursorChanged =
        (previousCursor?.row == index || cursor?.row == index)
        && (previousCursor?.row != cursor?.row || previousCursor?.col != cursor?.col)
      if layoutChanged || selectionChanged || cursorChanged {
        let previous = paintedRect(previousRows[index], at: index, font: font)
        setNeedsDisplay(previous.union(paintedRect(rows[index], at: index, font: font)))
      }
    }
  }

  /// The area row `index` paints, including glyph ink outside the row.
  private func paintedRect(_ row: TerminalRowLayout, at index: Int, font: TerminalFont) -> CGRect {
    let top = CGFloat(index) * font.cellHeight
    return CGRect(x: 0, y: top + row.inkTop, width: bounds.width, height: row.inkBottom - row.inkTop)
  }

  private func trimRowCache(keeping currentRows: [String]) {
    guard rowCache.count > max(minCachedRows, rows.count * 2) else { return }
    let current = Set(currentRows)
    rowCache = rowCache.filter { current.contains($0.key) }
  }

  override func draw(_ rect: CGRect) {
    guard let context = UIGraphicsGetCurrentContext() else { return }
    context.setFillColor(background.cgColor())
    context.fill(rect)
    guard let font else { return }
    let gridWidth = CGFloat(columns) * font.cellWidth
    context.saveGState()
    context.clip(to: CGRect(x: 0, y: 0, width: min(bounds.width, gridWidth), height: bounds.height))
    for (index, row) in rows.enumerated() where paintedRect(row, at: index, font: font).intersects(rect) {
      row.draw(in: context, row: index, top: CGFloat(index) * font.cellHeight, selection: selection, paint: rowPaint)
    }
    if let cursor {
      context.setFillColor(cursorColor.cgColor(alphaScale: cursorAlpha))
      context.fill(CGRect(
        x: CGFloat(cursor.col) * font.cellWidth, y: CGFloat(cursor.row) * font.cellHeight,
        width: font.cellWidth, height: font.cellHeight))
    }
    context.restoreGState()
  }

  /// Exposes each non-blank row as a static text element, `terminal-row-<index>`.
  private func updateAccessibility() {
    guard let font else { return }
    var elements: [UIAccessibilityElement] = []
    for (index, row) in rows.enumerated() {
      let label = row.accessibilityText
      guard !label.isEmpty else { continue }
      let element = UIAccessibilityElement(accessibilityContainer: self)
      element.accessibilityIdentifier = "terminal-row-\(index)"
      element.accessibilityLabel = label
      element.accessibilityTraits = .staticText
      element.accessibilityFrameInContainerSpace = CGRect(
        x: 0, y: CGFloat(index) * font.cellHeight,
        width: min(bounds.width, CGFloat(columns) * font.cellWidth), height: font.cellHeight)
      elements.append(element)
    }
    accessibilityElements = elements
  }
}
