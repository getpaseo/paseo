import type { Command } from "commander";
import { connectToDaemon } from "../../utils/client.js";
import type { CommandOptions, OutputSchema, SingleResult } from "../../output/index.js";

export interface ProviderDiagnosticResult {
  provider: string;
  diagnostic: string;
}

export const providerDiagnosticSchema: OutputSchema<ProviderDiagnosticResult> = {
  idField: "provider",
  columns: [
    { header: "PROVIDER", field: "provider" },
    { header: "DIAGNOSTIC", field: "diagnostic" },
  ],
  renderHuman(result) {
    if (result.type === "single") return result.data.diagnostic;
    return result.data.map((entry) => entry.diagnostic).join("\n\n");
  },
};

export interface ProviderDiagnosticOptions extends CommandOptions {
  host?: string;
}

export async function runDiagnosticCommand(
  provider: string,
  options: ProviderDiagnosticOptions,
  _command: Command,
): Promise<SingleResult<ProviderDiagnosticResult>> {
  const client = await connectToDaemon({ host: options.host });
  try {
    const result = await client.getProviderDiagnostic(provider.trim().toLowerCase());
    return {
      type: "single",
      data: {
        provider: result.provider,
        diagnostic: result.diagnostic,
      },
      schema: providerDiagnosticSchema,
    };
  } finally {
    await client.close();
  }
}
