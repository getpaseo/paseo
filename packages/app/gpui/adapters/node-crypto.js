import { Buffer } from "buffer";
import Desktop from "../desktop/src/NativePaseoDesktop";
export function randomBytes(length) {
  return Buffer.from(Desktop.randomBytes(length));
}
