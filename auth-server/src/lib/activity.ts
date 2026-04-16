import { db } from "./db";
import { activityLog } from "@/db/schema";
import { randomUUID } from "crypto";

export async function logActivity(params: {
  userId?: string | null;
  action: string;
  resourceType?: string;
  resourceId?: string;
  details?: Record<string, unknown>;
}) {
  await db.insert(activityLog).values({
    id: randomUUID(),
    userId: params.userId ?? null,
    action: params.action,
    resourceType: params.resourceType ?? null,
    resourceId: params.resourceId ?? null,
    details: params.details ?? null,
    createdAt: new Date(),
  });
}
