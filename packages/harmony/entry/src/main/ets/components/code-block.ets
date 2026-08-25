/**
 * Code block component.
 *
 * Renders a fenced code block with syntax highlighting (via @getpaseo/highlight)
 * and a copy button. Used inside markdown-block for ``` fences and diffs.
 */

import { PaseoTheme } from '../common/theme';
import { Icons } from '../common/icons';
import { pasteboard } from '@kit.BasicServicesKit';

// Highlight will be lazily referenced. For Phase 1, we render code as
// plain text with a monospace font and language tag. Syntax highlighting
// colors are applied in Phase 2 via @getpaseo/highlight integration.

@Component
export struct CodeBlock {
  @Prop code: string = '';
  @Prop language: string = '';
  @State showCopyIcon: boolean = false;
  @State copyLabel: string = 'Copy';

  handleCopy(): void {
    try {
      const pasteData = pasteboard.createData(pasteboard.MIMETYPE_TEXT_PLAIN, this.code);
      pasteboard.getSystemPasteboard().setData(pasteData);
      this.copyLabel = 'Copied!';
      setTimeout(() => {
        this.copyLabel = 'Copy';
      }, 2000);
    } catch (_e) {
      // Clipboard might not be available
    }
  }

  build() {
    Column() {
      // ---- Header bar: language tag + copy ----
      Row() {
        Text(this.language || 'code')
          .fontSize(PaseoTheme.fontSizeXS)
          .fontColor(PaseoTheme.textTertiary)
          .fontFamily(PaseoTheme.fontMono);

        Blank();

        Button(this.copyLabel)
          .fontSize(PaseoTheme.fontSizeXS)
          .fontColor(PaseoTheme.textSecondary)
          .backgroundColor(Color.Transparent)
          .padding({ left: PaseoTheme.spaceSM, right: PaseoTheme.spaceSM })
          .onClick(() => { this.handleCopy(); });
      }
      .width('100%')
      .padding({
        left: PaseoTheme.spaceMD,
        right: PaseoTheme.spaceSM,
        top: PaseoTheme.spaceSM,
        bottom: PaseoTheme.spaceXS,
      });

      // ---- Divider ----
      Divider()
        .color(PaseoTheme.border)
        .width('100%')
        .height(1);

      // ---- Code content ----
      Scroll() {
        Text(this.code)
          .fontSize(PaseoTheme.fontSizeSM)
          .fontColor(PaseoTheme.textPrimary)
          .fontFamily(PaseoTheme.fontMono)
          .padding(PaseoTheme.spaceMD)
          .lineHeight(PaseoTheme.terminalFontSize * PaseoTheme.terminalLineHeight);
      }
      .scrollable(ScrollDirection.Horizontal)
      .scrollBar(BarState.Auto);
    }
    .width('100%')
    .backgroundColor(PaseoTheme.codeBg)
    .borderRadius(PaseoTheme.radiusMD)
    .border({ width: 1, color: PaseoTheme.border })
    .margin({ top: PaseoTheme.spaceSM, bottom: PaseoTheme.spaceSM });
  }
}
