import { z } from "zod";
import { ManagedMcpServiceSchema, type ManagedMcpService } from "@getpaseo/protocol/messages";

export interface HeaderRow {
  id: number;
  key: string;
  value: string;
}

interface FormFields {
  name: string;
  alwaysLoad?: boolean;
  type: "stdio" | "http" | "sse";
  command: string;
  args: string;
  env: string;
  url: string;
  headers: HeaderRow[] | undefined;
  mode: "form" | "json";
  json: string;
}

// Reject unknown JSON keys rather than silently discarding pasted configuration.
const configSchema = z.union([
  ManagedMcpServiceSchema.shape.config.options[0].strict(),
  ManagedMcpServiceSchema.shape.config.options[1].strict(),
  ManagedMcpServiceSchema.shape.config.options[2].strict(),
]);
// Mode switching validates representability; saving still requires a complete connection.
const draftConfigSchema = z.union([
  ManagedMcpServiceSchema.shape.config.options[0].extend({ command: z.string() }).strict(),
  ManagedMcpServiceSchema.shape.config.options[1].extend({ url: z.string() }).strict(),
  ManagedMcpServiceSchema.shape.config.options[2].extend({ url: z.string() }).strict(),
]);
function parseOptional(value: string): unknown {
  return value.trim() ? JSON.parse(value) : undefined;
}

export function openMcpServiceForm(service?: ManagedMcpService) {
  let nextHeaderId = 0;
  function connectionFields(config?: ManagedMcpService["config"]) {
    return {
      type: config?.type ?? "stdio",
      alwaysLoad: config?.alwaysLoad,
      command: config?.type === "stdio" ? config.command : "",
      args: config?.type === "stdio" ? (JSON.stringify(config.args) ?? "") : "",
      env: config?.type === "stdio" ? (JSON.stringify(config.env) ?? "") : "",
      url: config && config.type !== "stdio" ? config.url : "",
      headers:
        config && config.type !== "stdio" && config.headers !== undefined
          ? Object.entries(config.headers).map(([key, value]) => ({
              id: nextHeaderId++,
              key,
              value,
            }))
          : undefined,
    };
  }

  let fields: FormFields = {
    name: service?.name ?? "",
    ...connectionFields(service?.config),
    mode: "form",
    json: "",
  };
  const listeners = new Set<() => void>();
  function readHeaders() {
    if (!fields.headers) return undefined;
    const names = new Set<string>();
    const entries = fields.headers
      .filter((row) => row.key || row.value)
      .map(({ key, value }) => {
        if (!key.trim() || names.has(key.toLowerCase()))
          throw new SyntaxError("Invalid header names");
        names.add(key.toLowerCase());
        return [key, value];
      });
    return Object.fromEntries(entries);
  }
  function connection() {
    if (fields.mode === "json") return JSON.parse(fields.json);
    if (fields.type === "stdio") {
      return {
        type: "stdio",
        ...(fields.alwaysLoad === undefined ? {} : { alwaysLoad: fields.alwaysLoad }),
        command: fields.command.trim(),
        args: parseOptional(fields.args),
        env: parseOptional(fields.env),
      };
    }
    return {
      type: fields.type,
      url: fields.url.trim(),
      headers: readHeaders(),
      ...(fields.alwaysLoad === undefined ? {} : { alwaysLoad: fields.alwaysLoad }),
    };
  }
  function submission(): ManagedMcpService | null {
    try {
      return ManagedMcpServiceSchema.parse({
        name: fields.name.trim(),
        enabled: service?.enabled ?? true,
        config: configSchema.parse(connection()),
      });
    } catch (error) {
      if (error instanceof SyntaxError || error instanceof z.ZodError) return null;
      throw error;
    }
  }
  function invalidHeaders() {
    if (fields.mode !== "form" || fields.type === "stdio") return false;
    try {
      readHeaders();
      return false;
    } catch (error) {
      if (error instanceof SyntaxError) return true;
      throw error;
    }
  }
  let state = {
    ...fields,
    canSubmit: submission() !== null,
    modeError: false,
    headerError: invalidHeaders(),
  };
  function publish(modeError = false) {
    state = {
      ...fields,
      canSubmit: submission() !== null,
      modeError,
      headerError: invalidHeaders(),
    };
    for (const listener of listeners) listener();
  }
  return {
    setMode(mode: "form" | "json") {
      if (mode === fields.mode) return;
      try {
        const config = connection();
        fields =
          mode === "json"
            ? { ...fields, mode, json: JSON.stringify(config, null, 2) }
            : { ...fields, mode, ...connectionFields(draftConfigSchema.parse(config)) };
        publish();
      } catch (error) {
        if (!(error instanceof SyntaxError || error instanceof z.ZodError)) throw error;
        publish(true);
      }
    },
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    close() {
      listeners.clear();
    },
    setField<K extends keyof FormFields>(field: K, value: FormFields[K]) {
      if (field === "type" && value !== fields.type) {
        fields =
          value === "stdio"
            ? { ...fields, url: "", headers: undefined }
            : { ...fields, command: "", args: "", env: "" };
      }
      fields = { ...fields, [field]: value };
      publish();
    },
    addHeader() {
      fields = {
        ...fields,
        headers: [...(fields.headers ?? []), { id: nextHeaderId++, key: "", value: "" }],
      };
      publish();
    },
    updateHeader(id: number, field: "key" | "value", value: string) {
      fields = {
        ...fields,
        headers: fields.headers?.map((row) => (row.id === id ? { ...row, [field]: value } : row)),
      };
      publish();
    },
    removeHeader(id: number) {
      fields = { ...fields, headers: fields.headers?.filter((row) => row.id !== id) };
      publish();
    },
    getSubmission: submission,
  };
}
