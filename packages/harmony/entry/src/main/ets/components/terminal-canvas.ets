/**
 * Terminal canvas — the main terminal UI component.
 *
 * Wraps an ArkUI Canvas that renders the terminal emulator output.
 * Connects the TerminalBuffer, TerminalParser, and TerminalRenderer
 * into a working terminal viewer.
 *
 * Features:
 *   - Real-time output rendering via Canvas
 *   - Keyboard input forwarding
 *   - Pinch-to-zoom font size (Phase 2)
 *   - Scrollback via gesture (Phase 2)
 */

import { TerminalBuffer } from '../terminal/terminal-buffer';
import { TerminalParser } from '../terminal/terminal-parser';
import { TerminalRenderer } from '../terminal/terminal-renderer';
import { PaseoTheme } from '../common/theme';
import { AppConstants } from '../common/constants';
import { KeyCode } from '@ohos.multimodalInput.keyCode';

@Component
export struct TerminalCanvas {
  /** Callback for keyboard input to send to daemon. */
  onInput: (data: string) => void = () => {};
  /** Whether the terminal is connected to a live session. */
  @Prop isConnected: boolean = false;

  @State private buffer: TerminalBuffer = new TerminalBuffer(80, 24);
  private parser: TerminalParser = new TerminalParser(this.buffer);
  private renderer: TerminalRenderer = new TerminalRenderer(this.buffer);
  private canvasSettings: RenderingContextSettings = new RenderingContextSettings(true);
  private context: CanvasRenderingContext2D | null = null;
  private canvasWidth: number = 360;
  private canvasHeight: number = 600;

  /** Process incoming terminal output data. */
  writeOutput(data: Uint8Array): void {
    this.parser.process(data);
    // Mark all visible rows dirty after processing
    this.renderer.dirtyAll();
    this.requestRender();
  }

  /** Process binary output frame from daemon. */
  writeBinaryFrame(payload: Uint8Array): void {
    this.writeOutput(payload);
  }

  /** Restore from a snapshot. */
  restoreSnapshot(visibleLines: string[], cursorRow: number, cursorCol: number): void {
    this.buffer.restoreSnapshot(visibleLines, cursorRow, cursorCol);
    this.renderer.dirtyAll();
    this.requestRender();
  }

  /** Clear the terminal. */
  clear(): void {
    this.buffer.eraseDisplay(2);
    this.renderer.dirtyAll();
    this.requestRender();
  }

  private requestRender(): void {
    // Request animation frame for smooth rendering
    setTimeout(() => {
      this.renderer.renderFrame();
    }, 16); // ~60fps
  }

  build() {
    Column() {
      Canvas(this.context)
        .onReady(() => {
          // Canvas is ready — use conservative defaults for dimensions
          this.canvasWidth = 360;
          this.canvasHeight = 600;
          const ctx = this.context;
          if (ctx !== null) {
            this.renderer.attach(ctx, this.canvasWidth, this.canvasHeight);
            this.renderer.dirtyAll();
            this.renderer.renderFrame();
          }
        })
        .onAreaChange((oldValue: Area, newValue: Area) => {
          const w = newValue.width as number;
          const h = newValue.height as number;
          if (w > 0 && h > 0 && (w !== this.canvasWidth || h !== this.canvasHeight)) {
            this.canvasWidth = w;
            this.canvasHeight = h;
            if (this.context) {
              this.renderer.resize(w, h);
              this.renderer.renderFrame();
            }
          }
        })
        .width('100%')
        .layoutWeight(1)
        .backgroundColor(PaseoTheme.terminalBg)
        .focusable(true)
        .onKeyEvent((event: KeyEvent) => {
          // Forward keyboard input to daemon
          if (event.type === KeyType.Down) {
            let data = '';
            if (event.keyText && event.keyText.length > 0) {
              data = event.keyText;
            } else if (event.keyCode === KeyCode.KEYCODE_ENTER) {
              data = '\r';
            } else if (event.keyCode === KeyCode.KEYCODE_TAB) {
              data = '\t';
            } else if (event.keyCode === KeyCode.KEYCODE_DEL) {
              data = '\x7f';
            }
            if (data) {
              this.onInput(data);
            }
          }
          return false;
        });
    }
    .width('100%')
    .height('100%')
    .backgroundColor(PaseoTheme.terminalBg);
  }
}
