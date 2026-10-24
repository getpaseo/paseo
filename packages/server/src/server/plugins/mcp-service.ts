import path from "node:path";
import {
  PluginMcpServerSchema,
  type PluginMcpServer,
  type PluginMcpRegistration,
} from "@getpaseo/plugin/server";

type PluginMcpFailure =
  | { code: "MCP_ALREADY_REGISTERED" | "MCP_INVALID_DEFINITION" | "MCP_REGISTRATION_REMOVED" }
  | { code: "MCP_NAME_CONFLICT"; serviceName: string }
  | { code: "MCP_CWD_UNSUPPORTED"; serviceName: string; provider: string };
export class PluginMcpError extends Error {
  readonly failure: PluginMcpFailure;
  constructor(failure: PluginMcpFailure) {
    let message: string = failure.code;
    if (failure.code === "MCP_NAME_CONFLICT")
      message = `Plugin MCP service conflicts with configured server: ${failure.serviceName}`;
    else if (failure.code === "MCP_CWD_UNSUPPORTED")
      message = `Provider '${failure.provider}' cannot express a plugin MCP working directory: ${failure.serviceName}`;
    super(message);
    this.name = "PluginMcpError";
    this.failure = failure;
  }
}
interface PluginMcpServiceOptions {
  directory: string;
  changed(server: PluginMcpServer | null): void;
}

/** The worker owns its definition; providers own their MCP connections. */
export class PluginMcpService {
  private current: PluginMcpServer | null = null;
  private readonly options: PluginMcpServiceOptions;
  constructor(options: PluginMcpServiceOptions) {
    this.options = options;
  }

  definition(): PluginMcpServer | null {
    return this.current;
  }

  register(input: PluginMcpServer): PluginMcpRegistration {
    if (this.current) throw new PluginMcpError({ code: "MCP_ALREADY_REGISTERED" });
    const definition = PluginMcpServerSchema.safeParse(input);
    if (!definition.success) throw new PluginMcpError({ code: "MCP_INVALID_DEFINITION" });
    let owned: PluginMcpServer | null = this.replace(definition.data);
    return {
      update: (config) => {
        if (!owned || this.current !== owned)
          throw new PluginMcpError({ code: "MCP_REGISTRATION_REMOVED" });
        const parsed = PluginMcpServerSchema.safeParse({ ...owned, config });
        if (!parsed.success) throw new PluginMcpError({ code: "MCP_INVALID_DEFINITION" });
        owned = this.replace(parsed.data);
      },
      remove: () => {
        if (!owned || this.current !== owned) return;
        this.close();
        owned = null;
      },
    };
  }

  private replace(definition: PluginMcpServer): PluginMcpServer {
    const config = definition.config;
    const normalized =
      config?.type === "stdio"
        ? {
            ...config,
            ...(config.command.includes("/") || config.command.includes("\\")
              ? { command: path.resolve(this.options.directory, config.command) }
              : {}),
            ...(config.cwd ? { cwd: path.resolve(this.options.directory, config.cwd) } : {}),
          }
        : config;
    const current = { ...definition, config: normalized };
    this.current = current;
    this.options.changed(current);
    return current;
  }

  close(): void {
    this.current = null;
    this.options.changed(null);
  }
}
