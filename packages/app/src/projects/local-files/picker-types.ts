import type { LocalFileInfo } from "@getpaseo/protocol/project-local-files";
export interface LocalFileSelection {
  path: string;
  size: number;
  status: LocalFileInfo["status"];
  read: () => Promise<Uint8Array>;
}
