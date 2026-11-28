import { z } from "zod";
export {
  FileTransferOpcode,
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  type FileBegin,
  type FileBeginMetadata,
  type FileChunk,
  type FileEnd,
  type FileTransferFrame,
} from "./file-transfer-wire.js";

export const FileBeginMetadataSchema = z.object({
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
  encoding: z.enum(["utf-8", "binary"]),
  modifiedAt: z.string(),
  revision: z.string().optional(),
  fileName: z.string().optional(),
});
