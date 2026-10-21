import { HOST_ROUTE_OPCODE, decodeHostRouteFrame, type HostRouteFrame } from "./host-route.js";
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

export type BinaryFrame =
  | { kind: "host_route"; frame: HostRouteFrame }
  | { kind: "terminal"; frame: TerminalStreamFrame }
  | { kind: "file_transfer"; frame: FileTransferFrame };

export function decodeBinaryFrame(bytes: Uint8Array): BinaryFrame | null {
  switch (bytes[0]) {
    case HOST_ROUTE_OPCODE: {
      const frame = decodeHostRouteFrame(bytes);
      return frame ? { kind: "host_route", frame } : null;
    }
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
    default:
      return null;
  }
}
