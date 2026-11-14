import { z } from "zod";

const guest = {
  browserId: z.string().min(1).max(256),
  workspaceId: z.string().min(1).max(256),
};
export const NativeBrowserFrameRequestSchema = z.object({
  ...guest,
  notBefore: z.number().finite().nonnegative().optional(),
});
export const NativeBrowserCommandRequestSchema = z.object({
  ...guest,
  method: z.string().regex(/^[A-Za-z]+\.[A-Za-z][A-Za-z0-9]*$/),
  params: z.record(z.string(), z.unknown()).optional(),
});
export const NativeBrowserEventsRequestSchema = z.object({
  ...guest,
  method: z.string().optional(),
  clear: z.boolean().optional(),
});
export type NativeBrowserFrameRequest = z.infer<typeof NativeBrowserFrameRequestSchema>;
export type NativeBrowserCommandRequest = z.infer<typeof NativeBrowserCommandRequestSchema>;
export type NativeBrowserEventsRequest = z.infer<typeof NativeBrowserEventsRequestSchema>;
export interface NativeBrowserFrame {
  data: string;
  width: number;
  height: number;
  capturedAt: number;
}
export interface NativeBrowserEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}
export interface NativeBrowserEvents {
  events: NativeBrowserEvent[];
  dropped: number;
}
