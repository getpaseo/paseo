import { createHash } from "node:crypto";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { checkFrame } from "../shared/frame-check";

export function describeFrame(frame: RpcInput<typeof checkFrame>): RpcOutput<typeof checkFrame> {
  return { bytes: frame.byteLength, sha256: createHash("sha256").update(frame).digest("hex") };
}
