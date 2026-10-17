import { z } from "zod";

export const DesktopCaptureGestureSchema = z.object({
  id: z.uuid(),
  phase: z.enum(["began", "ended", "cancelled"]),
});
export type DesktopCaptureGesture = z.infer<typeof DesktopCaptureGestureSchema>;

export const DesktopCaptureDraftSchema = z.object({
  id: z.uuid(),
  deviceId: z.uuid(),
  serverId: z.string(),
  png: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  context: z.object({
    application: z.string().optional(),
    bundleId: z.string().optional(),
    windowTitle: z.string().optional(),
    document: z.string().optional(),
  }),
  ocr: z.string(),
  captureMs: z.number().nonnegative(),
  gesture: z.boolean().optional(),
  cropPng: z.string().optional(),
});
export type DesktopCaptureDraft = z.infer<typeof DesktopCaptureDraftSchema>;
export const DesktopCaptureTargetSchema = z.object({
  serverId: z.string(),
  workspaceId: z.string(),
  agentId: z.uuid(),
});
export type DesktopCaptureTarget = z.infer<typeof DesktopCaptureTargetSchema>;
export interface DesktopCaptureBridge {
  getDraft(): Promise<DesktopCaptureDraft | null>;
  onGesture(handler: (gesture: DesktopCaptureGesture) => void): () => void;
  present(): Promise<void>;
  onUpdate(handler: (draft: DesktopCaptureDraft | null) => void): () => void;
  cancel(): Promise<void>;
  complete(target: DesktopCaptureTarget): Promise<void>;
  open(): Promise<void>;
  device(): Promise<string>;
  ensurePara(): Promise<string>;
  execute(request: DesktopExecuteRequest): Promise<DesktopExecuteResponse>;
  revoke(sessionId: string): Promise<void>;
  onStop(handler: () => void): () => void;
}

export const DesktopCommandSchema = z.discriminatedUnion("command", [
  z.object({ command: z.literal("screenshot") }),
  z.object({ command: z.literal("accessibility") }),
  z.object({
    command: z.literal("click"),
    x: z.number().finite(),
    y: z.number().finite(),
    button: z.enum(["left", "right"]),
  }),
  z.object({
    command: z.literal("scroll"),
    x: z.number().finite(),
    y: z.number().finite(),
    deltaX: z.number().int().min(-10000).max(10000),
    deltaY: z.number().int().min(-10000).max(10000),
  }),
  z.object({ command: z.literal("type_text"), text: z.string().min(1).max(2000) }),
  z.object({
    command: z.literal("shortcut"),
    keyCode: z.number().int().min(0).max(127),
    modifiers: z.array(z.enum(["command", "option", "control", "shift"])).max(4),
  }),
]);
export type DesktopCommand = z.infer<typeof DesktopCommandSchema>;
export const DesktopHostRegisterRequestSchema = z.object({
  type: z.literal("desktop.host.register.request"),
  requestId: z.string(),
  deviceId: z.uuid(),
});
export const DesktopHostRegisterResponseSchema = z.object({
  type: z.literal("desktop.host.register.response"),
  payload: z.object({ requestId: z.string(), subscriptionId: z.string() }),
});
export const DesktopExecuteRequestSchema = z.object({
  type: z.literal("desktop.control.execute.request"),
  subscriptionId: z.string().optional(),
  requestId: z.string(),
  deviceId: z.uuid(),
  agentId: z.uuid(),
  sessionId: z.uuid(),
  command: DesktopCommandSchema,
});
export const DesktopExecuteResponseSchema = z.object({
  type: z.literal("desktop.control.execute.response"),
  payload: z.object({
    requestId: z.string(),
    sessionId: z.uuid(),
    ok: z.boolean(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z.string().optional(),
  }),
});
export const DesktopRevokeSchema = z.object({
  type: z.literal("desktop.control.revoked"),
  subscriptionId: z.string().optional(),
  sessionId: z.uuid(),
});
export const DesktopStopRequestSchema = z.object({
  type: z.literal("desktop.control.stop.request"),
  requestId: z.string(),
  deviceId: z.uuid(),
});
export const DesktopStopResponseSchema = z.object({
  type: z.literal("desktop.control.stop.response"),
  payload: z.object({ requestId: z.string() }),
});
export type DesktopExecuteRequest = z.infer<typeof DesktopExecuteRequestSchema>;
export type DesktopExecuteResponse = z.infer<typeof DesktopExecuteResponseSchema>;
