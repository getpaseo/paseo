import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import Ajv, { type ErrorObject, type Options as AjvOptions } from "ajv";
import type { AgentProvider, AgentSessionConfig } from "./agent-sdk-types.js";
import type { AgentManager } from "./agent-manager.js";
import { getAgentProviderDefinition } from "./provider-manifest.js";

export type JsonSchema = Record<string, unknown>;

export type AgentCaller = (prompt: string) => Promise<string>;

export class StructuredAgentResponseError extends Error {
  readonly lastResponse: string;
  readonly validationErrors: string[];

  constructor(message: string, options: { lastResponse: string; validationErrors: string[] }) {
    super(message);
    this.name = "StructuredAgentResponseError";
    this.lastResponse = options.lastResponse;
    this.validationErrors = options.validationErrors;
  }
}

export type StructuredGenerationProvider = {
  provider: AgentProvider;
  model?: string;
  thinkingOptionId?: string;
};

export type StructuredGenerationAttempt = {
  provider: AgentProvider;
  model: string | null;
  available: boolean;
  error: string | null;
};

export class StructuredAgentFallbackError extends Error {
  readonly attempts: StructuredGenerationAttempt[];

  constructor(attempts: StructuredGenerationAttempt[]) {
    const summary = attempts
      .map((attempt) => {
        const modelSuffix = attempt.model ? ` (${attempt.model})` : "";
        if (!attempt.available) {
          return `${attempt.provider}${modelSuffix}: unavailable${attempt.error ? ` (${attempt.error})` : ""}`;
        }
        return `${attempt.provider}${modelSuffix}: failed${attempt.error ? ` (${attempt.error})` : ""}`;
      })
      .join("; ");

    super(
      summary.length > 0
        ? `Structured generation failed for all providers: ${summary}`
        : "Structured generation failed for all providers"
    );
    this.name = "StructuredAgentFallbackError";
    this.attempts = attempts;
  }
}

export interface StructuredAgentResponseOptions<T> {
  caller: AgentCaller;
  prompt: string;
  schema: z.ZodType<T> | JsonSchema;
  maxRetries?: number;
  schemaName?: string;
}

export interface StructuredAgentGenerationOptions<T> {
  manager: AgentManager;
  agentConfig: AgentSessionConfig;
  agentId?: string;
  prompt: string;
  schema: z.ZodType<T> | JsonSchema;
  maxRetries?: number;
  schemaName?: string;
}

export interface StructuredAgentGenerationWithFallbackOptions<T> {
  manager: AgentManager;
  cwd: string;
  prompt: string;
  schema: z.ZodType<T> | JsonSchema;
  providers: readonly StructuredGenerationProvider[];
  agentConfigOverrides?: Omit<
    AgentSessionConfig,
    "provider" | "cwd" | "model" | "thinkingOptionId"
  >;
  maxRetries?: number;
  schemaName?: string;
  runner?: <TResult>(options: StructuredAgentGenerationOptions<TResult>) => Promise<TResult>;
}

export const DEFAULT_STRUCTURED_GENERATION_PROVIDERS: readonly StructuredGenerationProvider[] = [
  { provider: "claude", model: "haiku" },
  { provider: "codex", model: "gpt-5.1-codex-mini", thinkingOptionId: "low" },
  { provider: "opencode", model: "opencode/kimi-k2.5-free" },
] as const;

interface SchemaValidator<T> {
  jsonSchema: JsonSchema;
  validate: (value: unknown) => { ok: true; value: T } | { ok: false; errors: string[] };
}

function isZodSchema(value: unknown): value is z.ZodTypeAny {
  return typeof (value as z.ZodTypeAny | undefined)?.safeParse === "function";
}

