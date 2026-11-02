package sh.paseo.terminal

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PaseoTerminalModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PaseoTerminal")

    View(PaseoTerminalView::class) {
      Events("onCellMetrics")

      Prop("frame") { view: PaseoTerminalView, frame: TerminalFrameRecord -> view.setFrame(frame) }
      Prop("theme") { view: PaseoTerminalView, theme: TerminalThemeRecord -> view.setTheme(theme) }
      Prop("fontFamily") { view: PaseoTerminalView, family: String -> view.setFontFamily(family) }
      Prop("fontSize") { view: PaseoTerminalView, size: Double -> view.setFontSize(size) }
      Prop("customGlyphs") { view: PaseoTerminalView, glyphs: List<TerminalCustomGlyphRecord> ->
        view.setCustomGlyphs(glyphs)
      }

      OnViewDidUpdateProps { view: PaseoTerminalView -> view.commit() }
    }
  }
}
