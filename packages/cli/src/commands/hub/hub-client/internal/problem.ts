import { z } from "zod";
import { HubCommandError } from "../../error.js";

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

export async function hubRequestFailure(
  response: Response,
  failureMessage: string,
  apiKey: string | undefined,
): Promise<HubCommandError> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/problem+json")) {
    return new HubCommandError(
      "HUB_REQUEST_FAILED",
      `${failureMessage} with HTTP ${response.status}.`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new HubCommandError(
      "HUB_INVALID_RESPONSE",
      `Hub returned malformed problem details for HTTP ${response.status}.`,
    );
  }
  const parsed = problemSchema.safeParse(body);
  if (
    !parsed.success ||
    (parsed.data.status !== undefined && parsed.data.status !== response.status)
  ) {
    return new HubCommandError(
      "HUB_INVALID_RESPONSE",
      `Hub returned nonconforming problem details for HTTP ${response.status}.`,
    );
  }
  const title = parsed.data.title ?? `${failureMessage} with HTTP ${response.status}`;
  const details = formatFieldIssues(parsed.data.errors, parsed.data.issues);
  const message =
    details !== undefined || parsed.data.detail === undefined
      ? title
      : `${title}: ${parsed.data.detail}`;
  let code = "HUB_REQUEST_FAILED";
  if (response.status === 422) code = "HUB_VALIDATION_FAILED";
  if (response.status === 404) code = "HUB_NOT_FOUND";
  return new HubCommandError(
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
  const [file, ...fieldPath] = path;
  if (typeof file === "string" && file.startsWith(".paseo/") && fieldPath.length > 0) {
    return `${file}: ${formatPathSegments(fieldPath)}`;
  }
  return formatPathSegments(path) || undefined;
}

function formatPathSegments(path: readonly (string | number)[]): string {
  let formatted = "";
  for (const segment of path) {
    if (typeof segment === "number") formatted += `[${segment}]`;
    else formatted += formatted.length === 0 ? segment : `.${segment}`;
  }
  return formatted;
}

function redactSecret(value: string, secret: string | undefined): string {
  return secret === undefined ? value : value.split(secret).join("[redacted]");
}
