/**
 * Terminal toolbar — displays terminal title and action buttons.
 *
 * Used at the top of the terminal page.
 */

import { PaseoTheme } from '../common/theme';
import { Icons } from '../common/icons';

@Component
export struct TerminalToolbar {
  @Prop title: string = 'Terminal';
  @Prop isConnected: boolean = false;
  onBack: () => void = () => {};
  onClear: () => void = () => {};

  build() {
    Row() {
      Button(Icons.BACK)
        .fontSize(PaseoTheme.fontSizeLG)
        .fontColor(PaseoTheme.textSecondary)
        .backgroundColor(Color.Transparent)
        .width(40)
        .height(40)
        .onClick(() => { this.onBack(); });

      Text(this.title)
        .fontSize(PaseoTheme.fontSizeMD)
        .fontWeight(FontWeight.Medium)
        .fontColor(PaseoTheme.textPrimary)
        .layoutWeight(1)
        .margin({ left: PaseoTheme.spaceSM })
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis });

      // Connection dot
      Text(this.isConnected ? Icons.CONNECTED : Icons.DISCONNECTED)
        .fontSize(8)
        .fontColor(this.isConnected ? PaseoTheme.accent : PaseoTheme.textTertiary)
        .margin({ right: PaseoTheme.spaceMD });

      // Clear button
      Button(Icons.CLOSE)
        .fontSize(PaseoTheme.fontSizeSM)
        .fontColor(PaseoTheme.textSecondary)
        .backgroundColor(Color.Transparent)
        .width(36)
        .height(36)
        .onClick(() => { this.onClear(); });
    }
    .width('100%')
    .height(48)
    .padding({ left: PaseoTheme.spaceSM, right: PaseoTheme.spaceSM })
    .backgroundColor(PaseoTheme.bgSecondary);
  }
}
