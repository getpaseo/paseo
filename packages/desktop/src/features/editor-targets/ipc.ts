import { ipcMain } from "electron";
import { z } from "zod";

import { listAvailableEditorTargets, openEditorTarget } from "./registry.js";
import { createEditorTargetRuntime } from "./runtime.js";
import type { EditorTarget, EditorTargetRuntime } from "./target.js";

interface IpcHandlerRegistry {
  handle(channel: string, listener: (event: unknown, ...args: unknown[]) => unknown): void;
}

/** An SSH destination: `[user@]host[:port]`, with nothing that would break a URI authority. */
const SSH_DESTINATION_PATTERN = /^[A-Za-z0-9._@:-]+$/u;

const RemoteDestinationSchema = z.object({
  kind: z.literal("ssh"),
  host: z
    .string()
    .trim()
    .min(1)
    .regex(SSH_DESTINATION_PATTERN, "SSH host must not contain spaces or slashes"),
});

const EditorTargetLaunchInputSchema = z.object({
  editorId: z.string().trim().min(1),
  workspacePath: z.string().trim().min(1),
  filePath: z.string().trim().min(1).optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  remoteDestination: RemoteDestinationSchema.optional(),
});

export function registerEditorTargetHandlers(
  options: {
    ipc?: IpcHandlerRegistry;
    runtime?: EditorTargetRuntime;
    targets?: readonly EditorTarget[];
  } = {},
): void {
  const ipc = options.ipc ?? ipcMain;
  const runtime = options.runtime ?? createEditorTargetRuntime();

  ipc.handle("paseo:editor:listTargets", () =>
    listAvailableEditorTargets(runtime, options.targets),
  );
  ipc.handle("paseo:editor:openTarget", async (_event, payload: unknown) => {
    const input = EditorTargetLaunchInputSchema.parse(payload);
    await openEditorTarget(input, runtime, options.targets);
  });
}
