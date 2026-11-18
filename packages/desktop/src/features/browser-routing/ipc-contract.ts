import { z } from "zod";

export const ServerIdSchema = z.string().trim().min(1).max(512);
export const IdSchema = z.string().min(1).max(255);
export const ProviderRefSchema = z.object({ serverId: ServerIdSchema, providerId: IdSchema });
export const StreamRefSchema = ProviderRefSchema.extend({ streamId: IdSchema });
export type TunnelStreamRef = z.infer<typeof StreamRefSchema>;
