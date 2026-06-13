import {
  decodeFileTransferFrame,
  FileTransferOpcode,
  type FileTransferFrame,
} from "./file-transfer.js";
import {
  decodeTerminalStreamFrame,
  TerminalStreamOpcode,
  type TerminalStreamFrame,
} from "./terminal.js";
import { decodeTunnelStreamFrame, TunnelStreamOpcode, type TunnelStreamFrame } from "./tunnel.js";

export type BinaryFrame =
  | { kind: "terminal"; frame: TerminalStreamFrame }
  | { kind: "file_transfer"; frame: FileTransferFrame }
  | { kind: "tunnel"; frame: TunnelStreamFrame };

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
    case TunnelStreamOpcode.Data:
    case TunnelStreamOpcode.Close:
    case TunnelStreamOpcode.Open: {
      const frame = decodeTunnelStreamFrame(bytes);
      return frame ? { kind: "tunnel", frame } : null;
    }
    default:
      return null;
  }
}
