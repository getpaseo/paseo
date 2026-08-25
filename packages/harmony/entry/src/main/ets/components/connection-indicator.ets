/**
 * Connection indicator — a small status badge showing daemon connection state.
 *
 * Displays as a colored dot + label in the UI. Used in agent headers, page
 * navigation bars, and settings.
 */

import { PaseoTheme } from '../common/theme';
import { Icons } from '../common/icons';
import { EntryAbility } from '../entryability/EntryAbility';

@Component
export struct ConnectionIndicator {
  @State status: string = 'idle';
  @State serverId: string = '';

  aboutToAppear(): void {
    // Bind to the global connection model
    // In a real app, use @ObjectLink or @Consume to react to changes
    const conn = EntryAbility.paseoClient.connection;
    this.status = conn.status;
    this.serverId = conn.serverId || conn.hostname;
  }

  build() {
    Row() {
      if (this.status === 'connected') {
        Text(Icons.CONNECTED)
          .fontSize(8)
          .fontColor(PaseoTheme.accent)
          .margin({ right: PaseoTheme.spaceXS });
      } else if (this.status === 'connecting') {
        Text(Icons.CONNECTED)
          .fontSize(8)
          .fontColor(PaseoTheme.warning)
          .margin({ right: PaseoTheme.spaceXS });
      } else {
        Text(Icons.DISCONNECTED)
          .fontSize(8)
          .fontColor(PaseoTheme.danger)
          .margin({ right: PaseoTheme.spaceXS });
      }

      Text(this.status === 'connected' ? this.serverId : this.status)
        .fontSize(PaseoTheme.fontSizeXS)
        .fontColor(PaseoTheme.textSecondary)
        .maxLines(1)
        .textOverflow({ overflow: TextOverflow.Ellipsis });
    }
    .padding({
      left: PaseoTheme.spaceSM,
      right: PaseoTheme.spaceSM,
      top: PaseoTheme.spaceXS,
      bottom: PaseoTheme.spaceXS,
    })
    .backgroundColor(PaseoTheme.codeBg)
    .borderRadius(PaseoTheme.radiusFull);
  }
}
