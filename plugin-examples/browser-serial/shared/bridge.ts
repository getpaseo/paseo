import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

// Largest raw payload per poll/write chunk. Shared so the browser can split
// serial reads to match what the host accepts.
export const MAX_CHUNK_BYTES = 32768;

// Base64 shape check without Node APIs (shared code also runs in the app).
// Canonical form (round-trip + decoded size) is enforced again on the server.
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const base64Data = z
  .string()
  .max(43692) // ceil(32768 / 3) * 4: encoded form of one full chunk
  .refine((value) => base64Pattern.test(value), { message: "Expected canonical base64 data." });

const token = z.string().min(1).max(256);

export const createBridge = defineRpc({
  name: "serial.create",
  input: z.object({}),
  output: z.object({ token: z.string(), port: z.number().int().min(1).max(65535) }),
});

export const pollBridge = defineRpc({
  name: "serial.poll",
  input: z.object({ token }),
  output: z.object({ data: base64Data, connected: z.boolean(), closed: z.boolean() }),
});

export const writeBridge = defineRpc({
  name: "serial.write",
  input: z.object({ token, data: base64Data }),
  output: z.object({}),
});

export const closeBridge = defineRpc({
  name: "serial.close",
  input: z.object({ token }),
  output: z.object({}),
});

export const renewBridge = defineRpc({
  name: "serial.renew",
  input: z.object({ token }),
  output: z.object({}),
});
