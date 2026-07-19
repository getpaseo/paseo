import { Buffer } from "node:buffer";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import pino from "pino";

import { createAgentMcpServer } from "../src/server/agent/mcp-server.js";
import type { AgentManager, ManagedAgent } from "../src/server/agent/agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "../src/server/agent/agent-storage.js";
import type { AgentProvider, ProviderSnapshotEntry } from "../src/server/agent/agent-sdk-types.js";
import type { ProviderSnapshotManager } from "../src/server/agent/provider-snapshot-manager.js";
import type { BrowserToolsBroker } from "../src/server/browser-tools/broker.js";
import type { BrowserToolsResponsePayload } from "../src/server/browser-tools/errors.js";

type CatalogScope = "agent" | "top-level";

interface CliOptions {
  format: "markdown" | "json";
  scope: CatalogScope;
  top: number;
}

interface FieldSize {
  field: string;
  bytes: number;
  estimatedTokens: number;
}

interface ToolSize {
  name: string;
  bytes: number;
  estimatedTokens: number;
  fields: FieldSize[];
}

interface CatalogMeasurement {
  label: string;
  browserToolsEnabled: boolean;
  toolCount: number;
  bytes: number;
  estimatedTokens: number;
  withoutOutputSchemas: {
    bytes: number;
    estimatedTokens: number;
    savedBytes: number;
    savedEstimatedTokens: number;
  };
  fields: FieldSize[];
  tools: ToolSize[];
}

const DEFAULT_TOP_COUNT = 15;
const MEASUREMENT_AGENT_ID = "agent-tools-measurement";
const MEASUREMENT_CWD = "/tmp/paseo-agent-tools-measurement";
const MEASUREMENT_WORKSPACE_ID = "workspace_agent_tools_measurement";
const FIELD_NAMES = [
  "name",
  "title",
  "description",
  "inputSchema",
  "outputSchema",
  "annotations",
  "execution",
  "_meta",
] as const;

function parseCliOptions(args: string[]): CliOptions {
  let format: CliOptions["format"] = "markdown";
  let scope: CatalogScope = "agent";
  let top = DEFAULT_TOP_COUNT;

  for (const arg of args) {
    if (arg === "--json") {
      format = "json";
      continue;
    }
    if (arg === "--markdown") {
      format = "markdown";
      continue;
    }
    if (arg.startsWith("--scope=")) {
      const value = arg.slice("--scope=".length);
      if (value !== "agent" && value !== "top-level") {
        throw new Error("--scope must be agent or top-level");
      }
      scope = value;
      continue;
    }
    if (arg.startsWith("--top=")) {
      const value = Number.parseInt(arg.slice("--top=".length), 10);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--top must be a positive integer");
      }
      top = value;
      continue;
    }
    if (arg === "--help") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { format, scope, top };
}

function printHelp(): void {
  process.stdout.write(`Usage: npm run measure:agent-tools -- [options]

Measures the MCP tools/list payload for Paseo agent tools.

Options:
  --scope=agent|top-level  Catalog shape to measure. Defaults to agent.
  --top=N                  Number of largest tools to show. Defaults to ${DEFAULT_TOP_COUNT}.
  --json                   Emit machine-readable JSON.
  --markdown               Emit Markdown. This is the default.
`);
}

function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function measureJson(value: unknown): { bytes: number; estimatedTokens: number } {
  const text = JSON.stringify(value);
  return {
    bytes: Buffer.byteLength(text, "utf8"),
    estimatedTokens: estimateTokens(text),
  };
}

function measureField(field: string, value: unknown): FieldSize {
  return {
    field,
    ...measureJson({ [field]: value }),
  };
}

function stripOutputSchemas(tools: Tool[]): Tool[] {
  return tools.map((tool) => {
    const { outputSchema: _outputSchema, ...rest } = tool;
    return rest;
  });
}

function measureTool(tool: Tool): ToolSize {
  const fields = FIELD_NAMES.flatMap((field) =>
    Object.hasOwn(tool, field) ? [measureField(field, tool[field])] : [],
  );
  return {
    name: tool.name,
    ...measureJson(tool),
    fields,
  };
}

function sumFieldSizes(tools: ToolSize[]): FieldSize[] {
  const totals = new Map<string, { bytes: number; estimatedTokens: number }>();
  for (const tool of tools) {
    for (const field of tool.fields) {
      const current = totals.get(field.field) ?? { bytes: 0, estimatedTokens: 0 };
      totals.set(field.field, {
        bytes: current.bytes + field.bytes,
        estimatedTokens: current.estimatedTokens + field.estimatedTokens,
      });
    }
  }
  return [...totals.entries()]
    .map(([field, size]) => ({
      field,
      bytes: size.bytes,
      estimatedTokens: size.estimatedTokens,
    }))
    .sort((a, b) => b.bytes - a.bytes);
}

