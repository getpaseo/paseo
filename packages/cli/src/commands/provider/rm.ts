import type { Command } from "commander";
import type {
  CommandError,
  CommandOptions,
  OutputSchema,
  SingleResult,
} from "../../output/index.js";
import { connectToDaemon, getDaemonHost } from "../../utils/client.js";
import { isBuiltinProviderId } from "./shared.js";

export type ProviderRmOptions = CommandOptions;

export interface ProviderRmRow {
  provider: string;
  removed: string;
}

export const providerRmSchema: OutputSchema<ProviderRmRow> = {
  idField: "provider",
  columns: [
    { header: "PROVIDER", field: "provider", width: 16 },
    { header: "REMOVED", field: "removed", width: 10 },
  ],
};

export async function runRmCommand(
  id: string,
  options: ProviderRmOptions,
  _command: Command,
): Promise<SingleResult<ProviderRmRow>> {
  if (isBuiltinProviderId(id)) {
    throw {
      code: "INVALID_PROVIDER_CONFIG",
      message: `"${id}" is a built-in provider and cannot be removed.`,
    } satisfies CommandError;
  }

  const host = getDaemonHost({ host: options.host });
  const client = await connectToDaemon({ host: options.host }).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    throw {
      code: "DAEMON_NOT_RUNNING",
      message: `Cannot connect to daemon at ${host}: ${message}`,
    } satisfies CommandError;
  });

  try {
    const { config } = await client.getDaemonConfig();
    if (!(id in (config.providers ?? {}))) {
      throw new Error(`No custom provider "${id}" is configured.`);
    }

    await client.patchDaemonConfig({ removeProviders: [id] });
    return {
      type: "single",
      data: { provider: id, removed: "yes" },
      schema: providerRmSchema,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw { code: "PROVIDER_RM_FAILED", message } satisfies CommandError;
  } finally {
    await client.close().catch(() => undefined);
  }
}
