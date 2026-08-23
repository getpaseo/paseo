import {
  decodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "./file-transfer.js";
import {
  BrowserScreencastOpcode,
  decodeBrowserScreencastFrame,
  type BrowserScreencastFrame,
} from "./screencast.js";
import {
  decodeTerminalStreamFrame,
  TerminalStreamOpcode,
  type TerminalStreamFrame,
} from "./terminal.js";

export type BinaryFrame =
  | { kind: "terminal"; frame: TerminalStreamFrame }
  | { kind: "file_transfer"; frame: FileTransferFrame }
  | { kind: "browser_screencast"; frame: BrowserScreencastFrame };

export function decodeBinaryFrame(bytes: Uint8Array): BinaryFrame | null {
  switch (bytes[0]) {
    case TerminalStreamOpcode.Output:
    case TerminalStreamOpcode.Input:
    case TerminalStreamOpcode.Resize:
    case TerminalStreamOpcode.Snapshot:
    case TerminalStreamOpcode.Restore: {
      const frame = decodeTerminalStreamFrame(bytes);
      return frame ? { kind: "terminal", frame } : null;
    }
    case FileTransferOpcode.FileBegin:
    case FileTransferOpcode.FileChunk:
    case FileTransferOpcode.FileEnd: {
      const frame = decodeFileTransferFrame(bytes);
      return frame ? { kind: "file_transfer", frame } : null;
    }
    case BrowserScreencastOpcode.Frame: {
      const frame = decodeBrowserScreencastFrame(bytes);
      return frame ? { kind: "browser_screencast", frame } : null;
    }
    default:
      return null;
  }
}