async function measureCatalog(params: {
  label: string;
  browserToolsEnabled: boolean;
  scope: CatalogScope;
}): Promise<CatalogMeasurement> {
  const server = await createAgentMcpServer({
    agentManager: new MeasurementAgentManager() as unknown as AgentManager,
    agentStorage: new MeasurementAgentStorage() as unknown as AgentStorage,
    providerSnapshotManager:
      new MeasurementProviderSnapshotManager() as unknown as ProviderSnapshotManager,
    browserToolsEnabled: params.browserToolsEnabled,
    browserToolsBroker: new MeasurementBrowserToolsBroker() as unknown as BrowserToolsBroker,
    callerAgentId: params.scope === "agent" ? MEASUREMENT_AGENT_ID : undefined,
    logger: pino({ level: "silent" }),
  });
  const client = new Client({ name: "paseo-agent-tools-measurement", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const result = await client.listTools();
    const size = measureJson(result.tools);
    const strippedSize = measureJson(stripOutputSchemas(result.tools));
    const tools = result.tools.map(measureTool).sort((a, b) => b.bytes - a.bytes);
    return {
      label: params.label,
      browserToolsEnabled: params.browserToolsEnabled,
      toolCount: result.tools.length,
      ...size,
      withoutOutputSchemas: {
        ...strippedSize,
        savedBytes: size.bytes - strippedSize.bytes,
        savedEstimatedTokens: size.estimatedTokens - strippedSize.estimatedTokens,
      },
      fields: sumFieldSizes(tools),
      tools,
    };
  } finally {
    await client.close();
    await server.close();
  }
}

function formatInteger(value: number): string {
  return value.toLocaleString("en-US");
}

function formatMarkdown(measurements: CatalogMeasurement[], top: number): string {
  const [withoutBrowser, withBrowser] = measurements;
  const delta =
    withoutBrowser && withBrowser
      ? {
          tools: withBrowser.toolCount - withoutBrowser.toolCount,
          bytes: withBrowser.bytes - withoutBrowser.bytes,
          estimatedTokens: withBrowser.estimatedTokens - withoutBrowser.estimatedTokens,
        }
      : null;
  const lines: string[] = [];
  lines.push("# Paseo Agent Tool Catalog Context");
  lines.push("");
  lines.push("Token counts are estimates from compact JSON bytes / 4.");
  lines.push("");
  lines.push("| Catalog | Tools | Bytes | Estimated tokens | Output-schema savings |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const measurement of measurements) {
    lines.push(
      `| ${measurement.label} | ${formatInteger(measurement.toolCount)} | ${formatInteger(
        measurement.bytes,
      )} | ${formatInteger(measurement.estimatedTokens)} | ${formatInteger(
        measurement.withoutOutputSchemas.savedEstimatedTokens,
      )} est. tokens |`,
    );
  }
  if (delta) {
    lines.push(
      `| Browser-tool delta | +${formatInteger(delta.tools)} | +${formatInteger(
        delta.bytes,
      )} | +${formatInteger(delta.estimatedTokens)} | |`,
    );
  }

  for (const measurement of measurements) {
    lines.push("");
    lines.push(`## ${measurement.label}`);
    lines.push("");
    lines.push("### Field totals");
    lines.push("");
    lines.push("| Field | Bytes | Estimated tokens |");
    lines.push("| --- | ---: | ---: |");
    for (const field of measurement.fields) {
      lines.push(
        `| ${field.field} | ${formatInteger(field.bytes)} | ${formatInteger(
          field.estimatedTokens,
        )} |`,
      );
    }
    lines.push("");
    lines.push(`### Largest ${Math.min(top, measurement.tools.length)} tools`);
    lines.push("");
    lines.push("| Tool | Bytes | Estimated tokens | Description | Input schema | Output schema |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const tool of measurement.tools.slice(0, top)) {
      const fields = new Map(tool.fields.map((field) => [field.field, field.estimatedTokens]));
      lines.push(
        `| ${tool.name} | ${formatInteger(tool.bytes)} | ${formatInteger(
          tool.estimatedTokens,
        )} | ${formatInteger(fields.get("description") ?? 0)} | ${formatInteger(
          fields.get("inputSchema") ?? 0,
        )} | ${formatInteger(fields.get("outputSchema") ?? 0)} |`,
      );
    }
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

class MeasurementAgentManager {
  private readonly agent = {
    id: MEASUREMENT_AGENT_ID,
    cwd: MEASUREMENT_CWD,
    workspaceId: MEASUREMENT_WORKSPACE_ID,
    provider: "codex",
    currentModeId: "default",
    config: {
      provider: "codex",
      cwd: MEASUREMENT_CWD,
    },
  };

  public getAgent(agentId: string): ManagedAgent | null {
    return agentId === MEASUREMENT_AGENT_ID ? (this.agent as unknown as ManagedAgent) : null;
  }

  public listAgents(): ManagedAgent[] {
    return [];
  }
}

class MeasurementAgentStorage {
  public async list(): Promise<StoredAgentRecord[]> {
    return [];
  }
}

class MeasurementProviderSnapshotManager {
  public listRegisteredProviderIds(): AgentProvider[] {
    return [];
  }

  public hasProvider(): boolean {
    return false;
  }

  public getProviderLabel(provider: AgentProvider): string {
    return provider;
  }

  public async listProviders(): Promise<ProviderSnapshotEntry[]> {
    return [];
  }

  public async getProvider(): Promise<ProviderSnapshotEntry> {
    throw new Error("Provider catalog is not used by the measurement script");
  }

  public async listModels(): Promise<[]> {
    return [];
  }

  public async listModes(): Promise<[]> {
    return [];
  }
}

class MeasurementBrowserToolsBroker {
  public async execute(): Promise<BrowserToolsResponsePayload> {
    throw new Error("Browser tools are not executed by the measurement script");
  }
}

async function main(): Promise<void> {
  const options = parseCliOptions(process.argv.slice(2));
  const measurements = await Promise.all([
    measureCatalog({
      label: "Core tools",
      browserToolsEnabled: false,
      scope: options.scope,
    }),
    measureCatalog({
      label: "Core + browser tools",
      browserToolsEnabled: true,
      scope: options.scope,
    }),
  ]);

  if (options.format === "json") {
    process.stdout.write(`${JSON.stringify({ scope: options.scope, measurements }, null, 2)}\n`);
    return;
  }
  process.stdout.write(formatMarkdown(measurements, options.top));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
