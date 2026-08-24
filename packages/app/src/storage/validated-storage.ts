import { z } from "zod";

export interface ValidatedStorage {
  getItem(key: string): Promise<string | null>;
  removeItem(key: string): Promise<void>;
}

async function clearInvalidValue(storage: ValidatedStorage, key: string): Promise<void> {
  try {
    await storage.removeItem(key);
  } catch {
    // Invalid persisted data must never cross the boundary, even when cleanup fails.
  }
}

export async function readValidatedString<Value>(
  storage: ValidatedStorage,
  key: string,
  schema: z.ZodType<Value>,
): Promise<Value | null> {
  const raw = await storage.getItem(key);
  if (raw === null) return null;
  const result = schema.safeParse(raw);
  if (result.success) return result.data;
  await clearInvalidValue(storage, key);
  return null;
}

export async function readValidatedJson<Value>(
  storage: ValidatedStorage,
  key: string,
  schema: z.ZodType<Value>,
): Promise<Value | null> {
  const raw = await storage.getItem(key);
  if (raw === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    await clearInvalidValue(storage, key);
    return null;
  }
  const result = schema.safeParse(decoded);
  if (result.success) return result.data;
  await clearInvalidValue(storage, key);
  return null;
}