function buildZodValidator<T>(schema: z.ZodTypeAny, schemaName: string): SchemaValidator<T> {
  const zodToJsonSchemaAny = zodToJsonSchema as unknown as (
    input: z.ZodTypeAny,
    name?: string
  ) => JsonSchema;
  const jsonSchema = zodToJsonSchemaAny(schema, schemaName);
  return {
    jsonSchema,
    validate: (value) => {
      const result = schema.safeParse(value);
      if (result.success) {
        return { ok: true, value: result.data as T };
      }
      const errors = result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        return `${path}: ${issue.message}`;
      });
      return { ok: false, errors };
    },
  };
}

function buildJsonSchemaValidator<T>(schema: JsonSchema): SchemaValidator<T> {
  const AjvConstructor = Ajv as unknown as {
    new (options?: AjvOptions): {
      compile: (input: JsonSchema) => ((value: unknown) => boolean) & {
        errors?: ErrorObject[] | null;
      };
    };
  };
  const ajv = new AjvConstructor({ allErrors: true, strict: false });
  const validate = ajv.compile(schema);
  return {
    jsonSchema: schema,
    validate: (value) => {
      const ok = validate(value);
      if (ok) {
        return { ok: true, value: value as T };
      }
      const errors = (validate.errors ?? []).map((error: ErrorObject) => {
        const path = error.instancePath && error.instancePath.length > 0 ? error.instancePath : "(root)";
        const message = error.message ?? "is invalid";
        return `${path}: ${message}`;
      });
      return { ok: false, errors };
    },
  };
}

function buildValidator<T>(schema: z.ZodType<T> | JsonSchema, schemaName: string): SchemaValidator<T> {
  if (isZodSchema(schema)) {
    return buildZodValidator(schema, schemaName);
  }
  return buildJsonSchemaValidator(schema);
}

function buildBasePrompt(prompt: string, jsonSchema: JsonSchema): string {
  const schemaText = JSON.stringify(jsonSchema, null, 2);
  return [
    prompt.trim(),
    "",
    "You must respond with JSON only that matches this JSON Schema:",
    schemaText,
  ].join("\n");
}

function buildRetryPrompt(basePrompt: string, errors: string[]): string {
  const formattedErrors = errors.map((error) => `- ${error}`).join("\n");
  return [
    basePrompt,
    "",
    "Previous response was invalid with validation errors:",
    formattedErrors.length > 0 ? formattedErrors : "- Unknown validation error",
    "",
    "Respond again with JSON only that matches the schema.",
  ].join("\n");
}

function extractJsonFromMarkdown(text: string): string {
  const fencedMatch = text.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fencedMatch) {
    return fencedMatch[1].trim();
  }

  const extracted = extractFirstJsonSnippet(text);
  if (extracted) {
    return extracted;
  }

  return text.trim();
}

function extractFirstJsonSnippet(text: string): string | null {
  const source = text.trim();
  if (!source) {
    return null;
  }

  // Try to find the first valid JSON object/array within a larger response.
  // This is intentionally provider-agnostic and improves resilience when models
  // add extra prose before/after the JSON.
  const startIndexes: number[] = [];
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{" || ch === "[") {
      startIndexes.push(i);
    }
  }

  for (const start of startIndexes) {
    const open = source[start]!;
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < source.length; i += 1) {
      const ch = source[i]!;

      if (inString) {
        if (escaped) {
          escaped = false;
          continue;
        }
        if (ch === "\\") {
          escaped = true;
          continue;
        }
        if (ch === "\"") {
          inString = false;
        }
        continue;
      }

      if (ch === "\"") {
        inString = true;
        continue;
      }

      if (ch === open) {
        depth += 1;
        continue;
      }
      if (ch === close) {
        depth -= 1;
        if (depth === 0) {
          const candidate = source.slice(start, i + 1).trim();
          try {
            JSON.parse(candidate);
            return candidate;
          } catch {
            // keep scanning; the snippet might not be JSON (e.g. braces in prose)
          }
        }
      }
    }
  }

  return null;
}

