/**
 * Tool call card — expandable card showing a tool invocation.
 *
 * Displays the tool name, status indicator, and expandable detail section.
 * Used in the message list for tool_call items.
 */

import { PaseoTheme } from '../common/theme';
import { Icons } from '../common/icons';

@Component
export struct ToolCallCard {
  @Prop name: string = '';
  @Prop status: string = 'running';
  @Prop detail: ESObject = {} as Record<string, Object>;
  @State isExpanded: boolean = false;

  /** Display name — capitalize and replace underscores. */
  get displayName(): string {
    return this.name
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  /** Status badge text. */
  get statusLabel(): string {
    switch (this.status) {
      case 'running': return 'Running';
      case 'completed': return 'Done';
      case 'failed': return 'Failed';
      case 'canceled': return 'Canceled';
      default: return this.status;
    }
  }

  get statusColor(): string {
    switch (this.status) {
      case 'running': return PaseoTheme.warning;
      case 'completed': return PaseoTheme.accent;
      case 'failed': return PaseoTheme.danger;
      case 'canceled': return PaseoTheme.textTertiary;
      default: return PaseoTheme.textSecondary;
    }
  }

  get detailPreview(): string {
    // Show a truncated preview of the detail object
    const str = JSON.stringify(this.detail, null, 0);
    return str.length > 120 ? str.slice(0, 120) + '…' : str;
  }

  toggle(): void {
    this.isExpanded = !this.isExpanded;
  }

  build() {
    Column() {
      // ---- Header row ----
      Row() {
        // Tool icon
        Text(Icons.TOOL)
          .fontSize(PaseoTheme.fontSizeSM)
          .margin({ right: PaseoTheme.spaceSM });

        // Tool name
        Text(this.displayName)
          .fontSize(PaseoTheme.fontSizeSM)
          .fontWeight(FontWeight.Medium)
          .fontColor(PaseoTheme.textPrimary)
          .layoutWeight(1);

        // Status badge
        Text(this.statusLabel)
          .fontSize(PaseoTheme.fontSizeXS)
          .fontColor(this.statusColor)
          .padding({
            left: PaseoTheme.spaceSM,
            right: PaseoTheme.spaceSM,
            top: 2,
            bottom: 2,
          })
          .backgroundColor(this.statusColor + '1A') // 10% opacity
          .borderRadius(PaseoTheme.radiusFull);

        // Expand chevron
        Text(this.isExpanded ? Icons.CHEVRON_DOWN : Icons.CHEVRON_RIGHT)
          .fontSize(PaseoTheme.fontSizeXS)
          .fontColor(PaseoTheme.textTertiary)
          .margin({ left: PaseoTheme.spaceSM });
      }
      .width('100%')
      .padding({
        left: PaseoTheme.spaceMD,
        right: PaseoTheme.spaceMD,
        top: PaseoTheme.spaceSM,
        bottom: this.isExpanded ? 0 : PaseoTheme.spaceSM,
      })
      .onClick(() => { this.toggle(); });

      // ---- Expanded detail ----
      if (this.isExpanded) {
        Text(this.detailPreview)
          .fontSize(PaseoTheme.fontSizeXS)
          .fontFamily(PaseoTheme.fontMono)
          .fontColor(PaseoTheme.textSecondary)
          .width('100%')
          .padding({
            left: PaseoTheme.spaceLG,
            right: PaseoTheme.spaceMD,
            top: PaseoTheme.spaceSM,
            bottom: PaseoTheme.spaceMD,
          });
      }
    }
    .width('100%')
    .backgroundColor(PaseoTheme.bgTertiary)
    .borderRadius(PaseoTheme.radiusMD)
    .border({ width: 1, color: PaseoTheme.border })
    .margin({ top: PaseoTheme.spaceXS, bottom: PaseoTheme.spaceXS });
  }
}
