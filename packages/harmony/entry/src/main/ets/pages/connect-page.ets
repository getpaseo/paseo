/**
 * Connect page — the first screen shown on app launch.
 *
 * Allows the user to enter a daemon host and port, supports an optional
 * password, and remembers the last-used connection.
 *
 * On successful connection, navigates to the agent page.
 */

import { router } from '@kit.ArkUI';
import { promptAction } from '@kit.ArkUI';
import { EntryAbility } from '../entryability/EntryAbility';
import { AppConstants } from '../common/constants';
import { PaseoTheme } from '../common/theme';
import { Icons } from '../common/icons';

@Entry
@Component
struct ConnectPage {
  @State host: string = AppConstants.DEFAULT_HOST;
  @State port: string = AppConstants.DEFAULT_PORT.toString();
  @State password: string = '';
  @State isConnecting: boolean = false;
  @State errorMessage: string = '';

  private paseo = EntryAbility.paseoClient;

  async aboutToAppear(): Promise<void> {
    // Restore last-used connection
    const last = await this.paseo.loadLastConnection();
    if (last) {
      this.host = last.host;
      this.port = last.port.toString();
    }
  }

  async handleConnect(): Promise<void> {
    this.isConnecting = true;
    this.errorMessage = '';

    const portNum = parseInt(this.port);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      this.errorMessage = 'Invalid port number (1–65535)';
      this.isConnecting = false;
      return;
    }

    try {
      await this.paseo.connect(this.host, portNum, this.password || undefined);
      // Only navigate if connection state indicates success.
      // Phase 1 stub always sets 'connected'; real connectivity will
      // only set it on a successful WebSocket handshake.
      if (this.paseo.connection.status === 'connected') {
        router.pushUrl({ url: 'pages/agent-page' });
      } else {
        this.errorMessage = 'Connection failed';
        this.isConnecting = false;
      }
    } catch (err) {
      this.errorMessage = `${err}`;
    } finally {
      this.isConnecting = false;
    }
  }

  build() {
    Column() {
      // ---- Header ----
      Column() {
        Text('Paseo')
          .fontSize(PaseoTheme.fontSizeXXL)
          .fontWeight(FontWeight.Bold)
          .fontColor(PaseoTheme.textPrimary)
          .margin({ bottom: PaseoTheme.spaceSM });

        Text('Connect to your local AI coding agents')
          .fontSize(PaseoTheme.fontSizeSM)
          .fontColor(PaseoTheme.textSecondary);
      }
      .width('100%')
      .padding({ top: PaseoTheme.spaceXXL, bottom: PaseoTheme.spaceXL })
      .alignItems(HorizontalAlign.Center);

      // ---- Connection form ----
      Column() {
        // Host input
        Column() {
          Text('Host')
            .fontSize(PaseoTheme.fontSizeSM)
            .fontColor(PaseoTheme.textSecondary)
            .margin({ bottom: PaseoTheme.spaceXS });

          TextInput({ text: this.host, placeholder: '192.168.1.5' })
            .onChange((value: string) => { this.host = value; })
            .fontSize(PaseoTheme.fontSizeMD)
            .fontColor(PaseoTheme.textPrimary)
            .backgroundColor(PaseoTheme.bgSecondary)
            .borderRadius(PaseoTheme.radiusMD)
            .padding(PaseoTheme.spaceMD);
        }
        .width('100%')
        .margin({ bottom: PaseoTheme.spaceMD });

        // Port input
        Column() {
          Text('Port')
            .fontSize(PaseoTheme.fontSizeSM)
            .fontColor(PaseoTheme.textSecondary)
            .margin({ bottom: PaseoTheme.spaceXS });

          TextInput({ text: this.port, placeholder: '6767' })
            .onChange((value: string) => { this.port = value; })
            .type(InputType.Number)
            .fontSize(PaseoTheme.fontSizeMD)
            .fontColor(PaseoTheme.textPrimary)
            .backgroundColor(PaseoTheme.bgSecondary)
            .borderRadius(PaseoTheme.radiusMD)
            .padding(PaseoTheme.spaceMD);
        }
        .width('100%')
        .margin({ bottom: PaseoTheme.spaceMD });

        // Password input (optional)
        Column() {
          Text('Password (optional)')
            .fontSize(PaseoTheme.fontSizeSM)
            .fontColor(PaseoTheme.textSecondary)
            .margin({ bottom: PaseoTheme.spaceXS });

          TextInput({ text: this.password, placeholder: 'Daemon password' })
            .onChange((value: string) => { this.password = value; })
            .type(InputType.Password)
            .fontSize(PaseoTheme.fontSizeMD)
            .fontColor(PaseoTheme.textPrimary)
            .backgroundColor(PaseoTheme.bgSecondary)
            .borderRadius(PaseoTheme.radiusMD)
            .padding(PaseoTheme.spaceMD);
        }
        .width('100%')
        .margin({ bottom: PaseoTheme.spaceXL });

        // Connect button
        Button(this.isConnecting ? 'Connecting…' : 'Connect')
          .enabled(!this.isConnecting)
          .width('100%')
          .height(48)
          .fontSize(PaseoTheme.fontSizeMD)
          .fontWeight(FontWeight.Medium)
          .fontColor(Color.White)
          .backgroundColor(this.isConnecting ? PaseoTheme.borderStrong : PaseoTheme.accent)
          .borderRadius(PaseoTheme.radiusMD)
          .onClick(() => { this.handleConnect(); });

        // Error message
        if (this.errorMessage) {
          Text(this.errorMessage)
            .fontSize(PaseoTheme.fontSizeSM)
            .fontColor(PaseoTheme.danger)
            .margin({ top: PaseoTheme.spaceMD })
            .textAlign(TextAlign.Center);
        }
      }
      .width('100%')
      .padding({ left: PaseoTheme.spaceXL, right: PaseoTheme.spaceXL });

      // ---- Filler ----
      Blank();
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PaseoTheme.bgPrimary)
    .expandSafeArea([SafeAreaType.SYSTEM])
  }
}
