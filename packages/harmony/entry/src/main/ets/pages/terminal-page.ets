/**
 * Terminal page — embedded PTY terminal viewer.
 *
 * Displays the output of a terminal session connected through the daemon.
 * Receives binary frames (output, snapshot) via the WebSocket transport
 * and renders them using the Canvas-based terminal emulator.
 */

import { router } from '@kit.ArkUI';
import { EntryAbility } from '../entryability/EntryAbility';
import { PaseoTheme } from '../common/theme';
import { TerminalToolbar } from '../components/terminal-toolbar';
import { TerminalCanvas } from '../components/terminal-canvas';

@Entry
@Component
struct TerminalPage {
  @State terminalTitle: string = 'Terminal';
  @State isConnected: boolean = false;

  private paseo = EntryAbility.paseoClient;
  private terminalRef: TerminalCanvas | null = null;

  aboutToAppear(): void {
    if (!this.paseo.client) {
      router.replaceUrl({ url: 'pages/connect-page' });
      return;
    }
    this.isConnected = this.paseo.connection.status === 'connected';

    // TODO: Subscribe to terminal session
    // const client = this.paseo.client;
    // client.subscribeTerminal({ slot: 0, agentId: '...' });
    // On binary frame: terminalRef.writeBinaryFrame(payload);
  }

  handleInput(data: string): void {
    // TODO: Send terminal input via daemon RPC
    // this.paseo.client!.sendTerminalInput({ slot: 0, data });
  }

  handleClear(): void {
    if (this.terminalRef) {
      this.terminalRef.clear();
    }
  }

  build() {
    Column() {
      TerminalToolbar({
        title: this.terminalTitle,
        isConnected: this.isConnected,
        onBack: () => { router.back(); },
        onClear: () => { this.handleClear(); },
      });

      Divider()
        .color(PaseoTheme.border)
        .width('100%')
        .height(1);

      TerminalCanvas({
        onInput: (data: string) => { this.handleInput(data); },
        isConnected: this.isConnected,
      });
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PaseoTheme.bgPrimary)
    .expandSafeArea([SafeAreaType.SYSTEM])
  }
}
