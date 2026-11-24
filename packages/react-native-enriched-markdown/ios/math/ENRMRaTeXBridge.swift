import Foundation
import CoreGraphics
import CoreText
// RaTeX's core Swift sources (RaTeXEngine/RaTeXRenderer/RaTeXFontLoader/DisplayList) are
// vendored into this pod's own module (ios/vendor), so there is no external RaTeX module
// to import; they resolve as same-module symbols. The vendored files import the RaTeXFFI
// binary module from the XCFramework themselves.

#if canImport(UIKit)
import UIKit
#elseif canImport(AppKit)
import AppKit
private typealias UIColor = NSColor
#endif

@objc(ENRMRaTeXRenderResult)
public final class ENRMRaTeXRenderResult: NSObject {
  private let renderer: RaTeXRenderer

  @objc public let width: CGFloat
  @objc public let ascent: CGFloat
  @objc public let descent: CGFloat
  @objc public var totalHeight: CGFloat { ascent + descent }

  init(renderer: RaTeXRenderer) {
    self.renderer = renderer
    self.width = renderer.width
    self.ascent = renderer.height
    self.descent = renderer.depth
    super.init()
  }

  @objc public func draw(in context: CGContext) {
    renderer.draw(in: context)
  }
}

@objc(ENRMRaTeXBridge)
public final class ENRMRaTeXBridge: NSObject {

  @objc public static func ensureFontsLoaded() {
    RaTeXFontLoader.ensureLoaded()
  }

  @objc public static func parse(
    _ latex: String,
    displayMode: Bool,
    fontSize: CGFloat,
    color: UIColor
  ) -> ENRMRaTeXRenderResult? {
    parse(latex, displayMode: displayMode, fontSize: fontSize, color: color, error: nil)
  }

  @objc(parse:displayMode:fontSize:color:error:)
  public static func parse(
    _ latex: String,
    displayMode: Bool,
    fontSize: CGFloat,
    color: UIColor,
    error: NSErrorPointer
  ) -> ENRMRaTeXRenderResult? {
    RaTeXFontLoader.ensureLoaded()
    do {
      let displayList = try RaTeXEngine.shared.parse(latex, displayMode: displayMode, color: color)
      let renderer = RaTeXRenderer(displayList: displayList, fontSize: fontSize)
      return ENRMRaTeXRenderResult(renderer: renderer)
    } catch let parseError {
      NSLog("[RaTeX] Failed to parse LaTeX: %@", parseError.localizedDescription)
      error?.pointee = parseError as NSError
      return nil
    }
  }
}
