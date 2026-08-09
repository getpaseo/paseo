import { z } from "zod";
import type { HubDeployPartial } from "./deploy-input.js";
import { HubDeployError } from "./error.js";

const installResponseSchema = z
  .object({
    projectSlug: z.string().min(1),
    version: z.number().int().positive(),
    versionId: z.string().uuid(),
    active: z.boolean(),
  })
  .strict();

const issuePathSchema = z.union([z.string(), z.array(z.union([z.string(), z.number()]))]);
const fieldIssueSchema = z.object({
  field: z.string().optional(),
  path: issuePathSchema.optional(),
  message: z.string(),
});
const problemSchema = z.object({
  type: z.string().optional(),
  title: z.string().optional(),
  status: z.number().int().optional(),
  detail: z.string().optional(),
  instance: z.string().optional(),
  errors: z
    .union([z.array(fieldIssueSchema), z.record(z.string(), z.array(z.string()))])
    .optional(),
  issues: z.array(fieldIssueSchema).optional(),
});

export type HubInstallResult = z.infer<typeof installResponseSchema>;

interface InstallHubConfigurationInput {
  origin: string;
  apiKey: string;
  projectSlug: string;
  yaml: string;
  partials?: readonly HubDeployPartial[];
}

export async function installHubConfiguration(
  input: InstallHubConfigurationInput,
): Promise<HubInstallResult> {
  let response: Response;
  try {
    response = await fetch(`${input.origin}/api/v1/configurations/install`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectSlug: input.projectSlug,
        yaml: input.yaml,
        ...(input.partials === undefined || input.partials.length === 0
          ? {}
          : { partials: input.partials }),
      }),
    });
  } catch {
    throw new HubDeployError(
      "HUB_NETWORK_ERROR",
      `Could not reach Paseo Hub at ${input.origin}. Check the Hub URL and network connection.`,
    );
  }

  if (response.status !== 201) {
    throw await deploymentFailure(response, input.apiKey);
  }

  try {
    return installResponseSchema.parse(await response.json());
  } catch {
    throw new HubDeployError(
      "HUB_INVALID_RESPONSE",
      "Hub returned a malformed deployment response.",
    );
  }
}

async function deploymentFailure(response: Response, apiKey: string): Promise<HubDeployError> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/problem+json")) {
    return new HubDeployError(
      "HUB_REQUEST_FAILED",
      `Hub deployment failed with HTTP ${response.status}.`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new HubDeployError(
      "HUB_INVALID_RESPONSE",
      `Hub returned malformed problem details for HTTP ${response.status}.`,
    );
  }
  const parsed = problemSchema.safeParse(body);
  if (
    !parsed.success ||
    (parsed.data.status !== undefined && parsed.data.status !== response.status)
  ) {
    return new HubDeployError(
      "HUB_INVALID_RESPONSE",
      `Hub returned nonconforming problem details for HTTP ${response.status}.`,
    );
  }

  const title = parsed.data.title ?? `Hub deployment failed with HTTP ${response.status}`;
  const detail = parsed.data.detail;
  const message = detail === undefined ? title : `${title}: ${detail}`;
  const details = formatFieldIssues(parsed.data.errors, parsed.data.issues);
  const code = response.status === 422 ? "HUB_VALIDATION_FAILED" : "HUB_REQUEST_FAILED";
  return new HubDeployError(
    code,
    redactSecret(message, apiKey),
    details === undefined ? undefined : redactSecret(details, apiKey),
  );
}

function formatFieldIssues(
  errors: z.infer<typeof problemSchema>["errors"],
  issues: z.infer<typeof problemSchema>["issues"],
): string | undefined {
  const fieldIssues = Array.isArray(errors) ? errors : issues;
  if (fieldIssues !== undefined) {
    const lines = fieldIssues.map((issue) => {
      const field = issue.field ?? formatIssuePath(issue.path);
      return field === undefined ? issue.message : `${field}: ${issue.message}`;
    });
    return lines.length === 0 ? undefined : lines.join("\n");
  }
  if (errors === undefined) return undefined;

  const lines = Object.entries(errors).flatMap(([field, messages]) =>
    messages.map((message: string) => `${field}: ${message}`),
  );
  return lines.length === 0 ? undefined : lines.join("\n");
}

function formatIssuePath(path: z.infer<typeof issuePathSchema> | undefined): string | undefined {
  if (path === undefined || typeof path === "string") return path;
  let formatted = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
    } else {
      formatted += formatted.length === 0 ? segment : `.${segment}`;
    }
  }
  return formatted || undefined;
}

function redactSecret(value: string, secret: string): string {
  return value.split(secret).join("[redacted]");
}
