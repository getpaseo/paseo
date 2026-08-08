import type { ProviderOptions } from "@getpaseo/protocol/agent-types";
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

  constructor(readonly provider: string) {
    super(
      `Provider '${provider}' cannot preapprove exact MCP tools for unattended execution; select Claude, Codex, or OpenCode`,
    );
    this.name = "ToolPolicyUnsupportedError";
  }
}

export function validateProviderOptions(
  provider: string,
  schema: z.ZodType<ProviderOptions>,
  options: ProviderOptions | undefined,
): ProviderOptions | undefined {
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
