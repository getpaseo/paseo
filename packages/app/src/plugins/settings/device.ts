import {
  settingsRpc,
  type SettingsDefinition,
  type RpcOutput,
  type RpcInput,
} from "@getpaseo/plugin";
import { z } from "zod";

interface DeviceStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}
type ReadResult = RpcOutput<ReturnType<typeof settingsRpc>["read"]>;
type WriteResult = RpcOutput<ReturnType<typeof settingsRpc>["write"]>;
type WriteInput = RpcInput<ReturnType<typeof settingsRpc>["write"]>;
const envelope = z.object({ version: z.number().int().positive(), values: z.json() });

/** One writer per device; installations with the same id share their layout settings across hosts. */
export function createDeviceSettings(storage: DeviceStorage) {
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  }
  return function settings(installationId: string, definition: SettingsDefinition) {
    const key = `@paseo:plugin-device-settings:${installationId}/${definition.id}`;
    async function read(): Promise<ReadResult> {
      const raw = await storage.getItem(key);
      let revision = raw ?? "missing";
      try {
        let values: unknown = {};
        let migrated = false;
        if (raw !== null) {
          const stored = envelope.parse(JSON.parse(raw));
          if (stored.version > definition.version)
            throw new Error("Update this plugin to read its newer settings");
          values = stored.values;
          if (stored.version < definition.version) {
            if (!definition.migrate)
              throw new Error("This plugin has no migration for its saved settings");
            values = await definition.migrate(values, stored.version);
            migrated = true;
          }
        }
        const parsed = z.json().parse(await definition.schema.parseAsync(values));
        if (migrated) {
          const serialized = JSON.stringify({ version: definition.version, values: parsed });
          await storage.setItem(key, serialized);
          revision = serialized;
        }
        return { status: "ready", revision, values: parsed };
      } catch (error) {
        return {
          status: "invalid",
          revision,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    function write(input: WriteInput): Promise<WriteResult> {
      return serial(async () => {
        const raw = await storage.getItem(key);
        if ((raw ?? "missing") !== input.revision)
          return { status: "conflict", error: "Settings changed. Reload before saving." };
        const parsed = await definition.schema.safeParseAsync(input.values);
        if (!parsed.success) return { status: "invalid", error: parsed.error.message };
        const values = z.json().parse(parsed.data);
        const serialized = JSON.stringify({ version: definition.version, values });
        await storage.setItem(key, serialized);
        return { status: "saved", revision: serialized, values };
      });
    }
    return {
      read: () => serial(read),
      write,
      reset: (input: { revision: string }) => write({ revision: input.revision, values: {} }),
    };
  };
}
