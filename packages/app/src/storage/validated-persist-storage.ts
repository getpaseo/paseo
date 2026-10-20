import { z } from "zod";
import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware";

export function createValidatedPersistStorage<State>(
  backingStorage: StateStorage,
  stateSchema: z.ZodType<State>,
  // Opt in only when callers preserve state references until values change.
  options: { skipUnchanged?: boolean } = {},
): PersistStorage<State> {
  const envelopeSchema = z.strictObject({
    state: stateSchema,
    version: z.number().int().nonnegative().optional(),
  });

  const accepted = new Map<string, StorageValue<State>>();

  return {
    getItem: async (name) => {
      accepted.delete(name);
      const raw = await backingStorage.getItem(name);
      if (raw === null) return null;

      let decoded: unknown;
      try {
        decoded = JSON.parse(raw);
      } catch {
        await backingStorage.removeItem(name);
        return null;
      }

      const result = envelopeSchema.safeParse(decoded);
      if (!result.success) {
        await backingStorage.removeItem(name);
        return null;
      }
      return result.data;
    },
    setItem: async (name, value) => {
      const previous = accepted.get(name);
      if (
        options.skipUnchanged &&
        previous &&
        previous.state === value.state &&
        previous.version === value.version
      )
        return;
      const result = envelopeSchema.safeParse(value);
      if (!result.success) {
        accepted.delete(name);
        await backingStorage.removeItem(name);
        return;
      }
      if (options.skipUnchanged) accepted.set(name, value);
      try {
        await backingStorage.setItem(name, JSON.stringify(result.data));
      } catch (error) {
        if (accepted.get(name) === value) accepted.delete(name);
        throw error;
      }
    },
    removeItem: (name) => {
      accepted.delete(name);
      return backingStorage.removeItem(name);
    },
  };
}
