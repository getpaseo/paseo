/**
 * Agent header — displays agent title, status, provider info.
 *
 * Used at the top of the agent page. Shows:
 * - Agent title (with a default or loading state)
 * - Status indicator with colored dot
 * - Provider + model label
 * - Back navigation and action buttons
 */

import { PaseoTheme } from '../common/theme';
import { Icons } from '../common/icons';
import type { AgentStatus } from '../models/agent-model';

@Component
export struct AgentHeader {
  @Prop title: string = 'Loading…';
  @Prop status: AgentStatus = 'idle';
  @Prop provider: string = '';
  @Prop model: string = '';
  onBack: () => void = () => {};
  onTerminal: () => void = () => {};
  onMenu: () => void = () => {};

  get statusColor(): string {
    switch (this.status) {
      case 'running':
      case 'initializing':
        return PaseoTheme.accent;
      case 'error':
        return PaseoTheme.danger;
      default:
        return PaseoTheme.textTertiary;
    }
  }

  get statusLabel(): string {
    switch (this.status) {
      case 'initializing': return 'Initializing';
      case 'idle': return 'Idle';
      case 'running': return 'Running';
      case 'error': return 'Error';
      case 'closed': return 'Closed';
      default: return '';
    }
  }

  build() {
    Row() {
      // Back
      Button(Icons.BACK)
        .fontSize(PaseoTheme.fontSizeLG)
        .fontColor(PaseoTheme.textSecondary)
        .backgroundColor(Color.Transparent)
        .width(40)
        .height(40)
        .onClick(() => { this.onBack(); });

      // Agent info
      Column() {
        // Title row
        Text(this.title)
          .fontSize(PaseoTheme.fontSizeMD)
          .fontWeight(FontWeight.Medium)
          .fontColor(PaseoTheme.textPrimary)
          .maxLines(1)
          .textOverflow({ overflow: TextOverflow.Ellipsis });

        // Status + provider row
        Row() {
          // Status dot
          Text(Icons.CONNECTED)
            .fontSize(8)
            .fontColor(this.statusColor)
            .margin({ right: PaseoTheme.spaceXS });

          Text(this.statusLabel)
            .fontSize(PaseoTheme.fontSizeXS)
            .fontColor(PaseoTheme.textSecondary);

          if (this.provider) {
            Text(' • ')
              .fontSize(PaseoTheme.fontSizeXS)
              .fontColor(PaseoTheme.textTertiary);

            Text(`${this.provider}${this.model ? ` / ${this.model}` : ''}`)
              .fontSize(PaseoTheme.fontSizeXS)
              .fontColor(PaseoTheme.textTertiary);
          }
        };
      }
      .alignItems(HorizontalAlign.Start)
      .margin({ left: PaseoTheme.spaceSM })
      .layoutWeight(1);

      // Terminal button
      Button(Icons.TERMINAL)
        .fontSize(PaseoTheme.fontSizeMD)
        .fontColor(PaseoTheme.textSecondary)
        .backgroundColor(Color.Transparent)
        .width(40)
        .height(40)
        .onClick(() => { this.onTerminal(); });

      // Menu
      Button(Icons.KEBAB)
        .fontSize(PaseoTheme.fontSizeLG)
        .fontColor(PaseoTheme.textSecondary)
        .backgroundColor(Color.Transparent)
        .width(40)
        .height(40)
        .onClick(() => { this.onMenu(); });
    }
    .width('100%')
    .height(56)
    .padding({ left: PaseoTheme.spaceSM, right: PaseoTheme.spaceSM })
    .backgroundColor(PaseoTheme.bgSecondary);
  }
}
