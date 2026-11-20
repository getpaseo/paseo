import ExpoModulesCore

public class PaseoTerminalModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PaseoTerminal")

    View(PaseoTerminalView.self) {
      Events("onCellMetrics")

      Prop("frame") { (view: PaseoTerminalView, frame: TerminalFrameRecord) in view.setFrame(frame) }
      Prop("theme") { (view: PaseoTerminalView, theme: TerminalThemeRecord) in view.setTheme(theme) }
      Prop("fontFamily") { (view: PaseoTerminalView, family: String) in view.setFontFamily(family) }
      Prop("fontSize") { (view: PaseoTerminalView, size: Double) in view.setFontSize(size) }
      Prop("customGlyphs") { (view: PaseoTerminalView, glyphs: [TerminalCustomGlyphRecord]) in
        view.setCustomGlyphs(glyphs)
      }

      OnViewDidUpdateProps { (view: PaseoTerminalView) in view.commit() }
    }
  }
}
