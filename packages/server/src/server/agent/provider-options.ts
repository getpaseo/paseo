import type { ProviderOptions } from "@getpaseo/protocol/agent-types";
import { isDeepStrictEqual } from "node:util";
import type { z } from "zod";

export interface ProviderOptionIssue {
  path: Array<string | number>;
  message: string;
}

export class ProviderOptionsValidationError extends Error {
  readonly code = "provider_options_invalid" as const;

  constructor(
    readonly provider: string,
    readonly issues: ProviderOptionIssue[],
  ) {
    const details = issues
      .map((issue) => `${formatProviderOptionPath(issue.path)}: ${issue.message}`)
      .join("; ");
    super(`Invalid providerOptions for '${provider}': ${details}`);
    this.name = "ProviderOptionsValidationError";
  }
}

export class ToolPolicyUnsupportedError extends Error {
  readonly code = "tool_policy_unsupported" as const;

  constructor(
    readonly provider: string,
    reason?: string,
  ) {
    super(
      reason ??
        `Provider '${provider}' cannot preapprove exact MCP tools for unattended execution; select Claude, Codex, or OpenCode`,
    );
    this.name = "ToolPolicyUnsupportedError";
  }
}

export function validateProviderOptions<T extends ProviderOptions>(
  provider: string,
  schema: z.ZodType<T>,
  options: ProviderOptions | undefined,
): T | undefined {
  if (options === undefined) return undefined;
  const parsed = schema.safeParse(options);
  if (parsed.success) return parsed.data;
  throw new ProviderOptionsValidationError(provider, flattenZodIssues(parsed.error.issues));
}

function flattenZodIssues(
  issues: z.core.$ZodIssue[],
  prefix: PropertyKey[] = [],
): ProviderOptionIssue[] {
  return issues.flatMap((issue) => {
    const path = [...prefix, ...issue.path];
    if (issue.code === "invalid_union") {
      return flattenZodIssues(issue.errors.flat(), path);
    }
    return [
      {
        path: path.map((segment) =>
          typeof segment === "symbol" ? (segment.description ?? String(segment)) : segment,
        ),
        message: issue.message,
      },
    ];
  });
}

function formatProviderOptionPath(path: Array<string | number>): string {
  return path.reduce<string>((formatted, segment) => {
    if (typeof segment === "number") return `${formatted}[${segment}]`;
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(segment)
      ? `${formatted}.${segment}`
      : `${formatted}[${JSON.stringify(segment)}]`;
  }, "providerOptions");
}

/** Plain objects merge recursively; all other values replace the base value. */
export function mergeProviderOptions(
  base: ProviderOptions | undefined,
  override: ProviderOptions | undefined,
): ProviderOptions | undefined {
  if (base === undefined && override === undefined) return undefined;
  const merged: ProviderOptions = { ...base };
  for (const [key, value] of Object.entries(override ?? {})) {
    const previous = merged[key];
    Object.defineProperty(merged, key, {
      value:
        isPlainObject(previous) && isPlainObject(value)
          ? mergeProviderOptions(previous, value)
          : value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return merged;
}

function isPlainObject(value: unknown): value is ProviderOptions {
  if (value === null || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Rejects a live patch that changes a key the running session cannot apply (one the provider
 * reads only when it opens). A key whose value already matches the session's is not a change.
 */
export function assertChangesAreLive(input: {
  provider: string;
  patch: ProviderOptions;
  current: ProviderOptions | undefined;
  live: readonly string[];
}): void {
  const issues = Object.entries(input.patch)
    .filter(
      ([key, value]) =>
        !input.live.includes(key) &&
        !isDeepStrictEqual(input.current?.[key] ?? null, value ?? null),
    )
    .map(([key]) => ({
      path: [key],
      message: "cannot change on a running session; it applies when the agent is opened",
    }));
  if (issues.length > 0) throw new ProviderOptionsValidationError(input.provider, issues);
}
