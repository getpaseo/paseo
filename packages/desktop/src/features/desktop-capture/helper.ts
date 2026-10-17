import type { DesktopCommand } from "@getpaseo/protocol/desktop-capture";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { z } from "zod";

const helperEvent = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("gesture"),
    id: z.string(),
    phase: z.enum(["began", "ended", "cancelled"]),
  }),
  z.object({
    event: z.literal("result"),
    id: z.string(),
    result: z.record(z.string(), z.unknown()),
  }),
  z.object({ event: z.literal("stopped"), sessionId: z.uuid() }),
  z.object({
    event: z.literal("ready"),
    keyboard: z.boolean(),
    capture: z.boolean(),
    accessibility: z.boolean(),
  }),
  z.object({ event: z.literal("unavailable"), error: z.string() }),
  z.object({ event: z.literal("error"), id: z.string(), error: z.string() }),
  z.object({ event: z.literal("ocr"), id: z.string(), text: z.string().max(32000) }),
  z.object({
    event: z.literal("capture"),
    id: z.string(),
    png: z
      .string()
      .max(64 * 1024 * 1024)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/),
    context: z.object({
      application: z.string().optional(),
      bundleId: z.string().optional(),
      windowTitle: z.string().optional(),
      document: z.string().optional(),
    }),
    display: z.object({
      id: z.number().int(),
      x: z.number().finite(),
      y: z.number().finite(),
      width: z.number().positive().max(32768),
      height: z.number().positive().max(32768),
    }),
    width: z.number().int().positive().max(32768),
    height: z.number().int().positive().max(32768),
    captureMs: z.number().nonnegative(),
    gesture: z.boolean().optional(),
    cropPng: z
      .string()
      .max(64 * 1024 * 1024)
      .optional(),
  }),
]);
export type CaptureHelperEvent = z.infer<typeof helperEvent>;
export type CapturedDesktop = Extract<CaptureHelperEvent, { event: "capture" }>;

export function parseHelperEvent(line: string): CaptureHelperEvent {
  return helperEvent.parse(JSON.parse(line));
}

export function startCaptureHelper(input: {
  executable: string;
  onEvent(event: CaptureHelperEvent): void;
  onDisconnect(error: Error): void;
}) {
  const child = spawn(input.executable, [], { stdio: ["pipe", "pipe", "pipe"] });
  let stopped = false;
  function disconnect(error: Error) {
    if (stopped) return;
    stopped = true;
    child.kill();
    input.onDisconnect(error);
  }
  child.on("error", disconnect);
  child.on("exit", () => disconnect(new Error("Desktop capture helper disconnected.")));
  // Consume diagnostics without ever copying captured content to logs.
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      input.onEvent(parseHelperEvent(line));
    } catch {
      disconnect(new Error("Invalid desktop capture helper response."));
    }
  });
  return {
    command(
      command:
        | { command: "control"; id: string; sessionId: string; action: DesktopCommand }
        | { command: "revoke"; sessionId: string }
        | { command: "capture"; id: string }
        | { command: "permissions" }
        | { command: "cancel_gesture" }
        | { command: "shortcut"; modifiers: number },
    ) {
      if (stopped) throw new Error("Desktop capture helper is unavailable.");
      child.stdin.write(`${JSON.stringify(command)}\n`);
    },
    stop() {
      stopped = true;
      lines.close();
      child.stdin.end();
      child.kill();
    },
  };
}