export async function getStructuredAgentResponse<T>(
  options: StructuredAgentResponseOptions<T>
): Promise<T> {
  const { caller, prompt, schema, maxRetries = 2, schemaName = "Response" } = options;
  const validator = buildValidator(schema, schemaName);
  const basePrompt = buildBasePrompt(prompt, validator.jsonSchema);

  let attemptPrompt = basePrompt;
  let lastResponse = "";
  let lastErrors: string[] = [];

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const response = await caller(attemptPrompt);
    lastResponse = response;
    const jsonText = extractJsonFromMarkdown(response);

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastErrors = [`Invalid JSON: ${message}`];
      if (attempt === maxRetries) {
        break;
      }
      attemptPrompt = buildRetryPrompt(basePrompt, lastErrors);
      continue;
    }

    const validation = validator.validate(parsed);
    if (validation.ok) {
      return validation.value;
    }

    lastErrors = validation.errors;
    if (attempt === maxRetries) {
      break;
    }
    attemptPrompt = buildRetryPrompt(basePrompt, lastErrors);
  }

  throw new StructuredAgentResponseError(
    "Agent response did not match the required JSON schema",
    {
      lastResponse,
      validationErrors: lastErrors,
    }
  );
}

export async function generateStructuredAgentResponse<T>(
  options: StructuredAgentGenerationOptions<T>
): Promise<T> {
  const { manager, agentConfig, agentId, prompt, schema, maxRetries, schemaName } = options;
  const modeId =
    agentConfig.modeId ?? getAgentProviderDefinition(agentConfig.provider).defaultModeId ?? undefined;
  const agent = await manager.createAgent({ ...agentConfig, modeId }, agentId);
  try {
    const caller: AgentCaller = async (nextPrompt) => {
      const result = await manager.runAgent(agent.id, nextPrompt);
      if (typeof result.finalText === "string" && result.finalText.length > 0) {
        return result.finalText;
      }
      // Fallback for providers that may not populate finalText consistently.
      const lastAssistant = result.timeline
        .filter((item) => item.type === "assistant_message")
        .at(-1);
      return lastAssistant?.text ?? "";
    };
    return await getStructuredAgentResponse({
      caller,
      prompt,
      schema,
      maxRetries,
      schemaName,
    });
  } finally {
    try {
      await manager.closeAgent(agent.id);
    } catch {
      // ignore cleanup errors
    }
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function generateStructuredAgentResponseWithFallback<T>(
  options: StructuredAgentGenerationWithFallbackOptions<T>
): Promise<T> {
  const {
    manager,
    cwd,
    prompt,
    schema,
    providers,
    agentConfigOverrides,
    maxRetries,
    schemaName,
    runner,
  } = options;

  if (providers.length === 0) {
    throw new StructuredAgentFallbackError([]);
  }

  const runStructured =
    runner ??
    ((input: StructuredAgentGenerationOptions<T>) =>
      generateStructuredAgentResponse<T>(input));
  const availability = await manager.listProviderAvailability();
  const availabilityByProvider = new Map(
    availability.map((entry) => [entry.provider, entry])
  );
  const attempts: StructuredGenerationAttempt[] = [];

  for (const candidate of providers) {
    const availabilityEntry = availabilityByProvider.get(candidate.provider);
    if (availabilityEntry && !availabilityEntry.available) {
      attempts.push({
        provider: candidate.provider,
        model: candidate.model ?? null,
        available: false,
        error: availabilityEntry.error ?? null,
      });
      continue;
    }

    try {
      const result = await runStructured({
        manager,
        prompt,
        schema,
        maxRetries,
        schemaName,
        agentConfig: {
          ...agentConfigOverrides,
          provider: candidate.provider,
          cwd,
          ...(candidate.model ? { model: candidate.model } : {}),
          ...(candidate.thinkingOptionId
            ? { thinkingOptionId: candidate.thinkingOptionId }
            : {}),
        },
      });
      return result;
    } catch (error) {
      attempts.push({
        provider: candidate.provider,
        model: candidate.model ?? null,
        available: true,
        error: errorMessage(error),
      });
    }
  }

  throw new StructuredAgentFallbackError(attempts);
}
