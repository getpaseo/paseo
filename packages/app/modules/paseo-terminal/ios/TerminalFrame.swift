import CoreGraphics
import ExpoModulesCore

struct TerminalCursorRecord: Record {
  @Field var row: Int = 0
  @Field var col: Int = 0
}

struct TerminalSelectionRecord: Record {
  @Field var startRow: Int = 0
  @Field var startCol: Int = 0
  @Field var endRow: Int = 0
  @Field var endCol: Int = 0
}

struct TerminalFrameRecord: Record {
  @Field var columns: Int = 0
  /// Encoded rows, `cells;styles;text`; see `frame-encoding.ts`.
  @Field var rows: [String] = []
  @Field var cursor: TerminalCursorRecord? = nil
  @Field var selection: TerminalSelectionRecord? = nil
}

struct TerminalThemeRecord: Record {
  @Field var background: Double = 0
  @Field var cursor: Double = 0
  @Field var selectionBackground: Double = 0
  @Field var selectionForeground: Double = 0
}

struct TerminalCustomGlyphRecord: Record {
  @Field var char: String = ""
  @Field var rects: [Double] = []
  @Field var path: [Double] = []
  @Field var strokeWidth: Double = 0
}

enum TerminalStyleFlags {
  static let bold = 1
  static let italic = 2
  static let underline = 4
  static let strikethrough = 8
}

/// JS sends colors as unsigned ARGB numbers.
struct TerminalColor: Equatable {
  let argb: UInt32

  init(_ value: Double) {
    argb = UInt32(truncatingIfNeeded: Int64(value))
  }

  var isPainted: Bool { argb >> 24 != 0 }

  func cgColor(alphaScale: CGFloat = 1) -> CGColor {
    let channel = { (shift: UInt32) in CGFloat((argb >> shift) & 0xff) / 255 }
    return CGColor(srgbRed: channel(16), green: channel(8), blue: channel(0), alpha: channel(24) * alphaScale)
  }
}

/// One row as the caller described it: cell text, column spans and style spans.
struct TerminalRowSource {
  let text: String
  let cells: [Int]
  let styles: [Double]

  /// Decodes `cells;styles;text`, where both number lists are comma separated.
  init(encoded: String) {
    let utf8 = encoded.utf8
    let separator = UInt8(ascii: ";")
    let cellsEnd = utf8.firstIndex(of: separator) ?? utf8.endIndex
    let stylesStart = cellsEnd == utf8.endIndex ? cellsEnd : utf8.index(after: cellsEnd)
    let stylesEnd = utf8[stylesStart...].firstIndex(of: separator) ?? utf8.endIndex
    let textStart = stylesEnd == utf8.endIndex ? stylesEnd : utf8.index(after: stylesEnd)
    cells = TerminalRowSource.parseNumbers(utf8[utf8.startIndex..<cellsEnd]).map { Int($0) }
    styles = TerminalRowSource.parseNumbers(utf8[stylesStart..<stylesEnd]).map { Double($0) }
    text = String(encoded[textStart...])
  }

  private static func parseNumbers(_ bytes: Substring.UTF8View) -> [Int64] {
    guard !bytes.isEmpty else { return [] }
    var numbers: [Int64] = [0]
    for byte in bytes {
      if byte == UInt8(ascii: ",") {
        numbers.append(0)
      } else {
        numbers[numbers.count - 1] = numbers[numbers.count - 1] * 10 + Int64(byte - UInt8(ascii: "0"))
      }
    }
    return numbers
  }
}

struct TerminalSelection: Equatable {
  let startRow: Int
  let startCol: Int
  let endRow: Int
  let endCol: Int

  init(_ record: TerminalSelectionRecord) {
    startRow = record.startRow
    startCol = record.startCol
    endRow = record.endRow
    endCol = record.endCol
  }

  func intersects(row: Int) -> Bool { row >= startRow && row <= endRow }

  /// A cell is selected when any column it covers is inside the inclusive range.
  func contains(row: Int, col: Int, span: Int) -> Bool {
    guard intersects(row: row) else { return false }
    let firstCol = row == startRow ? startCol : 0
    let lastCol = row == endRow ? endCol : Int.max
    return col + span - 1 >= firstCol && col <= lastCol
  }

  /// The part of the selection on one row, so a row only repaints when its own part changes.
  func columns(onRow row: Int) -> ClosedRange<Int>? {
    guard intersects(row: row) else { return nil }
    return (row == startRow ? startCol : 0)...(row == endRow ? endCol : Int.max)
  }
}
